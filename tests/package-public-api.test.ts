import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const MISSING_CONFIG_AFFORDANCE_RE =
  /tryLoadPipelineConfig|PIPELINE_CONFIG_MISSING|no exported member|not assignable/i;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempConsumerApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-public-api-consumer-"));
  tempDirs.push(dir);

  const scopeDir = join(dir, "node_modules", "@oisincoveney");
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(process.cwd(), join(scopeDir, "pipeline"), "dir");

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2)
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2022",
        },
        include: ["usage.ts"],
      },
      null,
      2
    )
  );

  return dir;
}

function runChecked(
  command: string,
  args: string[],
  options: { cwd: string }
): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const output = error as {
      message?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    throw new Error(
      [output.message, output.stdout?.toString(), output.stderr?.toString()]
        .filter(Boolean)
        .join("\n")
    );
  }
}

function expectCommandToFail(
  command: string,
  args: string[],
  options: { cwd: string }
): string {
  try {
    execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const output = error as {
      message?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    return [
      output.message,
      output.stdout?.toString(),
      output.stderr?.toString(),
    ]
      .filter(Boolean)
      .join("\n");
  }
  throw new Error(`Expected ${command} ${args.join(" ")} to fail`);
}

function packJson(output: string): string {
  const start = output.lastIndexOf("[\n  {");
  if (start === -1) {
    throw new Error(`Expected npm pack JSON output, got:\n${output}`);
  }
  return output.slice(start);
}

describe("package public app-facing API", () => {
  it("does not pack install-managed skills but packs package-owned defaults", () => {
    const output = runChecked("npm", ["pack", "--dry-run", "--json"], {
      cwd: process.cwd(),
    });
    const [{ files }] = JSON.parse(packJson(output)) as [
      { files: Array<{ path: string }> },
    ];
    const packedPaths = files.map((file) => file.path);

    // Skills are install-managed: `moka init` installs them from the skills
    // source into host dirs, so the package must not ship skill bodies.
    expect(packedPaths.some((path) => path.startsWith(".agents/skills/"))).toBe(
      false
    );
    // The package still owns and ships its runtime config defaults.
    expect(packedPaths).toEqual(
      expect.arrayContaining([
        "defaults/pipeline.yaml",
        "defaults/profiles.yaml",
      ])
    );
  }, 30_000);

  it("documents stable app-facing config, planner, and runtime imports", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("@oisincoveney/pipeline/config");
    expect(readme).toContain("@oisincoveney/pipeline/planner");
    expect(readme).toContain("@oisincoveney/pipeline/argo-workflow");
    expect(readme).toContain("@oisincoveney/pipeline/argo-submit");
    expect(readme).toContain("@oisincoveney/pipeline/moka-submit");
    expect(readme).toContain("@oisincoveney/pipeline/runner-command-contract");
    expect(readme).toContain("@oisincoveney/pipeline/runtime");
    expect(readme).toContain("@oisincoveney/pipeline/schedule");
    expect(readme).toContain("@oisincoveney/pipeline/hooks");
    expect(readme).toContain("buildRunnerArgoWorkflowManifest");
    expect(readme).toContain("submitRunnerArgoWorkflow");
    expect(readme).toContain("submitMoka");
    expect(readme).toContain("buildRunnerCommandPayload");
    expect(readme).toContain("loadPipelineConfig");
    expect(readme).toContain("compileWorkflowPlan");
    expect(readme).toContain("compileScheduleArtifact");
    expect(readme).toContain("runPipelineFromConfig");
    expect(readme).toContain("PipelineRuntimeResult");
  });

  it("lets a separate TypeScript app compile type and value imports from public subpaths", () => {
    runChecked("bun", ["run", "build:cli"], {
      cwd: process.cwd(),
    });

    const consumer = tempConsumerApp();
    writeFileSync(
      join(consumer, "usage.ts"),
      `
import {
  PipelineConfigError,
  loadPipelineConfig,
  parsePipelineConfigParts,
  type PipelineConfig,
  type PipelineConfigParts,
  type RunnerType,
  type WorkflowNodeKind,
} from "@oisincoveney/pipeline/config";
import {
  WorkflowPlannerError,
  compileWorkflowPlan,
  type PlannedWorkflowNode,
  type WorkflowExecutionPlan,
} from "@oisincoveney/pipeline/planner";
import {
  formatConfigError,
  runPipelineFromConfig,
  type PipelineTaskContext,
  type PipelineRuntimeEvent,
  type PipelineRuntimeOptions,
  type PipelineRuntimeResult,
} from "@oisincoveney/pipeline/runtime";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
  type ScheduleArtifact,
} from "@oisincoveney/pipeline/schedule";
import {
  buildRunnerCommandPayload,
  parseRunnerCommandPayload,
  runnerCommandPayloadSchema,
  type RunnerCommandPayload,
} from "@oisincoveney/pipeline/runner-command-contract";
import {
  buildRunnerArgoWorkflowManifest,
  runnerArgoWorkflowManifestSchema,
  type ArgoWorkflowManifest,
} from "@oisincoveney/pipeline/argo-workflow";
import {
  defineHook,
  parseHookResult,
  type HookContext,
  type HookResult,
} from "@oisincoveney/pipeline/hooks";
import {
  mokaSubmitDirectHooksSchema,
  mokaSubmitHookPolicySchema,
  mokaSubmitOptionsSchema,
  mokaSubmitResultSchema,
  submitMoka,
  type MokaSubmitDirectHooksInput,
  type MokaSubmitHookPolicyInput,
  type MokaSubmitInput,
  type MokaSubmitOptionsInput,
  type MokaSubmitOptionsOutput,
  type MokaSubmitOutput,
  type MokaSubmitResult,
} from "@oisincoveney/pipeline/moka-submit";
import {
  mokaGlobalConfigSchema,
  parseMokaGlobalConfig,
  type MokaGlobalConfig,
} from "@oisincoveney/pipeline/moka-global-config";

const parts: PipelineConfigParts = {
  pipeline: "version: 1\\ndefault_workflow: smoke\\nworkflows:\\n  smoke:\\n    nodes:\\n      - id: check\\n        kind: command\\n        command: [node, -e, \\"console.log('ok')\\"]\\n",
  profiles: "version: 1\\nprofiles: {}\\n",
  runners: "version: 1\\nrunners:\\n  local:\\n    type: command\\n    command: node\\n    capabilities: { native_subagents: false }\\n",
};

const configWithoutOrchestrator: PipelineConfig = {
  default_workflow: "smoke",
  entrypoints: {},
  hooks: { functions: {}, on: {} },
  mcp_servers: {},
  profiles: {},
  runner_command: {
    environment: { setup: [], smoke: [] },
    git: { committer: { email: "git@example.com", name: "git-bot" } },
  },
  rules: {},
  runners: {},
  scheduler: { commands: {}, node_catalogs: {} },
  schedules: {},
  skills: {},
  token_budget: {
    default_context_window: 200_000,
    fan_out_width: { by_category: {}, default: 4 },
    max_context_pct: 50,
    model_context_windows: {},
  },
  version: 1,
  workflows: {
    smoke: {
      nodes: [
        {
          command: ["node", "-e", "console.log('ok')"],
          id: "check",
          kind: "command",
        },
      ],
    },
  },
};

const config: PipelineConfig = parsePipelineConfigParts(parts, "/tmp/project");
const plan: WorkflowExecutionPlan = compileWorkflowPlan(config, "smoke");
const scheduleArtifact: ScheduleArtifact = parseScheduleArtifact("version: 1\\nkind: pipeline-schedule\\nschedule_id: smoke-a\\nsource_entrypoint: execute\\ntask: consumer compile smoke\\ngenerated_at: 2026-06-03T12:00:00.000Z\\nroot_workflow: root\\nworkflows:\\n  root:\\n    nodes:\\n      - id: check\\n        kind: command\\n        command: [node, -e, \\"console.log('ok')\\"]\\n        task_context:\\n          id: PC-37.2\\n          title: Build API endpoint\\n          description: Build the console API endpoint.\\n          acceptance_criteria:\\n            - id: \\"1\\"\\n              text: Endpoint validates runner events.\\n");
const scheduledPlan: WorkflowExecutionPlan = compileScheduleArtifact(
  config,
  scheduleArtifact
).plan;
const firstNode: PlannedWorkflowNode = plan.topologicalOrder[0];
const runnerType: RunnerType = "command";
const nodeKind: WorkflowNodeKind = firstNode.kind;
const options: PipelineRuntimeOptions = {
  config,
  executor: async () => ({ exitCode: 0, stdout: "ok" }),
  task: "consumer compile smoke",
  workflowId: "smoke",
};
const taskContext: PipelineTaskContext = {
  acceptanceCriteria: [{ id: "AC1", text: "Compiles" }],
  id: "TASK-1",
};
const hook = defineHook((context: HookContext): HookResult => ({
  outputs: { task: context.task },
  status: "pass",
  summary: "typed hook",
}));
const hookResult: HookResult = parseHookResult({
  status: "pass",
  summary: "parsed hook result",
});

const directHooks: MokaSubmitDirectHooksInput = mokaSubmitDirectHooksSchema.parse({
  "node.finish": {
    command: ["node", "scripts/report-node-finish.mjs"],
    failure: "fail",
    input: { source: "public-api-consumer" },
    kind: "command",
    publishResult: true,
    timeoutMs: 5000,
    trusted: true,
  },
});
const hookPolicy: MokaSubmitHookPolicyInput = mokaSubmitHookPolicySchema.parse({
  allowCommandHooks: false,
});
const mokaSubmitInput: MokaSubmitOptionsOutput = mokaSubmitOptionsSchema.parse({
  eventSink: {
    url: "https://console.example/api/pipeline/runner-events",
  },
  hookPolicy,
  hooks: directHooks,
  mode: "quick",
  repository: {
    baseBranch: "main",
    sha: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/oisin-ee/pipeline-runner.git",
  },
  run: {
    id: "run_123",
    project: "pipeline-console",
    requestedBy: "console-user@example.com",
  },
  scheduleYaml: ${JSON.stringify("kind: pipeline-schedule\nversion: 1\nschedule_id: smoke-a\ngenerated_at: 2026-06-03T12:00:00.000Z\nsource_entrypoint: execute\ntask: consumer compile smoke\nroot_workflow: root\nworkflows:\n  root:\n    nodes:\n      - id: check\n        kind: command\n        command: [node, -e, \"console.log('ok')\"]\n")},
  task: {
    id: "PIPE-56",
    kind: "ticket",
    title: "Expose typed Zod moka submit API for Pipeline Console",
  },
  type: "graph",
});
const mokaSubmitOutput: MokaSubmitOutput = mokaSubmitResultSchema.parse({
  namespace: "pipeline-namespace",
  payloadConfigMapName: "payload",
  scheduleConfigMapName: "schedule",
  taskDescriptorConfigMapName: "tasks",
  workflowName: "workflow",
});
const mokaSubmitTypedInput: MokaSubmitInput = {
  ...mokaSubmitInput,
  config,
};
const mokaSubmitRawOptions: MokaSubmitOptionsInput = mokaSubmitInput;
const mokaSubmitResult: MokaSubmitResult = mokaSubmitOutput;
const mokaGlobalConfig: MokaGlobalConfig = parseMokaGlobalConfig(
  ${JSON.stringify("momokaya:\n  kubernetes:\n    kubeconfig: /tmp/cluster.kubeconfig\n    namespace: pipeline-namespace\n  submit:\n    eventAuthSecretKey: EVENT_AUTH_TOKEN_KEY\n    eventAuthSecretName: event-auth-secret\n    eventUrl: https://console.example.test/api/pipeline/runner-events\n    gitCredentialsSecretName: git-credentials-secret\n    githubAuthSecretName: github-auth-secret\n    imagePullSecretName: image-pull-secret\n    serviceAccountName: runner-service-account\n")},
  "/tmp/config.yaml"
);
const result: Promise<PipelineRuntimeResult> = runPipelineFromConfig(options);
const eventType = (event: PipelineRuntimeEvent) => event.type;
const formattedError = formatConfigError(
  new PipelineConfigError("PIPELINE_CONFIG_VALIDATION_ERROR", "invalid")
);
const runnerPayload: RunnerCommandPayload = buildRunnerCommandPayload({
  events: {
    authHeader: "Authorization",
    authTokenFile: "/etc/pipeline/event-auth/token",
    url: "https://console.example/api/pipeline/runner-events",
  },
  repository: {
    baseBranch: "main",
    url: "https://github.com/oisin-ee/pipeline-runner.git",
  },
  run: {
    id: "run_123",
    project: "project_123",
  },
  workflow: {
    id: "workflow_123",
  },
  task: {
    kind: "prompt",
    prompt: "Ship PIPE-42",
  },
});
const parsedPayload: RunnerCommandPayload = parseRunnerCommandPayload(
  JSON.stringify(runnerPayload)
);
runnerCommandPayloadSchema.parse(parsedPayload);
const runnerManifest: ArgoWorkflowManifest = buildRunnerArgoWorkflowManifest({
  generateName: "pipeline-runner-smoke-",
  namespace: "pipeline-namespace",
  plan,
  payloadConfigMapName: "pipeline-runner-payload",
  payloadConfigMapKey: "payload.json",
  scheduleConfigMapName: "pipeline-runner-schedule",
  taskDescriptorConfigMapName: "pipeline-runner-tasks",
});
runnerArgoWorkflowManifestSchema.parse(runnerManifest);

void loadPipelineConfig;
void WorkflowPlannerError;
void result;
void taskContext;
void hook;
void hookResult;
void directHooks;
void hookPolicy;
void mokaSubmitInput;
void mokaSubmitOutput;
void mokaSubmitTypedInput;
void mokaSubmitRawOptions;
void mokaSubmitResult;
void mokaGlobalConfig;
void mokaGlobalConfigSchema;
void submitMoka;
void eventType;
void formattedError;
void runnerType;
void nodeKind;
void scheduledPlan;
void configWithoutOrchestrator;
void parsedPayload;
void runnerManifest;
`,
      "utf8"
    );

    runChecked(
      join(process.cwd(), "node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", "tsconfig.json"],
      {
        cwd: consumer,
      }
    );
  }, 30_000);

  it("does not expose nullable or missing runtime config affordances from the public config API", () => {
    runChecked("bun", ["run", "build:cli"], {
      cwd: process.cwd(),
    });

    const consumer = tempConsumerApp();
    writeFileSync(
      join(consumer, "usage.ts"),
      `
	import { PipelineConfigError, tryLoadPipelineConfig } from "@oisincoveney/pipeline/config";

	void tryLoadPipelineConfig;
	void new PipelineConfigError("PIPELINE_CONFIG_MISSING", "missing");
	`,
      "utf8"
    );

    const output = expectCommandToFail(
      join(process.cwd(), "node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", "tsconfig.json"],
      { cwd: consumer }
    );

    expect(output).toMatch(MISSING_CONFIG_AFFORDANCE_RE);
  }, 30_000);

  it("lets a separate JavaScript app load runtime values from public subpaths after build", () => {
    runChecked("bun", ["run", "build:cli"], {
      cwd: process.cwd(),
    });

    const consumer = tempConsumerApp();
    writeFileSync(
      join(consumer, "runtime-smoke.mjs"),
      `
import { PipelineConfigError, loadPipelineConfig, parsePipelineConfigParts } from "@oisincoveney/pipeline/config";
import { WorkflowPlannerError, compileWorkflowPlan } from "@oisincoveney/pipeline/planner";
import { formatConfigError, runPipelineFromConfig } from "@oisincoveney/pipeline/runtime";
import { compileScheduleArtifact, parseScheduleArtifact } from "@oisincoveney/pipeline/schedule";
import { buildRunnerCommandPayload, parseRunnerCommandPayload, runnerCommandPayloadSchema } from "@oisincoveney/pipeline/runner-command-contract";
import { buildRunnerArgoWorkflowManifest } from "@oisincoveney/pipeline/argo-workflow";
import { defineHook, parseHookResult } from "@oisincoveney/pipeline/hooks";
import { mokaSubmitOptionsSchema, mokaSubmitResultSchema, submitMoka } from "@oisincoveney/pipeline/moka-submit";

const values = [
  PipelineConfigError,
  loadPipelineConfig,
  parsePipelineConfigParts,
  WorkflowPlannerError,
  compileWorkflowPlan,
  compileScheduleArtifact,
  parseScheduleArtifact,
  formatConfigError,
  runPipelineFromConfig,
  buildRunnerCommandPayload,
  parseRunnerCommandPayload,
  buildRunnerArgoWorkflowManifest,
  defineHook,
  parseHookResult,
  submitMoka,
];

if (values.some((value) => typeof value !== "function")) {
  throw new Error("public API subpath did not expose expected runtime values");
}
if (typeof runnerCommandPayloadSchema.parse !== "function") {
  throw new Error("runner command payload schema was not exported");
}
if (typeof mokaSubmitOptionsSchema.parse !== "function") {
  throw new Error("moka submit options schema was not exported");
}
if (typeof mokaSubmitResultSchema.parse !== "function") {
  throw new Error("moka submit result schema was not exported");
}
`,
      "utf8"
    );

    runChecked("node", ["runtime-smoke.mjs"], {
      cwd: consumer,
    });
  }, 30_000);
});
