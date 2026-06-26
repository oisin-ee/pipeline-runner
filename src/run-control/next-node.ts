import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { Effect } from "effect";
import { loadPipelineConfig } from "../config/load";
import { loadMokaGlobalConfig } from "../moka-global-config";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../planning/generate";
import type { AcceptanceCriterion } from "../runtime/contracts/contracts";
import type { DurableRunStore } from "../runtime/durable-store/durable-store";
import { inMemoryDurableRunStore } from "../runtime/durable-store/durable-store";
import type { NextNodeEnvelope } from "../runtime/node-protocol/node-protocol";
import type { WorkflowScheduleNode } from "../runtime/scheduler";
import { computeReadyNodeIds } from "../runtime/scheduler";

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
 * - `store` — the durable run store; the in-memory impl is the default for the
 *   absent-db-url path; Postgres (PIPE-91.4) plugs into the same interface.
 */
export interface NextNodeInput {
  readonly nodeMetadata: ReadonlyMap<string, NodeEnvelopeMetadata>;
  readonly nodes: WorkflowScheduleNode[];
  readonly runId: string;
  readonly store: DurableRunStore;
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

/**
 * PIPE-91.6: resolve the {@link DurableRunStore} for this invocation using the
 * same `db.url`-presence selection as `pipeline-runtime.ts`. Both branches
 * return `inMemoryDurableRunStore()` until PIPE-91.4 delivers the Postgres impl;
 * the selection is wired so 91.4 can substitute `postgresStore(dbUrl)` here
 * without touching any other call site.
 */
function resolveDurableStore(dbUrl: string | undefined): DurableRunStore {
  if (dbUrl !== undefined) {
    // PIPE-91.4: swap to postgresStore(dbUrl) here when that lane lands.
    return inMemoryDurableRunStore();
  }
  return inMemoryDurableRunStore();
}

/**
 * PIPE-91.6: register `moka next node <run-id> --schedule-file <path>` under
 * the `next` command group. The schedule file is the YAML written by `moka run`
 * (same artifact consumed by `runner-command run`).
 */
export function registerNextNodeSubcommand(nextCommand: Command): void {
  nextCommand
    .command("node")
    .description(
      "Emit the next ready node envelope from a persisted run without executing it"
    )
    .argument("<run-id>", "the run id to query")
    .requiredOption(
      "--schedule-file <path>",
      "compiled schedule YAML for this run (written by moka run at schedule time)"
    )
    .action(async (runId: string, flags: { scheduleFile: string }) => {
      await Effect.runPromise(
        printNextNodeEnvelopeEffect(runId, flags.scheduleFile)
      );
    });
}

function printNextNodeEnvelopeEffect(
  runId: string,
  scheduleFile: string
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const scheduleRaw = yield* Effect.tryPromise({
      catch: (error) => error,
      try: () => readFile(scheduleFile, "utf8"),
    });
    const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
    const config = yield* Effect.try({
      catch: (error) => error,
      try: () => loadPipelineConfig(cwd),
    });
    const compiled = yield* Effect.try({
      catch: (error) => error,
      try: () =>
        compileScheduleArtifact(
          config,
          parseScheduleArtifact(scheduleRaw, scheduleFile),
          cwd
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
    const dbUrl = loadMokaGlobalConfig()?.momokaya?.db?.url;
    const store = resolveDurableStore(dbUrl);
    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId,
      store,
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
