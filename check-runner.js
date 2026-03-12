import http from 'node:http';
import { exec } from 'node:child_process';

const PORT = process.env.PORT || 4000;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/run-checks') {
    res.writeHead(404);
    return res.end('Not found');
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', () => {
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      res.writeHead(400);
      return res.end('Invalid JSON');
    }

    const workDir = typeof parsed.workDir === 'string' ? parsed.workDir : '';
    if (!workDir) {
      res.writeHead(400);
      return res.end('workDir is required');
    }

    const commandsInput = parsed.commands;
    const commands =
      Array.isArray(commandsInput) && commandsInput.length > 0
        ? commandsInput.filter((c) => typeof c === 'string' && c.trim() !== '')
        : ['pnpm test'];

    if (commands.length === 0) {
      res.writeHead(400);
      return res.end('commands must be a non-empty array of strings');
    }

    const runCommand = (command) =>
      new Promise((resolve) => {
        const start = Date.now();
        exec(
          command,
          {
            shell: '/bin/bash',
            cwd: workDir,
            env: {
              ...process.env,
              NODE_ENV: 'test'
            }
          },
          (error, stdout, stderr) => {
            const durationMs = Date.now() - start;
            const success = !error;
            const exitCode =
              error && typeof error.code === 'number' ? error.code : 0;
            resolve({
              command,
              success,
              exitCode,
              durationMs,
              stdout,
              stderr
            });
          }
        );
      });

    (async () => {
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
        'Content-Type': 'application/json'
      });
      res.end(
        JSON.stringify({
          workDir,
          results
        })
      );
    })().catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          workDir,
          error: err instanceof Error ? err.message : 'Unknown error'
        })
      );
    });
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Neurolink check-runner listening on port ${PORT}`);
});