import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateCommandGate } from "./command";

export const commandModule: GateKindModule = {
  evaluate: forKind(
    "command",
    async (gate, input) => await evaluateCommandGate(gate, input.gateId, input.nodeId, input.context, input.executor),
  ),
  kind: "command",
};
