import type { Command } from "commander";
import { Effect, type Scope } from "effect";
import type { PipelineConfig } from "../config";
import { loadPipelineConfig } from "../config/load";
import { loadMokaDbUrl } from "../moka-global-config";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../planning/generate";
import type { AcceptanceCriterion } from "../runtime/contracts/contracts";
import { resolveDurableStore } from "../runtime/durable-store/acquisition";
import type { DurableRunStore } from "../runtime/durable-store/durable-store";
import type { NextNodeEnvelope } from "../runtime/node-protocol/node-protocol";
import type { WorkflowScheduleNode } from "../runtime/scheduler";
import { computeReadyNodeIds } from "../runtime/scheduler";
import {
  type RunControlStore,
  resolveRunControlStore,
} from "./run-control-store";

/**
 * Per-node envelope metadata: the prompt and read-only acceptance criteria the
 * executing agent receives. These are read-only to the agent (decision #7 —
 * criteria are owned by the schedule, not writable by the node's executor).
 */
export interface NodeEnvelopeMetadata {
  readonly criteria: readonly AcceptanceCriterion[];
  readonly prompt: string;
}

/**
 * PIPE-91.6: input to {@link buildNextNodeEnvelope}. Callers provide:
 * - `nodes` — the workflow graph. Each element must carry `id`, `index`,
 *   `needs`, and `dependents` — the shape {@link WorkflowScheduleNode} requires.
 *   `PlannedWorkflowNode` is a structural superset and therefore assignable.
 * - `nodeMetadata` — per-node prompt + criteria; missing entries default to
 *   empty prompt / empty criteria (graceful degradation for generated schedules
 *   without task_context).
 * - `runId` — the persisted run to query.
 * - `store` — the durable run store; Postgres owns the cross-invocation state
 *   behind the same interface used by tests.
 */
export interface NextNodeInput {
  readonly nodeMetadata: ReadonlyMap<string, NodeEnvelopeMetadata>;
  readonly nodes: WorkflowScheduleNode[];
  readonly runId: string;
  readonly store: DurableRunStore;
}

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
export function buildNextNodeEnvelope(
  input: NextNodeInput
): NextNodeEnvelope | undefined {
  // Gather all stored results (any status) so the readiness computation knows
  // which nodes have already run — both passed and failed are "settled".
  const allResults = input.nodes.flatMap((n) => {
    const rec = input.store.get(input.runId, n.id);
    return rec ? [rec.result] : [];
  });
  const readyIds = computeReadyNodeIds({
    completed: allResults,
    nodes: input.nodes,
  });
  const nodeId = readyIds[0];
  if (nodeId === undefined) {
    return;
  }
  const meta = input.nodeMetadata.get(nodeId);
  const prompt = meta?.prompt ?? "";
  const criteria = meta?.criteria ? [...meta.criteria] : [];
  const node = input.nodes.find((n) => n.id === nodeId);
  // Only passed upstream outputs are useful to the next executor.
  const passedByNodeId = new Map(
    allResults.filter((r) => r.status === "passed").map((r) => [r.nodeId, r])
  );
  const upstreamOutputs = (node?.needs ?? []).flatMap((needId) => {
    const result = passedByNodeId.get(needId);
    return result ? [{ nodeId: needId, output: result.output }] : [];
  });
  return { criteria, nodeId, prompt, runId: input.runId, upstreamOutputs };
}

export function buildNextNodeEnvelopeFromRunStore(
  input: NextNodeRunStoreInput
): Effect.Effect<NextNodeEnvelope | undefined, unknown> {
  return Effect.gen(function* () {
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
    const plan = compiled.plan;
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
    return buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: input.runId,
      store: input.durableStore,
    });
  });
}

function readPersistedScheduleEffect(
  store: RunControlStore,
  runId: string
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const manifest = yield* store.readRun({ runId });
    if (manifest === undefined) {
      return yield* Effect.fail(
        new Error(`Run ${runId} does not exist in the Moka DB.`)
      );
    }
    if (!manifest.schedule) {
      return yield* Effect.fail(
        new Error(
          `Run ${runId} has no persisted schedule. moka next node reads schedules from the Moka DB; start the run with moka run so manifest.schedule is persisted.`
        )
      );
    }
    return manifest.schedule;
  });
}

/**
 * Register `moka next node <run-id>` under the `next` command group. The
 * schedule is read from the run-control manifest in the Moka DB by run id.
 */
export function registerNextNodeSubcommand(nextCommand: Command): void {
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
}

function printNextNodeEnvelopeEffect(
  runId: string
): Effect.Effect<void, unknown> {
  return Effect.scoped(printNextNodeEnvelopeScoped(runId));
}

function printNextNodeEnvelopeScoped(
  runId: string
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function* () {
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
}
