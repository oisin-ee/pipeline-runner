import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { execa } from "execa";
import matter from "gray-matter";

import {
  defaultClusterDoctorNamespace,
  runClusterDoctor,
} from "../cluster-doctor";
import { loadPipelineConfig, PipelineConfigError } from "../config";
import type { PipelineConfig } from "../config";
import { loadMokaGlobalConfig } from "../moka-global-config";
import { opencodeAgentName } from "../runtime/opencode-agent-name";
import { isRecord } from "../safe-json";

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
const BULLET_PREFIX_RE = /^[-*]\s+/u;
const LINE_RE = /\r?\n/u;

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

const clusterNamespace = (
  value: boolean | string,
  configuredNamespace?: string
): string =>
  typeof value === "string" && value.length > 0
    ? value
    : (configuredNamespace ?? defaultClusterDoctorNamespace());

const checkPipelineConfig = (cwd: string): DoctorCheck => {
  try {
    loadPipelineConfig(cwd);
    return {
      detail: "valid",
      name: "pipeline-config",
      passed: true,
    };
  } catch (error) {
    let message = "invalid";
    if (error instanceof PipelineConfigError) {
      message = error.issues.map((issue) => issue.message).join("; ");
    } else if (error instanceof Error) {
      ({ message } = error);
    }
    return {
      detail: message || "missing or invalid",
      name: "pipeline-config",
      passed: false,
    };
  }
};

const skippedAgentVisibility = (detail: string): AgentVisibilityResult => ({
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
});

const expectedRunAgentNames = (config: PipelineConfig): string[] => {
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
    .toSorted((a, b) => a.localeCompare(b));
};

const collectAgentNames = (
  value: unknown,
  names: Set<string>,
  inAgentList: boolean
): boolean => {
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
  if (!isRecord(value)) {
    return false;
  }
  let recognized = false;
  for (const key of ["agent", "id", "name", "subagent_type", "title"]) {
    if (typeof value[key] === "string") {
      names.add(value[key]);
      recognized = true;
    }
  }
  for (const key of ["agents", "data", "items", "result"]) {
    const item = value[key];
    if (Array.isArray(item) || (typeof item === "object" && item !== null)) {
      recognized = collectAgentNames(item, names, true) || recognized;
    }
  }
  return recognized;
};

const visibleAgentNames = (stdout: string): VisibleAgents => {
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
      if (name !== "") {
        names.add(name);
      }
    }
  }
  return { ambiguous: true, names, recognized: names.size > 0 };
};

const interactivePermissionPaths = (
  value: unknown,
  path: string[] = ["permission"]
): string[] => {
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
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) =>
    interactivePermissionPaths(item, [...path, key])
  );
};

const isHeadless = (): boolean => {
  const ci = process.env.CI?.toLowerCase();
  return (
    (ci !== undefined && ci !== "" && ci !== "0" && ci !== "false") ||
    !process.stdin.isTTY
  );
};

const stringField = (value: unknown, field: string): string => {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" ? candidate : "";
};

const commandErrorDetail = (err: unknown): string => {
  const detail =
    [
      stringField(err, "shortMessage"),
      stringField(err, "stderr"),
      stringField(err, "message"),
      String(err),
    ].find((candidate) => candidate.trim() !== "") ?? "not available";
  return detail.trim();
};

const checkCommandWithRunner = async (
  name: string,
  command: string,
  args: string[],
  cwd: string
): Promise<DoctorCheck> => {
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
  } catch (error) {
    return {
      detail: commandErrorDetail(error),
      name,
      passed: false,
    };
  }
};

const checkCommand = async (
  name: string,
  args: string[],
  cwd: string
): Promise<DoctorCheck> => await checkCommandWithRunner(name, name, args, cwd);

const checkOpenCodeSdk = async (): Promise<DoctorCheck> => {
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
  } catch (error) {
    return {
      detail: commandErrorDetail(error),
      name: "opencode-sdk",
      passed: false,
    };
  }
};

const checkMokaAgents = async (
  cwd: string,
  config: PipelineConfig
): Promise<AgentVisibilityResult> => {
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
  } catch (error) {
    return skippedAgentVisibility(
      `Could not cheaply list OpenCode agents: ${commandErrorDetail(error)}`
    );
  }
};

const headlessPermissionWarning = (
  path: string,
  entry: string
): DoctorCheck[] => {
  try {
    if (!statSync(path).isFile()) {
      return [];
    }
    const parsed = matter(readFileSync(path, "utf-8"));
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
  } catch (error) {
    return [
      {
        detail: `Could not inspect ${entry} for headless permission risks: ${commandErrorDetail(error)}`,
        name: "headless-permissions",
        passed: true,
      },
    ];
  }
};

const headlessPermissionWarnings = (cwd: string): DoctorCheck[] => {
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
};

export const runDoctor = async (
  cwd: string,
  options: DoctorFlags = {}
): Promise<DoctorResult> => {
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
  const clusterResult =
    options.cluster !== undefined && options.cluster !== false
      ? await runClusterDoctor({
          kubeContext: options.kubeContext,
          kubeconfigPath:
            options.kubeconfig ??
            (globalConfig === null
              ? undefined
              : globalConfig.momokaya.kubernetes.kubeconfig),
          namespace: clusterNamespace(
            options.cluster,
            globalConfig === null
              ? undefined
              : globalConfig.momokaya.kubernetes.namespace
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
};
