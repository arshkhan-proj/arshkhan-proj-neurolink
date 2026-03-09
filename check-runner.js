import http from "node:http";
import { exec } from "node:child_process";

const PORT = process.env.PORT || 4000;
const SECRET = process.env.CHECK_RUNNER_SECRET || "change-me";

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/run-checks") {
    res.writeHead(404);
    return res.end("Not found");
  }

  if (req.headers["x-check-secret"] !== SECRET) {
    res.writeHead(401);
    return res.end("Unauthorized");
  }

  const start = Date.now();

  exec(
    "/app/run-sandbox-checks.sh",
    { shell: "/bin/bash" },
    (error, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const success = !error;
      const exitCode = error && typeof error.code === "number" ? error.code : 0;

      res.writeHead(success ? 200 : 500, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          success,
          exitCode,
          durationMs,
          stdout,
          stderr,
        }),
      );
    },
  );
});

server.listen(PORT, () => {
  console.log(`Check runner listening on port ${PORT}`);
});
