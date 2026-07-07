import type { HookEvent } from "../../config";
import type { HookResult } from "../../hooks";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type {
  HookBinding,
  HookFunctionSpec,
  RuntimeContext,
  RuntimeFailure,
} from "../contracts";

export interface RuntimeHookInvocationResult {
  failure?: RuntimeFailure;
  hookResult?: HookResult;
}

export interface HookInvocationResultEvent {
  failure?: RuntimeFailure;
  reason?: string;
  status: "passed" | "failed" | "timedOut" | "skipped";
}

export interface HookExecutionInput {
  binding: HookBinding;
  context: RuntimeContext;
  event: HookEvent;
  failure?: RuntimeFailure;
  gateId?: string;
  hookFunction: HookFunctionSpec;
  node?: PlannedWorkflowNode;
}

export type HookFunctionKind = HookFunctionSpec["kind"];

export type HookFunctionExecutor = (
  input: HookExecutionInput
) => Promise<RuntimeHookInvocationResult> | RuntimeHookInvocationResult;
