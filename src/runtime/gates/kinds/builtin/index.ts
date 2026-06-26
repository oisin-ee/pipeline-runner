import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateBuiltinGate } from "./builtin";

export const builtinModule: GateKindModule = {
  kind: "builtin",
  evaluate: forKind("builtin", (gate, input) =>
    evaluateBuiltinGate(gate, input.gateId, input.nodeId, input.context)
  ),
};
