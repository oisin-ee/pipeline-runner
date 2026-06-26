import type { HookEvent, PipelineConfig } from "../../config";
import type { HookResult } from "../../hooks";
import type {
  PlannedWorkflowNode,
  WorkflowExecutionPlan,
} from "../../planning/compile";
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
} from "../actor-ids";
import type { NodeHandoff } from "../handoff";
import type { NodeStateStore } from "../node-state-store";

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

/**
 * One unmet acceptance criterion in a structured gate refusal (PIPE-90.1,
 * orchestrator-design decision #6 — OPA deny-set shape). Each entry is
 * actionable: `criterion` names WHICH acceptance criterion failed, `reason` is
 * the human/agent-readable summary, and `evidence` anchors it to deterministic
 * proof. The keystone shared contract every PIPE-90 downstream ticket consumes.
 */
export interface UnmetCriterion {
  criterion: string;
  evidence: string[];
  reason: string;
}

export interface RuntimeGateResult {
  evidence: string[];
  gateId: string;
  kind: string;
  nodeId: string;
  passed: boolean;
  reason?: string;
  /**
   * Structured refusal: the criteria a failing gate could not satisfy. A
   * passing gate leaves this empty; binary gates that only know a single
   * pass/fail omit it entirely (consumers treat absent as empty). Only
   * multi-criterion gates (acceptance) populate it today.
   */
  unmet?: UnmetCriterion[];
}

export interface RuntimeNodeResult {
  attempts: number;
  evidence: string[];
  exitCode: number;
  nodeId: string;
  output: string;
  status: "failed" | "passed";
}

/**
 * Agent-output boundary, layer 4 of 4 (PIPE-74 B3). The terminal, structured
 * form of agent output: the layer-3 RuntimeNormalizedOutput text
 * (src/runtime/opencode-adapter.ts) parsed into a typed `output` value and
 * validated against the node's declared schema. This is what downstream nodes
 * and gates consume.
 */
export interface RuntimeStructuredOutput {
  attempt: number;
  format: "json" | "json_schema" | "jsonl";
  nodeId: string;
  output: unknown;
  parentParallelNodeId?: string;
  profileId?: string;
  schemaPath?: string;
  validation: {
    evidence: string[];
    passed: boolean;
    reason?: string;
    status: "invalid" | "not_applicable" | "valid";
  };
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
  /** opencode session id when the node ran through the SDK executor (PIPE-73). */
  sessionId?: string;
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
  structuredOutputs: RuntimeStructuredOutput[];
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
      nodeId: string;
      sessionId: string;
      type: "node.session";
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

/**
 * Middle layer of the runtime-options stack (PIPE-74 B3): everything needed to
 * run one pipeline workflow from config — the config/entrypoint to run, the
 * task, reporting, and the executor (whose per-call controls come from the
 * layer below, {@link RunnerExecutionOptions} in src/runner.ts). Extended by
 * ScheduledWorkflowTaskRuntimeOptions (src/pipeline-runtime.ts) for the
 * single-node, schedule-driven execution path.
 */
export interface PipelineRuntimeOptions {
  availableModels?: ReadonlySet<string>;
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
  handoff?: NodeHandoff;
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
  /**
   * Models resolvable in this runtime (authenticated providers in the leased
   * opencode server). Threaded into model selection so a preferred but
   * unavailable provider falls back instead of failing. Undefined when
   * availability cannot be determined (no filtering applied).
   */
  availableModels?: ReadonlySet<string>;
  config: PipelineConfig;
  executor: (
    plan: RunnerLaunchPlan,
    options: RunnerExecutionOptions
  ) => AgentResult | Promise<AgentResult>;
  gates: RuntimeGateResult[];
  hookFailures: RuntimeFailure[];
  hookPolicy: Required<HookRuntimePolicy>;
  hookResults: Map<string, HookResult>;
  maxParallelNodes?: number;
  nodeStateStore: NodeStateStore;
  observability?: RuntimeObservabilityEmitter;
  parentParallelNodeId?: string;
  plan: WorkflowExecutionPlan;
  reporter?: (event: PipelineRuntimeEvent) => void;
  runId?: string;
  signal?: AbortSignal;
  task: string;
  taskContext?: PipelineTaskContext;
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
