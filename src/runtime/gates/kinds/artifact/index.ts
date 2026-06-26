import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateArtifactGate } from "./artifact";

export const artifactModule: GateKindModule = {
  kind: "artifact",
  evaluate: forKind("artifact", (gate, input) =>
    evaluateArtifactGate(gate, input.gateId, input.nodeId, input.context)
  ),
};
