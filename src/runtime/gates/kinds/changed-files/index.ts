import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateChangedFilesGate } from "./changed-files";

export const changedFilesModule: GateKindModule = {
  kind: "changed_files",
  evaluate: forKind("changed_files", (gate, input) =>
    evaluateChangedFilesGate(gate, input.gateId, input.nodeId, input.context)
  ),
};
