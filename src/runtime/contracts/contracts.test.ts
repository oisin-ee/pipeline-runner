import { describe, expectTypeOf, it } from "vitest";

import type {
  AcceptanceGateSpec,
  ArtifactGateSpec,
  BuiltinGateSpec,
  ChangedFilesGateSpec,
  CommandGateSpec,
  GateSpec,
  HookBinding,
  HookFunctionSpec,
  PipelineRuntimeEvent,
  PipelineRuntimeOptions,
  PipelineRuntimeResult,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
  UnmetCriterion,
  VerdictGateSpec,
} from "./contracts";

describe("runtime contracts", () => {
  it("exposes runtime domain types without importing the public facade", () => {
    expectTypeOf<PipelineRuntimeOptions>().toExtend<{
      task: string;
    }>();
    expectTypeOf<PipelineRuntimeResult["outcome"]>().toEqualTypeOf<
      "CANCELLED" | "FAIL" | "PASS"
    >();
    expectTypeOf<PipelineRuntimeEvent>().toExtend<{ type: string }>();
    expectTypeOf<RuntimeFailure>().toExtend<{
      evidence: string[];
      gate: string;
      reason: string;
    }>();
    expectTypeOf<RuntimeGateResult["passed"]>().toEqualTypeOf<boolean>();
    expectTypeOf<RuntimeGateResult["unmet"]>().toEqualTypeOf<
      UnmetCriterion[] | undefined
    >();
    expectTypeOf<UnmetCriterion>().toEqualTypeOf<{
      criterion: string;
      evidence: string[];
      reason: string;
    }>();
    expectTypeOf<RuntimeNodeResult["status"]>().toEqualTypeOf<
      "failed" | "passed"
    >();
  });

  it("exposes internal runtime configuration aliases for split modules", () => {
    expectTypeOf<GateSpec>().toExtend<{ kind: string }>();
    expectTypeOf<AcceptanceGateSpec["kind"]>().toEqualTypeOf<"acceptance">();
    expectTypeOf<ArtifactGateSpec["kind"]>().toEqualTypeOf<"artifact">();
    expectTypeOf<BuiltinGateSpec["kind"]>().toEqualTypeOf<"builtin">();
    expectTypeOf<
      ChangedFilesGateSpec["kind"]
    >().toEqualTypeOf<"changed_files">();
    expectTypeOf<CommandGateSpec["kind"]>().toEqualTypeOf<"command">();
    expectTypeOf<VerdictGateSpec["kind"]>().toEqualTypeOf<"verdict">();
    expectTypeOf<HookBinding>().toExtend<{
      function: string;
      id: string;
    }>();
    expectTypeOf<HookFunctionSpec>().toExtend<{ kind: string }>();
  });
});
