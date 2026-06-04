import type { HookEvent, PipelineConfig } from "../../config";
import type { HookResult } from "../../hooks";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../../runner";
import type {
  RetryReason,
  RuntimeActorDescriptor,
  RuntimeObservabilityEmitter,
  RuntimeObservabilityEvent,
} from "../../runtime-machines/contracts";
import type { NodeExecutionActor } from "../../runtime-machines/node-machine";
import type { WorkflowSchedulerActor } from "../../runtime-machines/workflow-machine";
import type {
  PlannedWorkflowNode,
  WorkflowExecutionPlan,
} from "../../workflow-planner";

export type WorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];
export type GateSpec = NonNullable<WorkflowNode["gates"]>[number];
export type AcceptanceGateSpec = Extract<GateSpec, { kind: "acceptance" }>;
export type ArtifactGateSpec = Extract<GateSpec, { kind: "artifact" }>;
export type BuiltinGateSpec = Extract<GateSpec, { kind: "builtin" }>;
export type ChangedFilesGateSpec = Extract<GateSpec, { kind: "changed_files" }>;
export type CommandGateSpec = Extract<GateSpec, { kind: "command" }>;
export type JsonSchemaGateSpec = Extract<GateSpec, { kind: "json_schema" }>;
export type JsonSourceGateSpec = Extract<
  GateSpec,
  { kind: "acceptance" | "json_schema" | "verdict" }
>;
export type VerdictGateSpec = Extract<GateSpec, { kind: "verdict" }>;
export type HookConfig = PipelineConfig["hooks"];
export type HookFunctionSpec = HookConfig["functions"][string];
export type HookBinding = HookConfig["on"][string][number];

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export interface PipelineTaskContext {
  acceptanceCriteria?: AcceptanceCriterion[];
  description?: string;
  id?: string;
  title?: string;
}

export interface HookRuntimePolicy {
  allowCommandHooks?: boolean;
  allowUntrustedCommandHooks?: boolean;
  env?: Record<string, string>;
  envPassthrough?: string[];
  outputLimitBytes?: number;
  timeoutMs?: number;
}

export interface RuntimeFailure {
  evidence: string[];
  gate: string;
  nodeId?: string;
  reason: string;
}

export interface RuntimeGateResult {
  evidence: string[];
  gateId: string;
  kind: string;
  nodeId: string;
  passed: boolean;
  reason?: string;
}

export interface RuntimeNodeResult {
  attempts: number;
  evidence: string[];
  exitCode: number;
  nodeId: string;
  output: string;
  status: "failed" | "passed";
}

export type NodeStatus =
  | "cancelled"
  | "failed"
  | "gating"
  | "passed"
  | "pending"
  | "ready"
  | "running"
  | "skipped";

export interface NodeExecutionState {
  attempts: number;
  evidence: string[];
  exitCode?: number;
  failure?: RuntimeFailure;
  finishedAt?: string;
  gates: RuntimeGateResult[];
  id: string;
  output?: string;
  retry?: {
    attempt: number;
    delayMs: number;
    evidence: string[];
    exhausted: boolean;
    gate: string;
    reason: string;
    retryReason: string;
    scheduled: boolean;
  };
  startedAt?: string;
  status: NodeStatus;
}

export interface PipelineRuntimeResult {
  agentInvocations: RunnerLaunchPlan[];
  failureDetails: RuntimeFailure[];
  gates: RuntimeGateResult[];
  hookFailures: RuntimeFailure[];
  nodeStates: Record<string, NodeExecutionState>;
  nodes: RuntimeNodeResult[];
  outcome: "CANCELLED" | "FAIL" | "PASS";
  plan: WorkflowExecutionPlan;
}

export type PipelineRuntimeObservabilityLevel = "info" | "warn";

export type PipelineRuntimeEvent = { parentNodeId?: string } & (
  | {
      edges: { source: string; target: string }[];
      nodes: {
        id: string;
        kind: PlannedWorkflowNode["kind"];
        needs: string[];
        profile?: string;
        runnerId?: string;
      }[];
      type: "workflow.planned";
      workflowId: string;
    }
  | {
      nodeIds: string[];
      type: "workflow.start";
      workflowId: string;
    }
  | {
      attempt: number;
      nodeId: string;
      profile?: string;
      runnerId?: string;
      type: "node.start";
    }
  | {
      attempt: number;
      exitCode: number;
      nodeId: string;
      profile?: string;
      runnerId?: string;
      status: RuntimeNodeResult["status"];
      type: "node.finish";
    }
  | {
      attempt: number;
      format: string;
      nodeId: string;
      output: unknown;
      parseError?: string;
      profile?: string;
      schemaPath?: string;
      type: "node.output.recorded";
    }
  | {
      attempt: number;
      nodeId: string;
      profile?: string;
      runnerId?: string;
      type: "agent.start";
    }
  | {
      attempt: number;
      exitCode: number;
      nodeId: string;
      profile?: string;
      runnerId?: string;
      type: "agent.finish";
    }
  | {
      gateId: string;
      kind: string;
      nodeId: string;
      type: "gate.start";
    }
  | {
      evidence?: string[];
      gateId: string;
      kind: string;
      nodeId: string;
      passed: boolean;
      reason?: string;
      type: "gate.finish";
    }
  | {
      nodeId: string;
      path: string;
      required: boolean;
      type: "artifact.check.start";
    }
  | {
      nodeId: string;
      passed: boolean;
      path: string;
      reason?: string;
      required: boolean;
      type: "artifact.check.finish";
    }
  | {
      event: HookEvent;
      functionId: string;
      gateId?: string;
      hookId: string;
      nodeId?: string;
      required: boolean;
      type: "hook.start";
      workflowId: string;
    }
  | {
      event: HookEvent;
      functionId: string;
      gateId?: string;
      hookId: string;
      nodeId?: string;
      passed: boolean;
      reason?: string;
      required: boolean;
      type: "hook.finish";
      workflowId: string;
    }
  | {
      artifacts?: HookResult["artifacts"];
      event: HookEvent;
      functionId: string;
      gateId?: string;
      hookId: string;
      nodeId?: string;
      outputs?: Record<string, unknown>;
      status: HookResult["status"];
      summary?: string;
      type: "hook.result";
      workflowId: string;
    }
  | {
      attempt: number;
      nodeId: string;
      passed: boolean;
      reason?: string;
      type: "output.repair";
    }
  | {
      actor: RuntimeActorDescriptor;
      level: PipelineRuntimeObservabilityLevel;
      name: RuntimeObservabilityEvent["type"];
      nodeId?: string;
      summary: string;
      type: "runtime.observability";
      workflowId: string;
    }
  | {
      outcome: PipelineRuntimeResult["outcome"];
      type: "workflow.finish";
      workflowId: string;
    }
);

export interface PipelineRuntimeOptions {
  config?: PipelineConfig;
  entrypoint?: string;
  executor?: (
    plan: RunnerLaunchPlan,
    options: RunnerExecutionOptions
  ) => AgentResult | Promise<AgentResult>;
  hookPolicy?: HookRuntimePolicy;
  maxParallelNodes?: number;
  reporter?: (event: PipelineRuntimeEvent) => void;
  runId?: string;
  signal?: AbortSignal;
  task: string;
  taskContext?: PipelineTaskContext;
  workflowId?: string;
  worktreePath?: string;
}

export interface NodeAttemptResult {
  evidence: string[];
  exitCode: number;
  output: string;
  timedOut?: boolean;
}

export interface NodeAttemptCycleResult {
  last: NodeAttemptResult;
  result?: RuntimeNodeResult;
  retry?: NodeAttemptRetry;
}

export interface NodeAttemptRetry {
  attempt: number;
  evidence: string[];
  gate: string;
  reason: string;
  retryReason: RetryReason;
}

export interface OutputRepairContext {
  evidence: string[];
  maxAttempts: number;
  runner: string;
  schemaPath: string;
  validation: JsonSchemaValidationResult;
}

export interface RuntimeContext {
  agentInvocations: RunnerLaunchPlan[];
  baseSha?: Promise<string>;
  config: PipelineConfig;
  executor: (
    plan: RunnerLaunchPlan,
    options: RunnerExecutionOptions
  ) => AgentResult | Promise<AgentResult>;
  gates: RuntimeGateResult[];
  hookFailures: RuntimeFailure[];
  hookPolicy: Required<HookRuntimePolicy>;
  hookResults: Map<string, HookResult>;
  inheritedOutputNodeIds: Set<string>;
  lastOutputByNode: Map<string, string>;
  maxParallelNodes?: number;
  nodeActors: Map<string, NodeExecutionActor>;
  nodeSnapshots: Map<string, ChangedFilesSnapshot>;
  nodeStates: Map<string, NodeExecutionState>;
  observability?: RuntimeObservabilityEmitter;
  plan: WorkflowExecutionPlan;
  preserveSuccessfulWorkflowWorktrees?: boolean;
  reporter?: (event: PipelineRuntimeEvent) => void;
  runId?: string;
  signal?: AbortSignal;
  task: string;
  taskContext?: PipelineTaskContext;
  workflowActor?: WorkflowSchedulerActor;
  workflowId: string;
  worktreePath: string;
}

export interface ChangedFilesSnapshot {
  files: Set<string>;
  fingerprints: Map<string, string>;
}

export interface CommandExecutionOptions {
  env?: Record<string, string>;
  extendEnv?: boolean;
  input?: string;
  outputLimitBytes?: number;
  timeout?: number;
}

export interface JsonSchemaValidationResult {
  evidence: string[];
  passed: boolean;
  reason?: string;
}
