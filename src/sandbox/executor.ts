import type { SandboxJob, SandboxResult } from "./types.js";

export interface Executor {
  run(job: SandboxJob): Promise<SandboxResult>;
}

