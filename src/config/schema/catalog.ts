export const ID_RE = /^[a-z][a-z0-9-]*$/u;

// Reasoning effort is carried as data on the role (node/profile/runner) and
// applied at runtime as the opencode model variant for the selected model,
// rather than baked into synthetic per-effort model ids. Mirrors the OpenCode
// GPT-5 reasoning variant levels registered for broker-backed OpenAI models.
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;

export const RUNNER_TYPES = ["opencode", "command"] as const;
export const NODE_KINDS = ["agent", "command", "builtin", "group", "parallel"] as const;
export const HOOK_EVENTS = [
  "workflow.start",
  "workflow.success",
  "workflow.failure",
  "workflow.complete",
  "node.start",
  "node.success",
  "node.error",
  "node.finish",
  "gate.failure",
] as const;
export const TOOL_NAMES = ["read", "list", "grep", "glob", "bash", "edit", "write", "task"] as const;
export const FILESYSTEM_MODES = ["read-only", "workspace-write"] as const;
export const NETWORK_MODES = ["inherit", "disabled"] as const;
export const OUTPUT_FORMATS = ["text", "json", "jsonl", "json_schema"] as const;
export const GATE_KINDS = [
  "acceptance",
  "artifact",
  "builtin",
  "changed_files",
  "command",
  "json_schema",
  "verdict",
] as const;
export const BUILTIN_GATES = ["duplication", "fallow", "lint", "semgrep", "test", "typecheck"] as const;
export const RETRY_REASONS = ["exit_nonzero", "gate_failure", "timeout"] as const;
export const SCHEDULE_BASELINES = ["execute", "quick"] as const;
export const SCHEDULE_STRATEGIES = ["planner"] as const;
export const SCHEDULING_ROLES = ["coverage", "implementation"] as const;
export const MCP_GATEWAY_BACKEND_LOCALITIES = ["repo-local", "repo-scoped-remote", "shared-remote"] as const;
export const MCP_GATEWAY_WORKSPACE_PATH_SOURCES = ["PIPELINE_TARGET_PATH", "cwd"] as const;
export const PIPELINE_GATEWAY_SERVER_ID = "pipeline-gateway";
export const DEFAULT_RUNNER_COMMAND_GIT_COMMITTER = {
  email: "git@oisin.ee",
  name: "oisin-bot",
} as const;
