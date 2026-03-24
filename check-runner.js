import http from "node:http";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import { pullSnapshot } from "./pullSnapshot.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 4000);
const AUTH_SECRET = process.env.CHECK_RUNNER_SECRET || "";
const JOB_TTL_MS = Number(process.env.CHECK_RUNNER_JOB_TTL_MS || 3_600_000);
const CLEANUP_INTERVAL_MS = Number(
  process.env.CHECK_RUNNER_JOB_CLEANUP_INTERVAL_MS || 60_000,
);
const MAX_JOBS = Number(process.env.CHECK_RUNNER_MAX_JOBS || 500);
const DEFAULT_TIMEOUT_MS = Number(
  process.env.CHECK_RUNNER_COMMAND_TIMEOUT_MS || 600_000,
);
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — no diffs/edits, just commands
const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB per stdout/stderr

// Env vars that commands are allowed to see.
// Cloud credentials and auth secret never reach subprocesses.
const COMMAND_ENV = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "LANG",
    "TERM",
    "TMPDIR",
    "NODE_VERSION",
    "HOSTNAME",
    "npm_config_cache",
    "PNPM_HOME",
    "COREPACK_HOME",
  ]
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------
const E = {
  UNAUTHORIZED: "UNAUTHORIZED",
  BAD_REQUEST: "BAD_REQUEST",
  BAD_JSON: "BAD_JSON",
  PULL_FAILED: "PULL_FAILED",
  COMMAND_FAILED: "COMMAND_FAILED",
  COMMAND_TIMEOUT: "COMMAND_TIMEOUT",
  INTERNAL: "INTERNAL",
};

// ---------------------------------------------------------------------------
// Job store
// ---------------------------------------------------------------------------
/** @type {Map<string, Record<string, unknown>>} */
const jobs = new Map();
/** @type {string[]} */
const queue = [];
let workerBusy = false;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** @param {http.IncomingMessage} req */
function isAuthorized(req) {
  if (!AUTH_SECRET) return true;
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token && token === AUTH_SECRET) return true;
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && key === AUTH_SECRET) return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function parseJson(raw) {
  if (!raw || raw.trim() === "") return {};
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("Body must be a JSON object");
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   snapshotId?: string;
 *   workDir?: string;
 *   commands: string[];
 *   commandTimeoutMs: number;
 * }} JobInput
 */

/** @returns {{ ok: true; input: JobInput } | { ok: false; reason: string }} */
function validateAndNormalize(raw) {
  if ("commands" in raw && !Array.isArray(raw.commands)) {
    return { ok: false, reason: "commands must be an array" };
  }
  if (
    "commandTimeoutMs" in raw &&
    (typeof raw.commandTimeoutMs !== "number" ||
      !Number.isFinite(raw.commandTimeoutMs) ||
      raw.commandTimeoutMs <= 0)
  ) {
    return { ok: false, reason: "commandTimeoutMs must be a positive number" };
  }

  const str = (v) =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

  const snapshotId = str(raw.snapshotId);
  const workDir = str(raw.workDir);

  const commands = Array.isArray(raw.commands)
    ? raw.commands.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim())
    : [];

  const commandTimeoutMs =
    typeof raw.commandTimeoutMs === "number" &&
    Number.isFinite(raw.commandTimeoutMs) &&
    raw.commandTimeoutMs > 0
      ? Math.floor(raw.commandTimeoutMs)
      : DEFAULT_TIMEOUT_MS;

  if (!snapshotId && !workDir) {
    return { ok: false, reason: "Either snapshotId or workDir is required" };
  }
  if (commands.length === 0) {
    return { ok: false, reason: "commands must be a non-empty array" };
  }

  return { ok: true, input: { snapshotId, workDir, commands, commandTimeoutMs } };
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function truncate(str, limit = MAX_OUTPUT_BYTES) {
  if (typeof str !== "string") return "";
  if (Buffer.byteLength(str) <= limit) return str;
  const buf = Buffer.from(str);
  return buf.subarray(0, limit).toString("utf8") + "\n…[truncated]";
}

/** Run commands sequentially. Stops on first failure. */
async function runCommands(workDir, commands, timeoutMs) {
  const results = [];
  for (const command of commands) {
    const start = Date.now();
    const result = await new Promise((resolve) => {
      exec(
        command,
        {
          cwd: workDir,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 10 * 1024 * 1024,
          env: { ...COMMAND_ENV, NODE_ENV: "test", CI: "true" },
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const timedOut = !!(error && error.killed);
          resolve({
            command,
            success: !error,
            exitCode: error && typeof error.code === "number" ? error.code : 0,
            durationMs,
            stdout: truncate(stdout),
            stderr: truncate(stderr),
            timedOut,
          });
        },
      );
    });

    results.push(result);
    if (!result.success) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

function stamp(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function toResponse(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    workDir: job.workDir ?? null,
    snapshotId: job.snapshotId ?? null,
    commandResults: job.commandResults ?? [],
    error: job.error ?? null,
  };
}

async function executeJob(job) {
  const { snapshotId, commands, commandTimeoutMs } =
    /** @type {JobInput} */ (job.input);
  let workDir = /** @type {string} */ (job.input.workDir) || "";
  let pulledWorkDir = false;

  try {
    // --- pull snapshot ---
    stamp(job, { status: "running", stage: "pull" });
    console.log(`[JOB ${job.jobId}] starting | snapshot: ${snapshotId || "none"} | commands: ${commands.length}`);
    if (snapshotId) {
      try {
        console.log(`[JOB ${job.jobId}] pulling snapshot...`);
        workDir = await pullSnapshot(snapshotId);
        console.log(`[JOB ${job.jobId}] pull complete → ${workDir}`);
        pulledWorkDir = true;
      } catch (err) {
        stamp(job, {
          status: "failed",
          stage: "pull",
          error: { code: E.PULL_FAILED, message: errMsg(err) },
        });
        return;
      }
    }
    stamp(job, { workDir, snapshotId });

    // --- run commands ---
    stamp(job, { stage: "command" });
    console.log(`[JOB ${job.jobId}] running ${commands.length} command(s) in ${workDir}`);
    const results = await runCommands(workDir, commands, commandTimeoutMs);
    stamp(job, { commandResults: results });

    const failed = results.find((r) => !r.success);
    if (failed) {
      const code = failed.timedOut ? E.COMMAND_TIMEOUT : E.COMMAND_FAILED;
      const message = failed.timedOut
        ? `Timed out after ${commandTimeoutMs}ms: ${failed.command}`
        : `Command failed: ${failed.command}`;
      stamp(job, { status: "failed", stage: "command", error: { code, message } });
      return;
    }

    console.log(`[JOB ${job.jobId}] completed`);
    stamp(job, { status: "completed", stage: "done" });
  } catch (err) {
    stamp(job, {
      status: "failed",
      stage: "internal",
      error: { code: E.INTERNAL, message: errMsg(err) },
    });
  } finally {
    // Clean up pulled snapshot directory.
    if (pulledWorkDir && workDir) {
      try { await fs.rm(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function errMsg(err) {
  return err instanceof Error ? err.message : "Unknown error";
}

// ---------------------------------------------------------------------------
// Queue worker
// ---------------------------------------------------------------------------

async function drainQueue() {
  if (workerBusy) return;
  workerBusy = true;
  while (queue.length > 0) {
    const id = queue.shift();
    const job = id && jobs.get(id);
    if (job) await executeJob(job);
  }
  workerBusy = false;
}

// ---------------------------------------------------------------------------
// Job cleanup (in-memory records)
// ---------------------------------------------------------------------------

function cleanup() {
  const now = Date.now();
  const stale = [];

  for (const [id, job] of jobs) {
    if (job.status !== "completed" && job.status !== "failed") continue;
    const t = Date.parse(String(job.updatedAt || job.createdAt));
    if (!Number.isNaN(t) && now - t > JOB_TTL_MS) {
      jobs.delete(id);
    } else {
      stale.push([id, t]);
    }
  }

  if (jobs.size > MAX_JOBS) {
    stale.sort((a, b) => a[1] - b[1]);
    while (jobs.size > MAX_JOBS && stale.length > 0) {
      jobs.delete(stale.shift()[0]);
    }
  }
}

const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const JOB_ID_RE = /^\/run-checks\/([^/]+)$/;

const server = http.createServer(async (req, res) => {
  if (!isAuthorized(req)) {
    return json(res, 401, { code: E.UNAUTHORIZED, error: "Invalid or missing credentials" });
  }

  // --- poll job ---
  if (req.method === "GET") {
    const m = req.url && JOB_ID_RE.exec(req.url);
    if (!m) {
      console.log(`[GET] 404 — no match for url: ${req.url}`);
      res.writeHead(404); return res.end("Not found");
    }
    const jobId = decodeURIComponent(m[1]);
    const job = jobs.get(jobId);
    if (!job) {
      console.log(`[GET] 404 — job not found: ${jobId} | total jobs in store: ${jobs.size} | ids: [${[...jobs.keys()].join(", ")}]`);
      return json(res, 404, { error: "Job not found" });
    }
    console.log(`[GET] 200 — job: ${jobId} | status: ${job.status} | stage: ${job.stage}`);
    return json(res, 200, toResponse(job));
  }

  // --- submit job ---
  if (req.method !== "POST" || req.url !== "/run-checks") {
    res.writeHead(404);
    return res.end("Not found");
  }

  let body;
  try { body = await readBody(req); } catch {
    return json(res, 400, { error: "Invalid or oversized body" });
  }

  let parsed;
  try { parsed = parseJson(body); } catch (err) {
    return json(res, 400, { code: E.BAD_JSON, error: errMsg(err) });
  }

  const v = validateAndNormalize(parsed);
  if (!v.ok) return json(res, 400, { code: E.BAD_REQUEST, error: v.reason });

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    jobId,
    status: "queued",
    stage: "queued",
    createdAt: now,
    updatedAt: now,
    input: v.input,
    commandResults: [],
  };

  jobs.set(jobId, job);
  queue.push(jobId);
  console.log(`[POST] 202 — queued job: ${jobId} | commands: ${v.input.commands.length} | snapshot: ${v.input.snapshotId || "none"}`);
  void drainQueue();

  return json(res, 202, { jobId, status: "queued" });
});

server.listen(PORT, () => {
  console.log(`check-runner listening on :${PORT}`);
});
