import type { GateKindModule } from "../../contract";
import { forKind } from "../../contract";
import { evaluateChangedFilesGate } from "./changed-files";

export const changedFilesModule: GateKindModule = {
  evaluate: forKind("changed_files", (gate, input) =>
    evaluateChangedFilesGate(gate, input.gateId, input.nodeId, input.context),
  ),
  kind: "changed_files",
};
