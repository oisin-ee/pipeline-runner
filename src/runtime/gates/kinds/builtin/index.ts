import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateBuiltinGate } from "./builtin";

export const builtinModule: GateKindModule = {
  evaluate: forKind(
    "builtin",
    async (gate, input) =>
      await evaluateBuiltinGate(gate, input.gateId, input.nodeId, input.context)
  ),
  kind: "builtin",
};
