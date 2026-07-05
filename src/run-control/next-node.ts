import type { Command } from "commander";
import { Effect, Option } from "effect";
import type { Scope } from "effect";

import type { PipelineConfig } from "../config";
import { loadPipelineConfig } from "../config/load";
import { loadMokaDbUrl } from "../moka-global-config";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../planning/generate";
import { resolveDurableStore } from "../runtime/durable-store/acquisition";
import type { DurableRunStore } from "../runtime/durable-store/durable-store";
import type { NextNodeEnvelope } from "../runtime/node-protocol/node-protocol";
import type { WorkflowScheduleNode } from "../runtime/scheduler";
import { computeReadyNodeIds } from "../runtime/scheduler";
import {
  buildEnvelopeForNode,
  collectStoredResults,
} from "../runtime/step/step-node";
import type { NextNodeInput } from "../runtime/step/step-node";
import { resolveRunControlStore } from "./run-control-store";
import type { RunControlStore } from "./run-control-store";

// PIPE-94.2: the envelope-build input types now live with the shared stepping
// core (`src/runtime/step/step-node.ts`); re-exported here so existing callers
// keep importing them from the `next node` surface.
export type {
  NextNodeInput,
  NodeEnvelopeMetadata,
} from "../runtime/step/step-node";

export interface NextNodeRunStoreInput {
  readonly config: PipelineConfig;
  readonly durableStore: DurableRunStore;
  readonly runControlStore: RunControlStore;
  readonly runId: string;
  readonly worktreePath: string;
}

/**
 * PIPE-91.6: compute and return the {@link NextNodeEnvelope} for the first
 * ready node in the persisted run, or `undefined` when no node is ready (run is
 * complete or all remaining nodes are blocked by an upstream failure).
 *
 * Reads ALL stored node records (passed AND failed) as the `completed` set so
 * that: (a) a failed node is not re-emitted as ready (it is settled), and (b)
 * a failed dependency correctly blocks its dependents via the default
 * `result.status !== "failed"` check in {@link computeReadyNodeIds}.
 * `upstreamOutputs` carries only PASSED results — a failed upstream has no
 * meaningful output to hand the next executor. Pure function: store reads are
 * injected via `input.store`.
 */
const buildNextNodeEnvelopeOption = (
  input: NextNodeInput
): Option.Option<NextNodeEnvelope> => {
  // Selection: gather all stored results (any status — both passed and failed
  // are "settled") and pick the first ready node. Execution-core envelope
  // assembly is delegated to the shared stepping module so the local run, the
  // Argo runner, and this CLI all build envelopes the same way (PIPE-94.2).
  const completed = collectStoredResults(input);
  const nodeId = computeReadyNodeIds({ completed, nodes: input.nodes })[0];
  return Option.flatMap(Option.fromUndefinedOr(nodeId), (value) =>
    Option.fromUndefinedOr(buildEnvelopeForNode(input, value))
  );
};

export const buildNextNodeEnvelope = (input: NextNodeInput) =>
  Option.getOrUndefined(buildNextNodeEnvelopeOption(input));

export const readPersistedScheduleEffect = (
  store: RunControlStore,
  runId: string
): Effect.Effect<string, unknown> =>
  Effect.gen(function* effectBody() {
    const manifest = yield* store.readRun({ runId });
    if (manifest === undefined) {
      return yield* Effect.fail(
        new Error(`Run ${runId} does not exist in the Moka DB.`)
      );
    }
    if (manifest.schedule === undefined || manifest.schedule.length === 0) {
      return yield* Effect.fail(
        new Error(
          `Run ${runId} has no persisted schedule. moka next node reads schedules from the Moka DB; start the run with moka run so manifest.schedule is persisted.`
        )
      );
    }
    return manifest.schedule;
  });

const scheduleNodesFromRunStore = (
  input: NextNodeRunStoreInput
): Effect.Effect<
  {
    nodeMetadata: NextNodeInput["nodeMetadata"];
    nodes: WorkflowScheduleNode[];
  },
  unknown
> =>
  Effect.gen(function* effectBody() {
    const scheduleRaw = yield* readPersistedScheduleEffect(
      input.runControlStore,
      input.runId
    );
    const compiled = yield* Effect.try({
      catch: (error) => error,
      try: () =>
        compileScheduleArtifact(
          input.config,
          parseScheduleArtifact(
            scheduleRaw,
            `persisted schedule for ${input.runId}`
          ),
          input.worktreePath
        ),
    });
    const { plan } = compiled;
    // PlannedWorkflowNode carries all fields WorkflowScheduleNode requires and
    // TypeScript's structural typing accepts the assignment without any cast.
    const nodes: WorkflowScheduleNode[] = plan.topologicalOrder;
    const nodeMetadata = new Map(
      plan.topologicalOrder.map((node) => [
        node.id,
        {
          criteria: node.taskContext?.acceptanceCriteria ?? [],
          prompt: node.taskContext?.description ?? node.id,
        },
      ])
    );
    return { nodeMetadata, nodes };
  });

export const buildNextNodeEnvelopeFromRunStore = (
  input: NextNodeRunStoreInput
) =>
  Effect.gen(function* effectBody() {
    const { nodeMetadata, nodes } = yield* scheduleNodesFromRunStore(input);
    return buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: input.runId,
      store: input.durableStore,
    });
  });

export const readyNodeIdsFromRunStore = (
  input: NextNodeRunStoreInput
): Effect.Effect<string[], unknown> =>
  Effect.gen(function* effectBody() {
    const { nodes } = yield* scheduleNodesFromRunStore(input);
    const completed = collectStoredResults({
      nodeMetadata: new Map(),
      nodes,
      runId: input.runId,
      store: input.durableStore,
    });
    return computeReadyNodeIds({ completed, nodes });
  });

const printNextNodeEnvelopeScoped = (
  runId: string
): Effect.Effect<void, unknown, Scope.Scope> =>
  Effect.gen(function* effectBody() {
    const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
    const config = yield* Effect.try({
      catch: (error) => error,
      try: () => loadPipelineConfig(cwd),
    });
    const dbUrl = loadMokaDbUrl();
    const runControlStore = yield* resolveRunControlStore(dbUrl, cwd);
    const durableStore = yield* resolveDurableStore(dbUrl, runId);
    const envelope = yield* buildNextNodeEnvelopeFromRunStore({
      config,
      durableStore,
      runControlStore,
      runId,
      worktreePath: cwd,
    });
    if (envelope === undefined) {
      process.stdout.write(
        "No ready nodes — run is complete or all remaining nodes are blocked.\n"
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  });

const printNextNodeEnvelopeEffect = (
  runId: string
): Effect.Effect<void, unknown> =>
  Effect.scoped(printNextNodeEnvelopeScoped(runId));

/**
 * Register `moka next node <run-id>` under the `next` command group. The
 * schedule is read from the run-control manifest in the Moka DB by run id.
 */
export const registerNextNodeSubcommand = (nextCommand: Command): void => {
  nextCommand
    .command("node")
    .description(
      "Emit the next ready node envelope from a persisted run without executing it"
    )
    .argument("<run-id>", "the run id to query")
    .showHelpAfterError(
      "Remove --schedule-file; moka next node reads schedules from the Moka DB by run id."
    )
    .action(async (runId: string) => {
      await Effect.runPromise(printNextNodeEnvelopeEffect(runId));
    });
};
