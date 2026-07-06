import type { PipelineConfig } from "../config";
import { compileScheduleArtifact, parseScheduleArtifact } from "../planning/generate";
import { flattenNodes } from "../planning/graph";
import type { CreateRunRequest } from "./run-control-store";

/**
 * PIPE-94.5: shared input for building a remote (Argo-pod) CreateRunRequest.
 *
 * Both the submit path (PIPE-94.4) and the runner-lifecycle workflow.start
 * floor pass the SAME inputs so they produce byte-identical complete manifests.
 */
export interface RemoteRunRecordOptions {
  config: PipelineConfig;
  runId: string;
  scheduleYaml: string;
  worktreePath?: string;
}

/**
 * Build a COMPLETE `CreateRunRequest` for a remote run, deriving the real node
 * ids from the schedule the same way the local run path does.
 *
 * This is the single owner of two facts:
 *  - the remote run defaults (`effort: "normal"`, `mode: "write"`,
 *    `target: "remote"`);
 *  - how a schedule + config compile into the manifest's node list
 *    (`flattenNodes(plan.topologicalOrder, node.children)` — group/parallel
 *    children included, matching `cli/run-service.ts`).
 *
 * Why this matters (PIPE-94.5 correctness): createRun is first-writer-wins
 * (`ON CONFLICT DO NOTHING`, PIPE-94.1) and `createRunManifest` builds the
 * per-node status map FROM `nodeIds`. If the submit-side writer wrote an empty
 * node list first, the lifecycle's real-node createRun would be a no-op and the
 * manifest would be permanently stuck with no nodes. Because BOTH writers call
 * this builder, whichever wins first persists a complete node list — the upsert
 * is lossless regardless of order.
 */
export const buildRemoteRunCreateRequest = (options: RemoteRunRecordOptions): CreateRunRequest => {
  const { plan } = compileScheduleArtifact(
    options.config,
    parseScheduleArtifact(options.scheduleYaml, "schedule.yaml"),
    options.worktreePath,
  );
  const nodeIds = flattenNodes(plan.topologicalOrder, (node) => node.children).map((node) => node.id);
  return {
    effort: "normal",
    mode: "write",
    nodeIds,
    runId: options.runId,
    schedule: options.scheduleYaml,
    target: "remote",
  };
};
