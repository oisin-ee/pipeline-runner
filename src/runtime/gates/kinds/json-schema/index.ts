import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateJsonSchemaGate } from "./json-schema";

export const jsonSchemaModule: GateKindModule = {
  kind: "json_schema",
  evaluate: forKind("json_schema", (gate, input) =>
    evaluateJsonSchemaGate(
      gate,
      input.gateId,
      input.nodeId,
      input.context,
      input.attempt
    )
  ),
};
