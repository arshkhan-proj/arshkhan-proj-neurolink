import type { Executor } from "./executor.js";
import { LocalProcessExecutor } from "./localProcessExecutor.js";
import type { SandboxJob, SandboxResult } from "./types.js";

export class Sandbox {
  private readonly executor: Executor;

  constructor(executor?: Executor) {
    this.executor = executor ?? new LocalProcessExecutor();
  }

  async run(job: SandboxJob): Promise<SandboxResult> {
    if (!job.command && !job.entryFile) {
      throw new Error("Either command or entryFile must be provided");
    }

    if (!job.cwd) {
      throw new Error("SandboxJob.cwd is required");
    }

    return await this.executor.run(job);
  }
}
