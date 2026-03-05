import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import pidusage from "pidusage";
import type { Executor } from "./executor.js";
import type { SandboxJob, SandboxResult } from "./types.js";

function buildCommandArgs(job: SandboxJob): {
  command: string;
  args: string[];
} {
  const isWindows = process.platform === "win32";

  if (job.command) {
    if (isWindows) {
      return { command: "cmd.exe", args: ["/c", job.command] };
    }
    return { command: "sh", args: ["-c", job.command] };
  }

  if (job.entryFile) {
    return { command: "node", args: [job.entryFile] };
  }

  throw new Error("Either command or entryFile must be provided");
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  const isWindows = process.platform === "win32";

  if (isWindows) {
    // Use taskkill to terminate the entire process tree on Windows
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
      // We don't care about killer's stdio output; just wait for it to exit
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }

  try {
    // On Unix-like systems, send the signal to the process group
    process.kill(-pid, "SIGKILL");
  } catch {
    // Fallback to killing just the child if process group kill fails
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore if already dead
    }
  }
}

export class LocalProcessExecutor implements Executor {
  private readonly defaultTimeoutMs = 30_000;

  async run(job: SandboxJob): Promise<SandboxResult> {
    if (!job.cwd) {
      throw new Error("SandboxJob.cwd is required");
    }

    if (!job.command && !job.entryFile) {
      throw new Error("Either command or entryFile must be provided");
    }

    const { command, args } = buildCommandArgs(job);
    const start = Date.now();
    const timeoutMs = job.timeoutMs ?? this.defaultTimeoutMs;

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let metricsIntervalId: NodeJS.Timeout | undefined;

    return await new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: job.cwd,
        env: { ...process.env, ...job.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        if (metricsIntervalId) {
          clearInterval(metricsIntervalId);
          metricsIntervalId = undefined;
        }
        child.removeAllListeners();
        if (child.stdout) child.stdout.removeAllListeners();
        if (child.stderr) child.stderr.removeAllListeners();
      };

      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        const durationMs = Date.now() - start;
        reject(err);
        // Note: we intentionally reject here so callers can distinguish spawn errors
      });

      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer | string) => {
          const data = typeof chunk === "string" ? chunk : chunk.toString();
          stdout += data;
          // Stream live to parent stdout
          try {
            process.stdout.write(data);
          } catch {
            // Ignore streaming errors
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer | string) => {
          const data = typeof chunk === "string" ? chunk : chunk.toString();
          stderr += data;
          // Stream live to parent stderr
          try {
            process.stderr.write(data);
          } catch {
            // Ignore streaming errors
          }
        });
      }

      // Periodic resource usage logging for the child process
      if (child.pid) {
        const pid = child.pid;
        metricsIntervalId = setInterval(async () => {
          try {
            const stats = await pidusage(pid);
            const rssMb = (stats.memory / 1024 / 1024).toFixed(1);
            const cpuPercent = stats.cpu.toFixed(1);
            const line =
              `[Sandbox Metrics] pid=${pid} ` +
              `cpu=${cpuPercent}% rssMB=${rssMb}\n`;
            process.stdout.write(line);
          } catch {
            // Ignore errors (e.g. process already exited)
          }
        }, 2000);
      }

      timeoutId = setTimeout(async () => {
        if (finished) return;
        finished = true;
        await killProcessTree(child);
        cleanup();
        const durationMs = Date.now() - start;
        const result: SandboxResult = {
          success: false,
          exitCode: null,
          stdout,
          stderr:
            stderr +
            (stderr.endsWith("\n") ? "" : "\n") +
            `Sandbox timeout after ${timeoutMs}ms`,
          durationMs,
        };
        resolve(result);
      }, timeoutMs);

      child.on("exit", (code) => {
        if (finished) return;
        finished = true;
        cleanup();
        const durationMs = Date.now() - start;
        const result: SandboxResult = {
          success: code === 0,
          exitCode: code,
          stdout,
          stderr,
          durationMs,
        };
        resolve(result);
      });
    });
  }
}

