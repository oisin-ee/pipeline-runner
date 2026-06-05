import type { Command } from "commander";
import { runRunnerJob } from "../runner-job/run.js";

export function registerRunnerJobCommand(program: Command): void {
  program
    .command("runner-job")
    .description("Run an in-pod pipeline runner job from the console payload")
    .option("--payload-file <path>", "Path to the runner job payload JSON file")
    .option("--orchestrator <name>", "Orchestrator runner (codex|opencode)")
    .argument("[orchestrator]", "Orchestrator runner (codex|opencode)")
    .action(
      async (
        orchestratorArg: string | undefined,
        options: { payloadFile?: string; orchestrator?: string }
      ) => {
        const orchestrator = orchestratorArg ?? options.orchestrator;
        const exitCode = await runRunnerJob({
          payloadFile: options.payloadFile,
          orchestrator,
        });
        process.exitCode = exitCode;
      }
    );
}
