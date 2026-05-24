export type PipelineSpecPhaseKey =
  | "knowledge"
  | "research"
  | "red"
  | "green"
  | "verify"
  | "learn";

export type PipelineSpecAgentRole =
  | "researcher"
  | "test-writer"
  | "code-writer"
  | "verifier";

export interface PipelineSpecAgent {
  description: string;
  name: string;
  role: PipelineSpecAgentRole;
  tools: string[];
}

export interface PipelineSpecPhase {
  agentRole?: PipelineSpecAgentRole;
  gate?: string;
  key: PipelineSpecPhaseKey;
  name: string;
  output: string;
}

export const PIPELINE_AGENTS: PipelineSpecAgent[] = [
  {
    description:
      "Research the requested task, map relevant files, identify existing patterns, and write concise findings.",
    name: "pipeline-researcher",
    role: "researcher",
    tools: ["read", "grep", "glob", "list", "bash"],
  },
  {
    description:
      "Write failing tests for the requested behavior and stop before changing production code.",
    name: "pipeline-test-writer",
    role: "test-writer",
    tools: ["read", "grep", "glob", "list", "edit", "write", "bash"],
  },
  {
    description:
      "Implement production code to satisfy the failing tests while keeping edits scoped.",
    name: "pipeline-code-writer",
    role: "code-writer",
    tools: ["read", "grep", "glob", "list", "edit", "write", "bash"],
  },
  {
    description:
      "Verify configured checks, duplication checks, and implementation fit.",
    name: "pipeline-verifier",
    role: "verifier",
    tools: ["read", "grep", "glob", "list", "bash"],
  },
];

export const PIPELINE_PHASES: PipelineSpecPhase[] = [
  {
    key: "knowledge",
    name: "Knowledge context",
    output:
      "Build `.pipeline/knowledge-context.md` from rules and qdrant retrieval.",
  },
  {
    agentRole: "researcher",
    key: "research",
    name: "Research",
    output:
      "Write `.pipeline/research.json` with files, patterns, risks, and the implementation target.",
  },
  {
    agentRole: "test-writer",
    gate: "RED passes only when the newly added tests fail for the requested behavior.",
    key: "red",
    name: "RED",
    output: "Add focused failing tests only. Do not change production code.",
  },
  {
    agentRole: "code-writer",
    gate: "GREEN passes only when the targeted tests and typecheck pass.",
    key: "green",
    name: "GREEN",
    output: "Implement production code until the failing tests pass.",
  },
  {
    agentRole: "verifier",
    gate: "VERIFY passes only when quality checks and implementation review pass.",
    key: "verify",
    name: "VERIFY",
    output: "Run verification and report concrete pass/fail evidence.",
  },
  {
    key: "learn",
    name: "LEARN",
    output: "Call `qdrant-store` with durable lessons from the run.",
  },
];

export function agentForRole(role: PipelineSpecAgentRole): PipelineSpecAgent {
  const agent = PIPELINE_AGENTS.find((item) => item.role === role);
  if (!agent) {
    throw new Error(`Unknown pipeline agent role: ${role}`);
  }
  return agent;
}

export function renderPipelineWorkflow(task: string): string {
  const phaseLines = PIPELINE_PHASES.map((phase, index) => {
    const agent = phase.agentRole ? agentForRole(phase.agentRole) : null;
    const owner = agent ? ` Use ${agent.name}.` : "";
    const gate = phase.gate ? ` Gate: ${phase.gate}` : "";
    return `${index + 1}. ${phase.name}: ${phase.output}${owner}${gate}`;
  });

  return [
    "Run the oisin pipeline mechanically for the provided task.",
    "",
    "Do not replace these phases with an ad-hoc chat plan. Use the host's native command, skill, agent, subagent, extension, or session mechanism exactly as configured by these generated resources.",
    "",
    "Task:",
    "",
    "```",
    task,
    "```",
    "",
    "Pipeline phases:",
    ...phaseLines,
    "",
    "Stop and report failure evidence if any gate fails. Do not mark later phases complete after a failed gate.",
  ].join("\n");
}
