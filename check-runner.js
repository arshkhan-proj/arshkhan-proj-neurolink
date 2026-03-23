import http from "node:http";
import { exec } from "node:child_process";
import { pullSnapshot } from "./pullSnapshot.js";
import { applyEdits } from "./editOperations.js";
import { pushSnapshot } from "./pushSnapshot.js";

const PORT = process.env.PORT || 4000;

const ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_JSON: "INVALID_JSON",
  SNAPSHOT_PULL_FAILED: "SNAPSHOT_PULL_FAILED",
  EDIT_FAILED: "EDIT_FAILED",
  COMMAND_EXECUTION_FAILED: "COMMAND_EXECUTION_FAILED",
  PUSH_FAILED: "PUSH_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

const EDIT_TYPES = new Set([
  "write_file",
  "replace_in_file",
  "delete_file",
  "apply_patch",
]);

/**
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {Record<string, unknown>} payload
 */
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * @param {string} body
 * @returns {Record<string, unknown>}
 */
function parseJsonBody(body) {
  if (!body || body.trim() === "") {
    return {};
  }
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * @param {Record<string, unknown>} parsed
 * @returns {{
 *   snapshotId?: string;
 *   workDir?: string;
 *   repoName?: string;
 *   commands: string[];
 *   edits: unknown[];
 * }}
 */
function normalizeRequest(parsed) {
  const snapshotId =
    typeof parsed.snapshotId === "string" && parsed.snapshotId.trim() !== ""
      ? parsed.snapshotId.trim()
      : undefined;

  const repoName =
    typeof parsed.repoName === "string" && parsed.repoName.trim() !== ""
      ? parsed.repoName.trim()
      : undefined;

  const workDir =
    typeof parsed.workDir === "string" && parsed.workDir.trim() !== ""
      ? parsed.workDir.trim()
      : undefined;

  const commandsInput = parsed.commands;
  const commands =
    Array.isArray(commandsInput) && commandsInput.length > 0
      ? commandsInput.filter((c) => typeof c === "string" && c.trim() !== "")
      : ["pnpm test"];

  const editsInput = parsed.edits;
  const edits = Array.isArray(editsInput) ? editsInput : [];

  return { snapshotId, workDir, repoName, commands, edits };
}

/**
 * @param {unknown[]} edits
 * @returns {{ valid: boolean; reason?: string }}
 */
function validateEdits(edits) {
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
      return { valid: false, reason: `edits[${i}] must be an object` };
    }

    const type = "type" in edit ? String(edit.type || "") : "";
    if (!EDIT_TYPES.has(type)) {
      return {
        valid: false,
        reason: `edits[${i}].type must be one of: ${[...EDIT_TYPES].join(", ")}`,
      };
    }
  }

  return { valid: true };
}

/**
 * @param {string} workDir
 * @param {string[]} commands
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function runCommands(workDir, commands) {
  const runCommand = async (command) =>
    await new Promise((resolve) => {
      const start = Date.now();
      exec(
        command,
        {
          cwd: workDir,
          env: {
            ...process.env,
            NODE_ENV: "test",
          },
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const success = !error;
          const exitCode =
            error && typeof error.code === "number" ? error.code : 0;
          resolve({
            command,
            success,
            exitCode,
            durationMs,
            stdout,
            stderr,
          });
        },
      );
    });

  const results = [];
  for (const cmd of commands) {
    // Run sequentially so commands can depend on previous steps.
    // eslint-disable-next-line no-await-in-loop
    const result = await runCommand(cmd);
    results.push(result);
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  if (
    req.method !== "POST" ||
    (req.url !== "/run-checks" && req.url !== "/run-edit-checks")
  ) {
    res.writeHead(404);
    return res.end("Not found");
  }

  const isEditRoute = req.url === "/run-edit-checks";
  let body = "";
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400);
    return res.end("Invalid body");
  }

  let parsed = {};
  try {
    parsed = parseJsonBody(body);
  } catch (err) {
    if (isEditRoute) {
      return sendJson(res, 400, {
        errorCode: ERROR_CODES.INVALID_JSON,
        error: err instanceof Error ? err.message : "Invalid JSON",
      });
    }
    res.writeHead(400);
    return res.end("Invalid JSON");
  }

  const normalized = normalizeRequest(parsed);
  const { snapshotId, repoName, commands, edits } = normalized;
  let workDir = normalized.workDir || "";

  if (!snapshotId && !workDir) {
    if (isEditRoute) {
      return sendJson(res, 400, {
        errorCode: ERROR_CODES.INVALID_REQUEST,
        error: "Either snapshotId or workDir is required",
      });
    }
    res.writeHead(400);
    return res.end("workDir is required when snapshotId is not provided");
  }
  if (commands.length === 0) {
    if (isEditRoute) {
      return sendJson(res, 400, {
        errorCode: ERROR_CODES.INVALID_REQUEST,
        error: "commands must be a non-empty array of strings",
      });
    }
    res.writeHead(400);
    return res.end("commands must be a non-empty array of strings");
  }

  if (isEditRoute) {
    const editsValidation = validateEdits(edits);
    if (!editsValidation.valid) {
      return sendJson(res, 400, {
        errorCode: ERROR_CODES.INVALID_REQUEST,
        error: editsValidation.reason || "Invalid edits array",
      });
    }
  }

  if (snapshotId) {
    try {
      workDir = await pullSnapshot(snapshotId, repoName);
    } catch (err) {
      if (isEditRoute) {
        return sendJson(res, 500, {
          errorCode: ERROR_CODES.SNAPSHOT_PULL_FAILED,
          snapshotId,
          repoName,
          error:
            err instanceof Error
              ? err.message
              : "Failed to pull snapshot from configured storage",
        });
      }
      return sendJson(res, 500, {
        snapshotId,
        repoName,
        error:
          err instanceof Error
            ? err.message
            : "Failed to pull snapshot from configured storage",
      });
    }
  }

  let editResults = [];
  try {
    if (isEditRoute && edits.length > 0) {
      const editOutput = await applyEdits(workDir, edits);
      editResults = editOutput.editResults;
      if (editOutput.failedEditId) {
        return sendJson(res, 400, {
          errorCode: ERROR_CODES.EDIT_FAILED,
          snapshotId,
          repoName,
          workDir,
          failedEditId: editOutput.failedEditId,
          editResults,
        });
      }
    }

    const results = await runCommands(workDir, commands);
    const allSuccess = results.every((r) => r.success);

    if (isEditRoute && allSuccess) {
      try {
        const pushedSnapshot = await pushSnapshot({
          workDir,
          repoName,
          parentSnapshotId: snapshotId,
        });
        return sendJson(res, 200, {
          parentSnapshotId: snapshotId || null,
          updatedSnapshotId: pushedSnapshot.snapshotId,
          artifactType: "full",
          provider: pushedSnapshot.provider,
          storageKey: pushedSnapshot.key,
          repoName,
          workDir,
          editResults,
          results,
        });
      } catch (err) {
        return sendJson(res, 500, {
          errorCode: ERROR_CODES.PUSH_FAILED,
          snapshotId,
          repoName,
          workDir,
          editResults,
          results,
          error:
            err instanceof Error ? err.message : "Failed to push updated snapshot",
        });
      }
    }

    if (isEditRoute) {
      return sendJson(res, allSuccess ? 200 : 500, {
        errorCode: allSuccess ? null : ERROR_CODES.COMMAND_EXECUTION_FAILED,
        parentSnapshotId: snapshotId || null,
        updatedSnapshotId: null,
        artifactType: null,
        repoName,
        workDir,
        editResults,
        results,
      });
    }

    return sendJson(res, allSuccess ? 200 : 500, {
      snapshotId,
      repoName,
      workDir,
      results,
    });
  } catch (err) {
    if (isEditRoute) {
      return sendJson(res, 500, {
        errorCode: ERROR_CODES.INTERNAL_ERROR,
        snapshotId,
          workDir,
        repoName,
        editResults,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
    return sendJson(res, 500, {
      snapshotId,
      workDir,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Neurolink check-runner listening on port ${PORT}`);
});
