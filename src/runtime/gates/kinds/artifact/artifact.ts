import { artifactExists } from "../../../../gates";
import type { ArtifactGateSpec, RuntimeGateResult } from "../../../contracts";

/** Minimal context shape needed by artifact evaluation. */
export interface ArtifactContext {
  worktreePath: string;
}

/**
 * Checks whether the configured artifact path exists in the node's worktree.
 * A missing path or nonexistent file fails the gate.
 */
export const evaluateArtifactGate = (
  gate: ArtifactGateSpec,
  gateId: string,
  nodeId: string,
  context: ArtifactContext,
): RuntimeGateResult => {
  const { path } = gate;
  const passed = path.length > 0 && artifactExists(context.worktreePath, path);
  return {
    evidence: [passed ? `artifact exists: ${path}` : `missing artifact: ${path}`],
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : `missing artifact '${path}'`,
  };
};
