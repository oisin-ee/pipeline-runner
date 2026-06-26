import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateCommandGate } from "./command";

export const commandModule: GateKindModule = {
  kind: "command",
  evaluate: forKind("command", (gate, input) =>
    evaluateCommandGate(
      gate,
      input.gateId,
      input.nodeId,
      input.context,
      input.executor
    )
  ),
};
