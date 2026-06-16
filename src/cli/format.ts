import type {
  PipelineRuntimeEvent,
  PipelineRuntimeResult,
} from "../pipeline-runtime";

const LINE_RE = /\r?\n/;

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

export function createTerminalRuntimeReporter(
  write: (message: string) => void = (message) => console.log(message)
): (event: PipelineRuntimeEvent) => void {
  const state: TerminalRuntimeRendererState = { attempts: new Map() };
  return (event) => {
    const message = formatRuntimeProgressMessage(event, state);
    write(message);
  };
}

export function formatRuntimeProgressMessage(
  event: PipelineRuntimeEvent,
  state: TerminalRuntimeRendererState = { attempts: new Map() }
): string {
  return (
    formatWorkflowProgress(event, state) ??
    formatAgentProgress(event, state) ??
    formatCheckProgress(event, state) ??
    formatObservabilityProgress(event) ??
    formatRepairProgress(event)
  );
}

function formatWorkflowProgress(
  event: PipelineRuntimeEvent,
  state: TerminalRuntimeRendererState
): string | null {
  switch (event.type) {
    case "workflow.planned":
      return `Pipeline planned: ${event.workflowId} (${event.nodes.map((node) => node.id).join(" -> ")})`;
    case "workflow.start":
      return `Pipeline starting: ${event.workflowId} (${event.nodeIds.join(" -> ")})`;
    case "node.start":
      state.attempts.set(event.nodeId, event.attempt);
      return [
        `Node starting: ${event.nodeId}`,
        event.runnerId ? `runner=${event.runnerId}` : "",
        event.profile ? `profile=${event.profile}` : "",
        `attempt=${event.attempt}`,
      ]
        .filter(Boolean)
        .join(" ");
    case "node.finish":
      state.attempts.set(event.nodeId, event.attempt);
      return `Node finished: ${event.nodeId} ${event.status} exit=${event.exitCode}`;
    case "node.output.recorded":
      return [
        `Node output: ${event.nodeId}`,
        `attempt=${event.attempt}`,
        `format=${event.format}`,
        formatRuntimeEventOutput(event.output),
      ]
        .filter(Boolean)
        .join(" ");
    case "workflow.finish":
      return `Pipeline finished: ${event.workflowId} ${event.outcome}`;
    default:
      return null;
  }
}

function formatAgentProgress(
  event: PipelineRuntimeEvent,
  state: TerminalRuntimeRendererState
): string | null {
  switch (event.type) {
    case "agent.start":
      state.attempts.set(event.nodeId, event.attempt);
      return `Agent starting: ${event.nodeId} runner=${event.runnerId ?? "unknown"} attempt=${event.attempt}`;
    case "agent.finish":
      state.attempts.set(event.nodeId, event.attempt);
      return `Agent finished: ${event.nodeId} runner=${event.runnerId ?? "unknown"} exit=${event.exitCode}`;
    case "hook.start":
      return `Hook starting: ${event.hookId} event=${event.event}${event.nodeId ? ` node=${event.nodeId}` : ""}`;
    case "hook.finish":
      return `Hook ${event.passed ? "passed" : "failed"}: ${event.hookId}${event.reason ? ` (${event.reason})` : ""}`;
    case "hook.result":
      return `Hook result: ${event.hookId} ${event.status}${event.summary ? ` (${event.summary})` : ""}`;
    default:
      return null;
  }
}

function formatCheckProgress(
  event: PipelineRuntimeEvent,
  state: TerminalRuntimeRendererState
): string | null {
  switch (event.type) {
    case "gate.start":
      return `Gate starting: ${event.nodeId}/${event.gateId}${formatKnownAttempt(state, event.nodeId)}`;
    case "gate.finish":
      return [
        `Gate ${event.passed ? "passed" : "failed"}: ${event.nodeId}/${event.gateId}${formatKnownAttempt(state, event.nodeId)}`,
        event.reason ? `reason=${event.reason}` : "",
        ...(event.evidence ?? []).map((item) => `evidence=${item}`),
      ]
        .filter(Boolean)
        .join(" ");
    case "artifact.check.start":
      return `Artifact check starting: ${event.nodeId}/${event.path}`;
    case "artifact.check.finish":
      return `Artifact check ${event.passed ? "passed" : "failed"}: ${event.nodeId}/${event.path}${event.reason ? ` (${event.reason})` : ""}`;
    default:
      return null;
  }
}

function formatKnownAttempt(
  state: TerminalRuntimeRendererState,
  nodeId: string
): string {
  const attempt = state.attempts.get(nodeId);
  return attempt === undefined ? "" : ` attempt=${attempt}`;
}

function formatRuntimeEventOutput(output: unknown): string {
  if (typeof output === "string") {
    return output.trimEnd();
  }
  return JSON.stringify(output);
}

function formatRepairProgress(event: PipelineRuntimeEvent): string {
  switch (event.type) {
    case "output.repair":
      return `Output repair ${event.passed ? "passed" : "failed"}: ${event.nodeId} attempt=${event.attempt}${event.reason ? ` (${event.reason})` : ""}`;
    default:
      throw new Error(`Unhandled runtime event: ${event.type}`);
  }
}

function formatObservabilityProgress(
  event: PipelineRuntimeEvent
): string | null {
  switch (event.type) {
    case "runtime.observability":
      return `Runtime observed: ${event.name} - ${event.summary}`;
    default:
      return null;
  }
}

export function formatRuntimeResult(result: PipelineRuntimeResult): string {
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
}

export function formatRuntimeFailure(result: PipelineRuntimeResult): string {
  const lines = ["Pipeline failed."];
  for (const failure of result.failureDetails) {
    lines.push(
      failure.nodeId
        ? `- ${failure.nodeId}: ${failure.reason}`
        : `- ${failure.reason}`
    );
    appendIndentedSection(lines, "Evidence", failure.evidence);
    const node = failure.nodeId
      ? result.nodes.find((item) => item.nodeId === failure.nodeId)
      : undefined;
    if (node) {
      lines.push(
        `  Node: status=${node.status} attempts=${node.attempts} exit=${node.exitCode}`
      );
      appendIndentedSection(lines, "Node evidence", node.evidence);
      appendIndentedSection(lines, "Node output", [node.output]);
    }
  }
  if (result.gates.length > 0) {
    lines.push("Gates:");
    for (const gate of result.gates) {
      lines.push(
        `  - ${gate.nodeId}/${gate.gateId}: ${gate.passed ? "PASS" : "FAIL"}${gate.reason ? ` (${gate.reason})` : ""}`
      );
      appendIndentedSection(lines, "Gate evidence", gate.evidence);
    }
  }
  return lines.join("\n");
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines = [
    `Doctor: ${result.passed ? "PASS" : "FAIL"}`,
    ...result.checks.map(
      (check) =>
        `- ${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`
    ),
  ];
  if (result.warnings?.length) {
    lines.push(
      ...result.warnings.map((check) => `- WARN ${check.name}: ${check.detail}`)
    );
  }
  return lines.join("\n");
}

function appendIndentedSection(
  lines: string[],
  label: string,
  values: string[]
): void {
  const text = values.filter(Boolean).join("\n").trim();
  if (!text) {
    return;
  }
  lines.push(`  ${label}:`);
  lines.push(indent(truncateMiddle(text, 4000), "    "));
}

function indent(text: string, prefix: string): string {
  return text
    .split(LINE_RE)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const keep = Math.floor((maxLength - 32) / 2);
  return `${text.slice(0, keep)}\n... truncated ...\n${text.slice(-keep)}`;
}
