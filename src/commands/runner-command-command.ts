import type { Command } from "commander";
import { runRunnerFinalize } from "../runner-command/finalize";
import { runRunnerCommand } from "../runner-command/run";

export function registerRunnerCommandCommand(program: Command): void {
  program
    .command("runner-command")
    .description("Run one scheduled Argo Workflow task")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .requiredOption(
      "--schedule-file <path>",
      "Path to the schedule artifact YAML"
    )
    .action(async (options: { payloadFile: string; scheduleFile: string }) => {
      process.exitCode = await runRunnerCommand(options);
    });

  program
    .command("runner-finalize")
    .description("Finalize one Argo Workflow run")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .requiredOption(
      "--schedule-file <path>",
      "Path to the schedule artifact YAML"
    )
    .requiredOption("--argo-status <status>", "Argo Workflow status")
    .action(
      async (options: {
        argoStatus: string;
        payloadFile: string;
        scheduleFile: string;
      }) => {
        process.exitCode = await runRunnerFinalize(options);
      }
    );
}
