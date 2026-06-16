import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import matter from "gray-matter";
import {
  defaultClusterDoctorNamespace,
  runClusterDoctor,
} from "../cluster-doctor";
import {
  loadPipelineConfig,
  type PipelineConfig,
  PipelineConfigError,
} from "../config";
import { loadMokaGlobalConfig } from "../moka-global-config";
import { opencodeAgentName } from "../runtime/opencode-agent-name";

const HEADLESS_AGENT_PERMISSION_VALUES = new Set(["ask"]);
const RUN_READINESS_CATEGORIES = new Set([
  "acceptance",
  "green",
  "intake",
  "red",
  "research",
  "verification",
]);
const OPENCODE_AGENT_LIST_ARGS = ["agent", "list", "--json"];
const BULLET_PREFIX_RE = /^[-*]\s+/;
const LINE_RE = /\r?\n/;

export interface DoctorCheck {
  detail: string;
  name: string;
  passed: boolean;
}

export interface DoctorResult {
  blockers: DoctorCheck[];
  checks: DoctorCheck[];
  passed: boolean;
  warnings: DoctorCheck[];
}

export interface DoctorFlags {
  cluster?: boolean | string;
  json?: boolean;
  kubeContext?: string;
  kubeconfig?: string;
}

interface AgentVisibilityResult {
  check: DoctorCheck;
  warning?: DoctorCheck;
}

interface VisibleAgents {
  ambiguous: boolean;
  names: Set<string>;
  recognized: boolean;
}

export async function runDoctor(
  cwd: string,
  options: DoctorFlags = {}
): Promise<DoctorResult> {
  const commandChecks = await Promise.all([
    checkCommand("npx", ["--version"], cwd),
    checkCommand("opencode", ["--version"], cwd),
    checkCommand("fallow", ["--version"], cwd),
  ]);
  const configCheck = checkPipelineConfig(cwd);
  const config = configCheck.passed ? loadPipelineConfig(cwd) : null;
  const [sdkCheck, agentVisibility] = await Promise.all([
    checkOpenCodeSdk(),
    config
      ? checkMokaAgents(cwd, config)
      : Promise.resolve<AgentVisibilityResult>({
          check: {
            detail: "skipped because pipeline config is invalid",
            name: "moka-agents",
            passed: true,
          },
        }),
  ]);
  const globalConfig = loadMokaGlobalConfig();
  const clusterResult = options.cluster
    ? await runClusterDoctor({
        kubeContext: options.kubeContext,
        kubeconfigPath:
          options.kubeconfig ?? globalConfig?.momokaya.kubernetes.kubeconfig,
        namespace: clusterNamespace(
          options.cluster,
          globalConfig?.momokaya.kubernetes.namespace
        ),
      })
    : { checks: [] };
  const checks = [
    ...commandChecks,
    configCheck,
    sdkCheck,
    agentVisibility.check,
    ...clusterResult.checks,
  ];
  const warnings = [
    ...(agentVisibility.warning ? [agentVisibility.warning] : []),
    ...headlessPermissionWarnings(cwd),
  ];
  const blockers = checks.filter((check) => !check.passed);
  return {
    blockers,
    checks,
    passed: blockers.length === 0,
    warnings,
  };
}

function clusterNamespace(
  value: boolean | string,
  configuredNamespace?: string
): string {
  return typeof value === "string" && value.length > 0
    ? value
    : (configuredNamespace ?? defaultClusterDoctorNamespace());
}

function checkCommand(
  name: string,
  args: string[],
  cwd: string
): Promise<DoctorCheck> {
  return checkCommandWithRunner(name, name, args, cwd);
}

async function checkCommandWithRunner(
  name: string,
  command: string,
  args: string[],
  cwd: string
): Promise<DoctorCheck> {
  try {
    await execa(command, args, {
      cwd,
      stdin: "ignore",
    });
    return {
      detail: "available",
      name,
      passed: true,
    };
  } catch (err) {
    return {
      detail: commandErrorDetail(err),
      name,
      passed: false,
    };
  }
}

function checkPipelineConfig(cwd: string): DoctorCheck {
  try {
    loadPipelineConfig(cwd);
    return {
      detail: "valid",
      name: "pipeline-config",
      passed: true,
    };
  } catch (err) {
    let message = "invalid";
    if (err instanceof PipelineConfigError) {
      message = err.issues.map((issue) => issue.message).join("; ");
    } else if (err instanceof Error) {
      message = err.message;
    }
    return {
      detail: message || "missing or invalid",
      name: "pipeline-config",
      passed: false,
    };
  }
}

async function checkOpenCodeSdk(): Promise<DoctorCheck> {
  try {
    const sdk = await import("@opencode-ai/sdk");
    if (typeof sdk.createOpencodeClient !== "function") {
      return {
        detail: "@opencode-ai/sdk does not export createOpencodeClient",
        name: "opencode-sdk",
        passed: false,
      };
    }
    return {
      detail: "importable",
      name: "opencode-sdk",
      passed: true,
    };
  } catch (err) {
    return {
      detail: commandErrorDetail(err),
      name: "opencode-sdk",
      passed: false,
    };
  }
}

async function checkMokaAgents(
  cwd: string,
  config: PipelineConfig
): Promise<AgentVisibilityResult> {
  const expected = expectedRunAgentNames(config);
  if (expected.length === 0) {
    return {
      check: {
        detail: "no configured MoKa run agents",
        name: "moka-agents",
        passed: true,
      },
    };
  }

  try {
    const result = await execa("opencode", OPENCODE_AGENT_LIST_ARGS, {
      cwd,
      stdin: "ignore",
    });
    const visible = visibleAgentNames(result.stdout);
    if (!visible.recognized) {
      return skippedAgentVisibility(
        "OpenCode agent listing output was not recognized"
      );
    }
    if (
      visible.ambiguous &&
      expected.every((name) => !visible.names.has(name))
    ) {
      return skippedAgentVisibility(
        "OpenCode agent listing output did not include recognizable MoKa agent names"
      );
    }
    const missing = expected.filter((name) => !visible.names.has(name));
    return {
      check: missing.length
        ? {
            detail: `missing configured MoKa agents: ${missing.join(", ")}`,
            name: "moka-agents",
            passed: false,
          }
        : {
            detail: `visible: ${expected.join(", ")}`,
            name: "moka-agents",
            passed: true,
          },
    };
  } catch (err) {
    return skippedAgentVisibility(
      `Could not cheaply list OpenCode agents: ${commandErrorDetail(err)}`
    );
  }
}

function skippedAgentVisibility(detail: string): AgentVisibilityResult {
  return {
    check: {
      detail: "skipped because OpenCode agent listing is unavailable",
      name: "moka-agents",
      passed: true,
    },
    warning: {
      detail,
      name: "moka-agents",
      passed: true,
    },
  };
}

function expectedRunAgentNames(config: PipelineConfig): string[] {
  const profiles = new Set<string>();
  for (const catalog of Object.values(config.scheduler.node_catalogs)) {
    for (const node of Object.values(catalog.nodes)) {
      if (RUN_READINESS_CATEGORIES.has(node.category)) {
        profiles.add(node.profile);
      }
    }
  }
  return [...profiles]
    .filter((profileId) => config.profiles[profileId]?.runner === "opencode")
    .map(opencodeAgentName)
    .sort((a, b) => a.localeCompare(b));
}

function visibleAgentNames(stdout: string): VisibleAgents {
  const names = new Set<string>();
  try {
    const parsed = JSON.parse(stdout);
    return {
      ambiguous: false,
      names,
      recognized: collectAgentNames(parsed, names, Array.isArray(parsed)),
    };
  } catch {
    for (const line of stdout.split(LINE_RE)) {
      const name = line.trim().replace(BULLET_PREFIX_RE, "");
      if (name) {
        names.add(name);
      }
    }
  }
  return { ambiguous: true, names, recognized: names.size > 0 };
}

function collectAgentNames(
  value: unknown,
  names: Set<string>,
  inAgentList: boolean
): boolean {
  if (typeof value === "string") {
    if (inAgentList) {
      names.add(value);
    }
    return inAgentList;
  }
  if (Array.isArray(value)) {
    let recognized = inAgentList;
    for (const item of value) {
      recognized = collectAgentNames(item, names, inAgentList) || recognized;
    }
    return recognized;
  }
  if (!(value && typeof value === "object")) {
    return false;
  }
  const record = value as Record<string, unknown>;
  let recognized = false;
  for (const key of ["agent", "id", "name", "subagent_type", "title"]) {
    if (typeof record[key] === "string") {
      names.add(record[key]);
      recognized = true;
    }
  }
  for (const key of ["agents", "data", "items", "result"]) {
    const item = record[key];
    if (Array.isArray(item) || (item && typeof item === "object")) {
      recognized = collectAgentNames(item, names, true) || recognized;
    }
  }
  return recognized;
}

function headlessPermissionWarnings(cwd: string): DoctorCheck[] {
  if (!isHeadless()) {
    return [];
  }
  const agentDir = join(cwd, ".opencode", "agents");
  if (!existsSync(agentDir)) {
    return [];
  }
  return readdirSync(agentDir)
    .filter((entry) => entry.endsWith(".md"))
    .flatMap((entry) =>
      headlessPermissionWarning(join(agentDir, entry), entry)
    );
}

function headlessPermissionWarning(path: string, entry: string): DoctorCheck[] {
  try {
    if (!statSync(path).isFile()) {
      return [];
    }
    const parsed = matter(readFileSync(path, "utf8"));
    const risky = interactivePermissionPaths(parsed.data.permission);
    if (risky.length === 0) {
      return [];
    }
    return [
      {
        detail: `${entry} requires interactive permission prompts at ${risky.join(", ")}; headless MoKa runs may block.`,
        name: "headless-permissions",
        passed: true,
      },
    ];
  } catch (err) {
    return [
      {
        detail: `Could not inspect ${entry} for headless permission risks: ${commandErrorDetail(err)}`,
        name: "headless-permissions",
        passed: true,
      },
    ];
  }
}

function interactivePermissionPaths(
  value: unknown,
  path: string[] = ["permission"]
): string[] {
  if (typeof value === "string") {
    return HEADLESS_AGENT_PERMISSION_VALUES.has(value.toLowerCase())
      ? [path.join(".")]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      interactivePermissionPaths(item, [...path, String(index)])
    );
  }
  if (!(value && typeof value === "object")) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) => interactivePermissionPaths(item, [...path, key])
  );
}

function isHeadless(): boolean {
  const ci = process.env.CI?.toLowerCase();
  return (
    (ci !== undefined && ci !== "" && ci !== "0" && ci !== "false") ||
    !process.stdin.isTTY
  );
}

function commandErrorDetail(err: unknown): string {
  const error = err as {
    message?: string;
    shortMessage?: string;
    stderr?: string;
  };
  const detail =
    error.shortMessage || error.stderr || error.message || String(err);
  return detail.trim() || "not available";
}
