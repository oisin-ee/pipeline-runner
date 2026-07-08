import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { logEffect, withRunControlStore } from "./command-context";
import { createNextNodeCommand } from "./next-node";
import { createResumeCommand } from "./resume-command";
import {
  exportSanitizedRunBundleEffect,
  printLogsEffect,
} from "./run-artifacts-command";
import type { LogsFlags } from "./run-artifacts-command";
import { printRunsEffect, printStatusEffect } from "./run-query-command";
import type { StatusFlags } from "./run-query-command";
import { stopRunOrNodeEffect } from "./stop-command";
import { createSubmitResultCommand } from "./submit-result";

interface ExportFlags {
  sanitize?: boolean;
}

const statusFlags = {
  json: Flag.boolean("json").pipe(
    Flag.withDescription("print machine-readable run status")
  ),
  runId: Argument.string("run-id").pipe(
    Argument.withDescription(
      "run id to inspect; defaults to latest active run"
    ),
    Argument.optional
  ),
  watch: Flag.boolean("watch").pipe(
    Flag.withDescription(
      "poll status until the selected run is no longer active"
    )
  ),
};

// Effect CLI binds positional arguments in config-key order, and `sort-keys`
// forces those keys alphabetical. The optional node argument is therefore keyed
// `targetNodeId` (not `nodeId`) so it sorts AFTER the required `runId`, keeping
// `<run-id> [node-id]` binding correct; keying it `nodeId` would sort it first
// and steal the required run-id's positional.
const logsFlags = {
  follow: Flag.boolean("follow").pipe(
    Flag.withDescription(
      "continue printing appended artifact content while the run is active"
    )
  ),
  runId: Argument.string("run-id").pipe(
    Argument.withDescription("run id to inspect")
  ),
  targetNodeId: Argument.string("node-id").pipe(
    Argument.withDescription("node id whose artifacts should be printed"),
    Argument.optional
  ),
};

const stopFlags = {
  runId: Argument.string("run-id").pipe(
    Argument.withDescription("run id to stop")
  ),
  targetNodeId: Argument.string("node-id").pipe(
    Argument.withDescription("node id to stop without aborting sibling work"),
    Argument.optional
  ),
};

const exportFlags = {
  runId: Argument.string("run-id").pipe(
    Argument.withDescription("run id to export")
  ),
  sanitize: Flag.boolean("sanitize").pipe(
    Flag.withDescription(
      "omit prompt and session body text from exported artifacts"
    )
  ),
};

const statusCommandFlags = (
  input: Command.Command.Config.Infer<typeof statusFlags>
): StatusFlags => ({
  json: input.json,
  watch: input.watch,
});

const logsCommandFlags = (
  input: Command.Command.Config.Infer<typeof logsFlags>
): LogsFlags => ({
  follow: input.follow,
});

const exportCommandEffect = (input: {
  flags: ExportFlags;
  runId: string;
  store: Parameters<typeof exportSanitizedRunBundleEffect>[0]["store"];
  workspaceRoot: string;
}): Effect.Effect<void, unknown> => {
  if (input.flags.sanitize !== true) {
    return Effect.fail(
      new Error("Run exports must be requested with --sanitize.")
    );
  }
  return exportSanitizedRunBundleEffect({
    runId: input.runId,
    store: input.store,
    workspaceRoot: input.workspaceRoot,
  }).pipe(
    Effect.map((bundle) => JSON.stringify(bundle)),
    Effect.flatMap(logEffect)
  );
};

export const createRunControlCommands = () => [
  Command.make("runs", {}, () =>
    withRunControlStore((store, root) => printRunsEffect(store, root))
  ).pipe(Command.withDescription("List known Moka runs, newest first")),
  Command.make("status", statusFlags, (input) =>
    withRunControlStore((store, root) =>
      printStatusEffect({
        flags: statusCommandFlags(input),
        runId: Option.getOrUndefined(input.runId),
        store,
        workspaceRoot: root,
      })
    )
  ).pipe(Command.withDescription("Show run-control status for a Moka run")),
  Command.make("logs", logsFlags, (input) =>
    withRunControlStore((store, root) =>
      printLogsEffect({
        flags: logsCommandFlags(input),
        nodeId: Option.getOrUndefined(input.targetNodeId),
        runId: input.runId,
        store,
        workspaceRoot: root,
      })
    )
  ).pipe(
    Command.withDescription(
      "Print whole-run or node-specific run-control artifacts"
    )
  ),
  Command.make("stop", stopFlags, (input) =>
    withRunControlStore((store) =>
      stopRunOrNodeEffect({
        nodeId: Option.getOrUndefined(input.targetNodeId),
        runId: input.runId,
        store,
      }).pipe(Effect.flatMap(logEffect))
    )
  ).pipe(Command.withDescription("Mark a Moka run or node as aborted")),
  Command.make("export", exportFlags, (input) =>
    withRunControlStore((store, root) =>
      exportCommandEffect({
        flags: { sanitize: input.sanitize },
        runId: input.runId,
        store,
        workspaceRoot: root,
      })
    )
  ).pipe(
    Command.withDescription("Print a sanitized portable run evidence bundle")
  ),
  Command.make("next").pipe(
    Command.withDescription("Advance a persisted durable run one step"),
    Command.withSubcommands([createNextNodeCommand()])
  ),
  createSubmitResultCommand(),
  createResumeCommand(),
];
