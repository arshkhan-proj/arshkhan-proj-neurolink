export interface SandboxJob {
  id: string;
  cwd: string;
  command?: string;
  entryFile?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

