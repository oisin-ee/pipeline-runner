import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateVerdictGate } from "./verdict";

export const verdictModule: GateKindModule = {
  evaluate: forKind("verdict", (gate, input) =>
    evaluateVerdictGate(gate, input.gateId, input.nodeId, input.context, input.attempt),
  ),
  kind: "verdict",
};
