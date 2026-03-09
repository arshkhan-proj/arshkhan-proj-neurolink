/**
 * Sandbox CLI Command for NeuroLink
 *
 * Executes local processes (Node entry files or shell commands)
 * using the Sandbox execution engine.
 *
 * Examples:
 *   neurolink sandbox --entry ./file.js
 *   neurolink sandbox --cmd "npm run build"
 *   neurolink sandbox --cmd "node script.js" --timeout 10000
 */

import path from "node:path";
import type { Argv, CommandModule } from "yargs";
import chalk from "chalk";
import ora from "ora";
import { Sandbox } from "../../sandbox/sandbox.js";
import type { SandboxResult } from "../../sandbox/types.js";

type SandboxCommandArgs = {
  entry?: string;
  cmd?: string;
  cwd?: string;
  timeout?: number;
  env?: string[];
};

function parseEnvVariables(
  envArgs?: string[],
): Record<string, string> | undefined {
  if (!envArgs || envArgs.length === 0) {
    return undefined;
  }

  const env: Record<string, string> = {};

  for (const pair of envArgs) {
    const index = pair.indexOf("=");
    if (index === -1) {
      // Skip malformed entries but warn the user
      process.stderr.write(
        chalk.yellow(
          `Ignoring invalid --env entry (expected KEY=VALUE): ${pair}\n`,
        ),
      );
      continue;
    }
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) {
      process.stderr.write(
        chalk.yellow(`Ignoring invalid --env entry with empty key: ${pair}\n`),
      );
      continue;
    }
    env[key] = value;
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

async function executeSandboxCommand(argv: SandboxCommandArgs): Promise<void> {
  const spinner = ora("Running sandbox job...");

  if (!argv.entry && !argv.cmd) {
    throw new Error("Either --entry or --cmd must be provided");
  }

  if (argv.entry && argv.cmd) {
    throw new Error("Only one of --entry or --cmd can be provided");
  }

  const cwd = argv.cwd ? path.resolve(argv.cwd) : process.cwd();

  const timeoutMs = typeof argv.timeout === "number" ? argv.timeout : undefined;
  const env = parseEnvVariables(argv.env);

  const jobId = `cli-sandbox-${Date.now()}`;
  const sandbox = new Sandbox();

  spinner.start();

  let result: SandboxResult | undefined;

  try {
    result = await sandbox.run({
      id: jobId,
      cwd,
      entryFile: argv.entry,
      command: argv.cmd,
      env,
      timeoutMs,
    });
  } finally {
    spinner.stop();
  }

  if (!result) {
    throw new Error("Sandbox did not return a result");
  }

  // Print structured result summary
  process.stdout.write("\n");
  process.stdout.write(chalk.cyan("=== Sandbox Result ===\n"));
  process.stdout.write(
    `${chalk.bold("Success")}: ${result.success}\n` +
      `${chalk.bold("Exit Code")}: ${result.exitCode ?? "null"}\n` +
      `${chalk.bold("Duration (ms)")}: ${result.durationMs}\n`,
  );

  // Exit with the same exit code as the executed process (or 1 on failure)
  if (result.exitCode !== null) {
    process.exitCode = result.exitCode;
  } else {
    process.exitCode = result.success ? 0 : 1;
  }
}

export const sandboxCommand: CommandModule<unknown, SandboxCommandArgs> = {
  command: "sandbox",
  describe:
    "Execute a local sandboxed process (Node entry file or shell command)",
  builder: (yargs: Argv<unknown>) => {
    return yargs
      .option("entry", {
        type: "string",
        describe: "Path to a Node.js entry file to execute (e.g. ./script.js)",
      })
      .option("cmd", {
        type: "string",
        describe: 'Shell command to execute (e.g. "npm run build")',
      })
      .option("cwd", {
        type: "string",
        describe:
          "Working directory for the sandboxed process (default: current directory)",
      })
      .option("timeout", {
        type: "number",
        describe:
          "Timeout in milliseconds before the process is terminated (default: 30000)",
      })
      .option("env", {
        type: "string",
        array: true,
        describe:
          "Environment variables to set (KEY=VALUE). Can be provided multiple times.",
      })
      .check((argv) => {
        const hasEntry = typeof argv.entry === "string";
        const hasCmd = typeof argv.cmd === "string";

        if (!hasEntry && !hasCmd) {
          throw new Error("Either --entry or --cmd must be provided");
        }

        if (hasEntry && hasCmd) {
          throw new Error("Only one of --entry or --cmd can be provided");
        }

        return true;
      });
  },
  handler: async (argv) => {
    try {
      await executeSandboxCommand(argv as SandboxCommandArgs);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown sandbox error";
      process.stderr.write(chalk.red(`Sandbox error: ${message}\n`));
      process.exitCode = 1;
    }
  },
};
