import http from "node:http";
import { exec } from "node:child_process";
import { pullSnapshot } from "./pullSnapshot.js";

const PORT = process.env.PORT || 4000;

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/run-checks") {
    res.writeHead(404);
    return res.end("Not found");
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", async () => {
    /**
     * @type {{
     *   workDir?: string;
     *   snapshotId?: string;
     *   repoName?: string;
     *   commands?: unknown[];
     * }}
     */
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      res.writeHead(400);
      return res.end("Invalid JSON");
    }

    const snapshotId =
      typeof parsed.snapshotId === "string" && parsed.snapshotId.trim() !== ""
        ? parsed.snapshotId.trim()
        : undefined;

    const repoName =
      typeof parsed.repoName === "string" && parsed.repoName.trim() !== ""
        ? parsed.repoName.trim()
        : undefined;

    let workDir =
      typeof parsed.workDir === "string" && parsed.workDir.trim() !== ""
        ? parsed.workDir.trim()
        : "";

    // If snapshotId is provided, ignore incoming workDir and pull snapshot
    if (snapshotId) {
      try {
        workDir = await pullSnapshot(snapshotId, repoName);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            snapshotId,
            repoName,
            error:
              err instanceof Error
                ? err.message
                : "Failed to pull snapshot from S3",
          }),
        );
      }
    }

    if (!workDir) {
      res.writeHead(400);
      return res.end("workDir is required when snapshotId is not provided");
    }

    const commandsInput = parsed.commands;
    const commands =
      Array.isArray(commandsInput) && commandsInput.length > 0
        ? commandsInput.filter(
            (c) => typeof c === "string" && c.trim() !== "",
          )
        : ["pnpm test"];

    if (commands.length === 0) {
      res.writeHead(400);
      return res.end("commands must be a non-empty array of strings");
    }

    const runCommand = (command) =>
      new Promise((resolve) => {
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

    try {
      const results = [];
      for (const cmd of commands) {
        // Run sequentially so commands can depend on previous steps
        // (e.g. install then test).
        // eslint-disable-next-line no-await-in-loop
        const result = await runCommand(cmd);
        results.push(result);
      }

      const allSuccess = results.every((r) => r.success);
      res.writeHead(allSuccess ? 200 : 500, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          snapshotId,
          repoName,
          workDir,
          results,
        }),
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          snapshotId,
          workDir,
          error: err instanceof Error ? err.message : "Unknown error",
        }),
      );
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Neurolink check-runner listening on port ${PORT}`);
});