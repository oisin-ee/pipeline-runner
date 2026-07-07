import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  PipelineRuntimeEvent,
  PipelineRuntimeResult,
} from "../pipeline-runtime";
import {
  firstRuntimeEventMapping,
  runtimeEventMapping,
} from "../runner-event-mapping";
import type {
  RuntimeEventMapping,
  RuntimeEventOf,
  RuntimeEventType,
} from "../runner-event-mapping";

const LINE_RE = /\r?\n/u;
const isNonEmptyString = (value: string): boolean => value !== "";

interface TerminalRuntimeRendererState {
  attempts: Map<string, number>;
}

interface DoctorCheck {
  detail: string;
  name: string;
  passed: boolean;
}

interface DoctorResult {
  blockers?: DoctorCheck[];
  checks: DoctorCheck[];
  passed: boolean;
  warnings?: DoctorCheck[];
}

type RuntimeProgressMapping = RuntimeEventMapping<
  TerminalRuntimeRendererState,
  string
>;

export type TerminalMessageWriter = (message: string) => void;

const runTerminalConsoleEffect = (effect: Effect.Effect<void>): void => {
  Effect.runSyncExit(
    effect.pipe(Effect.provideService(Console.Console, globalThis.console))
  );
};

export const writeTerminalLog: TerminalMessageWriter = (message) => {
  runTerminalConsoleEffect(Console.log(message));
};

export const writeTerminalError: TerminalMessageWriter = (message) => {
  runTerminalConsoleEffect(Console.error(message));
};

const runtimeProgressMapping = <Type extends RuntimeEventType>(
  type: Type,
  map: (
    event: RuntimeEventOf<Type>,
    state: TerminalRuntimeRendererState
  ) => string
): RuntimeProgressMapping => runtimeEventMapping(type, map);

const AGENT_PROGRESS_MAPPINGS: readonly RuntimeProgressMapping[] = [
  runtimeProgressMapping("agent.start", (event, state) => {
    state.attempts.set(event.nodeId, event.attempt);
    return `Agent starting: ${event.nodeId} runner=${event.runnerId ?? "unknown"} attempt=${event.attempt}`;
  }),
  runtimeProgressMapping("agent.finish", (event, state) => {
    state.attempts.set(event.nodeId, event.attempt);
    return `Agent finished: ${event.nodeId} runner=${event.runnerId ?? "unknown"} exit=${event.exitCode}`;
  }),
  runtimeProgressMapping(
    "hook.start",
    (event) =>
      `Hook starting: ${event.hookId} event=${event.event}${
        event.nodeId !== undefined && event.nodeId !== ""
          ? ` node=${event.nodeId}`
          : ""
      }`
  ),
  runtimeProgressMapping(
    "hook.finish",
    (event) =>
      `Hook ${event.passed ? "passed" : "failed"}: ${event.hookId}${
        event.reason !== undefined && event.reason !== ""
          ? ` (${event.reason})`
          : ""
      }`
  ),
  runtimeProgressMapping(
    "hook.result",
    (event) =>
      `Hook result: ${event.hookId} ${event.status}${
        event.summary !== undefined && event.summary !== ""
          ? ` (${event.summary})`
          : ""
      }`
  ),
];

const formatKnownAttempt = (
  state: TerminalRuntimeRendererState,
  nodeId: string
): string => {
  const attempt = state.attempts.get(nodeId);
  return attempt === undefined ? "" : ` attempt=${attempt}`;
};

const CHECK_PROGRESS_MAPPINGS: readonly RuntimeProgressMapping[] = [
  runtimeProgressMapping(
    "gate.start",
    (event, state) =>
      `Gate starting: ${event.nodeId}/${event.gateId}${formatKnownAttempt(state, event.nodeId)}`
  ),
  runtimeProgressMapping("gate.finish", (event, state) =>
    [
      `Gate ${event.passed ? "passed" : "failed"}: ${event.nodeId}/${event.gateId}${formatKnownAttempt(state, event.nodeId)}`,
      event.reason !== undefined && event.reason !== ""
        ? `reason=${event.reason}`
        : "",
      ...(event.evidence ?? []).map((item) => `evidence=${item}`),
    ]
      .filter(isNonEmptyString)
      .join(" ")
  ),
  runtimeProgressMapping(
    "artifact.check.start",
    (event) => `Artifact check starting: ${event.nodeId}/${event.path}`
  ),
  runtimeProgressMapping(
    "artifact.check.finish",
    (event) =>
      `Artifact check ${event.passed ? "passed" : "failed"}: ${event.nodeId}/${event.path}${
        event.reason !== undefined && event.reason !== ""
          ? ` (${event.reason})`
          : ""
      }`
  ),
];

const formatRuntimeEventOutput = (output: unknown): string => {
  if (typeof output === "string") {
    return output.trimEnd();
  }
  return JSON.stringify(output);
};

const WORKFLOW_PROGRESS_MAPPINGS: readonly RuntimeProgressMapping[] = [
  runtimeProgressMapping(
    "workflow.planned",
    (event) =>
      `Pipeline planned: ${event.workflowId} (${event.nodes.map((node) => node.id).join(" -> ")})`
  ),
  runtimeProgressMapping(
    "workflow.start",
    (event) =>
      `Pipeline starting: ${event.workflowId} (${event.nodeIds.join(" -> ")})`
  ),
  runtimeProgressMapping("node.start", (event, state) => {
    state.attempts.set(event.nodeId, event.attempt);
    return [
      `Node starting: ${event.nodeId}`,
      event.runnerId !== undefined && event.runnerId !== ""
        ? `runner=${event.runnerId}`
        : "",
      event.profile !== undefined && event.profile !== ""
        ? `profile=${event.profile}`
        : "",
      `attempt=${event.attempt}`,
    ]
      .filter(isNonEmptyString)
      .join(" ");
  }),
  runtimeProgressMapping("node.finish", (event, state) => {
    state.attempts.set(event.nodeId, event.attempt);
    return `Node finished: ${event.nodeId} ${event.status} exit=${event.exitCode}`;
  }),
  runtimeProgressMapping("node.output.recorded", (event) =>
    [
      `Node output: ${event.nodeId}`,
      `attempt=${event.attempt}`,
      `format=${event.format}`,
      formatRuntimeEventOutput(event.output),
    ]
      .filter(isNonEmptyString)
      .join(" ")
  ),
  runtimeProgressMapping(
    "workflow.finish",
    (event) => `Pipeline finished: ${event.workflowId} ${event.outcome}`
  ),
];

const REPAIR_PROGRESS_MAPPINGS: readonly RuntimeProgressMapping[] = [
  runtimeProgressMapping(
    "output.repair",
    (event) =>
      `Output repair ${event.passed ? "passed" : "failed"}: ${event.nodeId} attempt=${event.attempt}${
        event.reason !== undefined && event.reason !== ""
          ? ` (${event.reason})`
          : ""
      }`
  ),
];

const OBSERVABILITY_PROGRESS_MAPPINGS: readonly RuntimeProgressMapping[] = [
  runtimeProgressMapping(
    "runtime.observability",
    (event) => `Runtime observed: ${event.name} - ${event.summary}`
  ),
];

const RUNTIME_PROGRESS_MAPPINGS: readonly RuntimeProgressMapping[] = [
  ...WORKFLOW_PROGRESS_MAPPINGS,
  ...AGENT_PROGRESS_MAPPINGS,
  ...CHECK_PROGRESS_MAPPINGS,
  ...OBSERVABILITY_PROGRESS_MAPPINGS,
  ...REPAIR_PROGRESS_MAPPINGS,
];

const terminalRuntimeRendererState = (): TerminalRuntimeRendererState => ({
  attempts: new Map(),
});

export const formatRuntimeProgressMessage = (
  event: PipelineRuntimeEvent,
  state?: TerminalRuntimeRendererState
): string => {
  const progress = firstRuntimeEventMapping(
    event,
    state ?? terminalRuntimeRendererState(),
    RUNTIME_PROGRESS_MAPPINGS
  );
  return Option.isSome(progress) ? progress.value : "";
};

export const createTerminalRuntimeReporter = (
  write: TerminalMessageWriter = writeTerminalError
): ((event: PipelineRuntimeEvent) => void) => {
  const state = terminalRuntimeRendererState();
  return (event) => {
    const message = formatRuntimeProgressMessage(event, state);
    if (message !== "") {
      write(message);
    }
  };
};

export const formatDoctorResult = (result: DoctorResult): string => {
  const warnings = result.warnings ?? [];
  const lines = [
    `Doctor: ${result.passed ? "PASS" : "FAIL"}`,
    ...result.checks.map(
      (check) =>
        `- ${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`
    ),
  ];
  if (warnings.length > 0) {
    lines.push(
      ...warnings.map((check) => `- WARN ${check.name}: ${check.detail}`)
    );
  }
  return lines.join("\n");
};

const indent = (text: string, prefix: string): string =>
  text
    .split(LINE_RE)
    .map((line) => `${prefix}${line}`)
    .join("\n");

const truncateMiddle = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  const keep = Math.floor((maxLength - 32) / 2);
  return `${text.slice(0, keep)}\n... truncated ...\n${text.slice(-keep)}`;
};

const appendIndentedSection = (
  lines: string[],
  label: string,
  values: string[]
): void => {
  const text = values.filter(isNonEmptyString).join("\n").trim();
  if (text === "") {
    return;
  }
  lines.push(`  ${label}:`);
  lines.push(indent(truncateMiddle(text, 4000), "    "));
};

type RuntimeFailureDetail = PipelineRuntimeResult["failureDetails"][number];
type RuntimeGateDetail = PipelineRuntimeResult["gates"][number];
type RuntimeNodeDetail = PipelineRuntimeResult["nodes"][number];

const optionalNonEmptyText = (
  value: Option.Option<string>
): Option.Option<string> =>
  Option.match(value, {
    onNone: () => Option.none(),
    onSome: (resolved) =>
      resolved === "" ? Option.none() : Option.some(resolved),
  });

const runtimeFailureNodeId = (
  failure: RuntimeFailureDetail
): Option.Option<string> =>
  optionalNonEmptyText(Option.fromUndefinedOr(failure.nodeId));

const formatRuntimeFailureHeading = (failure: RuntimeFailureDetail): string =>
  Option.match(runtimeFailureNodeId(failure), {
    onNone: () => `- ${failure.reason}`,
    onSome: (nodeId) => `- ${nodeId}: ${failure.reason}`,
  });

const findRuntimeFailureNode = (
  result: PipelineRuntimeResult,
  failure: RuntimeFailureDetail
): Option.Option<RuntimeNodeDetail> =>
  Option.match(runtimeFailureNodeId(failure), {
    onNone: () => Option.none(),
    onSome: (nodeId) =>
      Option.fromUndefinedOr(
        result.nodes.find((item) => item.nodeId === nodeId)
      ),
  });

const appendRuntimeFailureNode = (
  lines: string[],
  node: RuntimeNodeDetail
): void => {
  lines.push(
    `  Node: status=${node.status} attempts=${node.attempts} exit=${node.exitCode}`
  );
  appendIndentedSection(lines, "Node evidence", node.evidence);
  appendIndentedSection(lines, "Node output", [node.output]);
};

const appendRuntimeFailure = (
  lines: string[],
  result: PipelineRuntimeResult,
  failure: RuntimeFailureDetail
): void => {
  lines.push(formatRuntimeFailureHeading(failure));
  appendIndentedSection(lines, "Evidence", failure.evidence);
  Option.match(findRuntimeFailureNode(result, failure), {
    onNone: () => {
      /* no node details */
    },
    onSome: (node) => {
      appendRuntimeFailureNode(lines, node);
    },
  });
};

const formatRuntimeGateReason = (gate: RuntimeGateDetail): string =>
  Option.match(optionalNonEmptyText(Option.fromUndefinedOr(gate.reason)), {
    onNone: () => "",
    onSome: (reason) => ` (${reason})`,
  });

const appendRuntimeGate = (lines: string[], gate: RuntimeGateDetail): void => {
  lines.push(
    `  - ${gate.nodeId}/${gate.gateId}: ${gate.passed ? "PASS" : "FAIL"}${formatRuntimeGateReason(gate)}`
  );
  appendIndentedSection(lines, "Gate evidence", gate.evidence);
};

const appendRuntimeGateSection = (
  lines: string[],
  gates: RuntimeGateDetail[]
): void => {
  if (gates.length === 0) {
    return;
  }
  lines.push("Gates:");
  for (const gate of gates) {
    appendRuntimeGate(lines, gate);
  }
};

export const formatRuntimeResult = (result: PipelineRuntimeResult): string => {
  const lines = [
    `Pipeline complete: ${result.outcome}`,
    `Workflow: ${result.plan.workflowId}`,
    `Nodes: ${result.nodes.map((node) => `${node.nodeId}:${node.status}`).join(", ")}`,
    `Agent boundaries: ${result.agentInvocations.length}`,
  ];
  const outputs = result.nodes.filter((node) => node.output.trim());
  if (outputs.length > 0) {
    lines.push("Node outputs:");
    for (const node of outputs) {
      appendIndentedSection(lines, node.nodeId, [node.output]);
    }
  }
  return lines.join("\n");
};

export const formatRuntimeFailure = (result: PipelineRuntimeResult): string => {
  const lines = ["Pipeline failed."];
  for (const failure of result.failureDetails) {
    appendRuntimeFailure(lines, result, failure);
  }
  appendRuntimeGateSection(lines, result.gates);
  return lines.join("\n");
};
