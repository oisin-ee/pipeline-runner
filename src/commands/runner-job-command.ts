import type { Command } from "commander";
import { runRunnerJob } from "../runner-job/run.js";

export function registerRunnerJobCommand(program: Command): void {
  program
    .command("runner-job")
    .description("Run an in-pod pipeline runner job from the console payload")
    .action(async () => {
      const exitCode = await runRunnerJob();
      process.exitCode = exitCode;
    });
}
