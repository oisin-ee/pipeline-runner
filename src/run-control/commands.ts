import type { Command } from "commander";
import { Effect } from "effect";

import { logEffect, withRunControlStore } from "./command-context";
import { registerNextNodeSubcommand } from "./next-node";
import { registerResumeSubcommand } from "./resume-command";
import { exportSanitizedRunBundleEffect, printLogsEffect } from "./run-artifacts-command";
import type { LogsFlags } from "./run-artifacts-command";
import { printRunsEffect, printStatusEffect } from "./run-query-command";
import type { StatusFlags } from "./run-query-command";
import { stopRunOrNodeEffect } from "./stop-command";
import { registerSubmitResultSubcommand } from "./submit-result";

interface ExportFlags {
  sanitize?: boolean;
}

const exportCommandEffect = (input: {
  flags: ExportFlags;
  runId: string;
  store: Parameters<typeof exportSanitizedRunBundleEffect>[0]["store"];
  workspaceRoot: string;
}): Effect.Effect<void, unknown> => {
  if (input.flags.sanitize !== true) {
    return Effect.fail(new Error("Run exports must be requested with --sanitize."));
  }
  return exportSanitizedRunBundleEffect({
    runId: input.runId,
    store: input.store,
    workspaceRoot: input.workspaceRoot,
  }).pipe(
    Effect.map((bundle) => JSON.stringify(bundle)),
    Effect.flatMap(logEffect),
  );
};

export const registerRunControlCommands = (program: Command): void => {
  program
    .command("runs")
    .description("List known Moka runs, newest first")
    .action(async () => {
      await Effect.runPromise(withRunControlStore((store, root) => printRunsEffect(store, root)));
    });

  program
    .command("status")
    .description("Show run-control status for a Moka run")
    .argument("[run-id]", "run id to inspect; defaults to latest active run")
    .option("--watch", "poll status until the selected run is no longer active")
    .option("--json", "print machine-readable run status")
    .action(async (runId: Parameters<typeof printStatusEffect>[0]["runId"], flags: StatusFlags) => {
      await Effect.runPromise(
        withRunControlStore((store, root) => printStatusEffect({ flags, runId, store, workspaceRoot: root })),
      );
    });

  program
    .command("logs")
    .description("Print whole-run or node-specific run-control artifacts")
    .argument("<run-id>", "run id to inspect")
    .argument("[node-id]", "node id whose artifacts should be printed")
    .option("--follow", "continue printing appended artifact content while the run is active")
    .action(async (runId: string, nodeId: Parameters<typeof printLogsEffect>[0]["nodeId"], flags: LogsFlags) => {
      await Effect.runPromise(
        withRunControlStore((store, root) =>
          printLogsEffect({
            flags,
            nodeId,
            runId,
            store,
            workspaceRoot: root,
          }),
        ),
      );
    });

  program
    .command("stop")
    .description("Mark a Moka run or node as aborted")
    .argument("<run-id>", "run id to stop")
    .argument("[node-id]", "node id to stop without aborting sibling work")
    .action(async (runId: string, nodeId?: string) => {
      await Effect.runPromise(
        withRunControlStore((store) =>
          stopRunOrNodeEffect({
            nodeId,
            runId,
            store,
          }).pipe(Effect.flatMap(logEffect)),
        ),
      );
    });

  program
    .command("export")
    .description("Print a sanitized portable run evidence bundle")
    .argument("<run-id>", "run id to export")
    .requiredOption("--sanitize", "omit prompt and session body text from exported artifacts")
    .action(async (runId: string, flags: ExportFlags) => {
      await Effect.runPromise(
        withRunControlStore((store, root) => exportCommandEffect({ flags, runId, store, workspaceRoot: root })),
      );
    });

  const nextCommand = program.command("next").description("Advance a persisted durable run one step");
  registerNextNodeSubcommand(nextCommand);

  registerSubmitResultSubcommand(program);
  registerResumeSubcommand(program);
};
