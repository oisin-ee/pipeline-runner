import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateAcceptanceGate } from "./acceptance";

export const acceptanceModule: GateKindModule = {
  evaluate: forKind("acceptance", (gate, input) =>
    evaluateAcceptanceGate(
      gate,
      input.gateId,
      input.nodeId,
      input.context,
      input.attempt,
      input.node
    )
  ),
  kind: "acceptance",
};
