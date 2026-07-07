import { afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { execa } from "execa";

import { parseWithSchema, struct } from "../src/schema-boundary";

const tempDirs: string[] = [];
const MISSING_CONFIG_AFFORDANCE_RE =
  /tryLoadPipelineConfig|PIPELINE_CONFIG_MISSING|no exported member|not assignable/iu;
const packageExportSchema = struct({
  import: Schema.String,
  types: Schema.String,
});
const packageJsonSchema = struct({
  bin: Schema.Record(Schema.String, Schema.String),
  exports: Schema.Record(Schema.String, packageExportSchema),
});
const rootPackageManagerSchema = struct({
  packageManager: Schema.String,
});
const packOutput = Schema.Tuple([
  struct({
    filename: Schema.String,
  }),
]);
const packDryRunOutput = Schema.Tuple([
  struct({
    files: Schema.mutable(
      Schema.Array(
        struct({
          path: Schema.String,
        })
      )
    ),
  }),
]);
const unknownJsonString = Schema.fromJsonString(Schema.Unknown);
const EXPECTED_PUBLIC_EXPORTS = {
  ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
  "./argo-submit": {
    import: "./dist/argo-submit.js",
    types: "./dist/argo-submit.d.ts",
  },
  "./argo-workflow": {
    import: "./dist/argo-workflow.js",
    types: "./dist/argo-workflow.d.ts",
  },
  "./config": { import: "./dist/config.js", types: "./dist/config.d.ts" },
  "./events": {
    import: "./dist/runner-event-schema.js",
    types: "./dist/runner-event-schema.d.ts",
  },
  "./factory-lane": {
    import: "./dist/factory-lane.js",
    types: "./dist/factory-lane.d.ts",
  },
  "./hooks": { import: "./dist/hooks.js", types: "./dist/hooks.d.ts" },
  "./moka-global-config": {
    import: "./dist/moka-global-config.js",
    types: "./dist/moka-global-config.d.ts",
  },
  "./moka-submit": {
    import: "./dist/moka-submit.js",
    types: "./dist/moka-submit.d.ts",
  },
  "./planner": {
    import: "./dist/planning/compile.js",
    types: "./dist/planning/compile.d.ts",
  },
  "./runner": { import: "./dist/runner.js", types: "./dist/runner.d.ts" },
  "./runner-command-contract": {
    import: "./dist/runner-command-contract.js",
    types: "./dist/runner-command-contract.d.ts",
  },
  "./runtime": {
    import: "./dist/pipeline-runtime.js",
    types: "./dist/pipeline-runtime.d.ts",
  },
  "./schedule": {
    import: "./dist/planning/generate.js",
    types: "./dist/planning/generate.d.ts",
  },
  "./tickets": {
    import: "./dist/tickets/ticket-graph-dto.js",
    types: "./dist/tickets/ticket-graph-dto.d.ts",
  },
} as const;

let joinPath: (...paths: string[]) => string;

beforeAll(async () => {
  const { join } = await import("node:path");
  joinPath = join;
});

const readText = async (path: string): Promise<string> => {
  const { readFile } = await import("node:fs/promises");
  return await readFile(path, "utf-8");
};

const writeText = async (path: string, content: string): Promise<void> => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf-8");
};

const copyFile = async (source: string, target: string): Promise<void> => {
  const { copyFile: copy } = await import("node:fs/promises");
  await copy(source, target);
};

const removePath = async (path: string): Promise<void> => {
  const { rm } = await import("node:fs/promises");
  await rm(path, { force: true, recursive: true });
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removePath));
});

const makeTempDir = async (prefix: string): Promise<string> => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  return await mkdtemp(join(tmpdir(), prefix));
};

const encodeJson = (value: unknown): string =>
  Schema.encodeUnknownSync(unknownJsonString)(value);

const jsonStringLiteral = (value: string): string =>
  Schema.encodeUnknownSync(Schema.fromJsonString(Schema.String))(value);

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeText(path, `${encodeJson(value)}\n`);
};

const parseJsonWithSchema = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string
): S["Type"] => parseWithSchema(Schema.fromJsonString(schema), source);

const runChecked = async (
  command: string,
  args: string[],
  options: { cwd: string }
): Promise<string> => {
  const result = await execa(command, args, { cwd: options.cwd });
  return result.stdout;
};

const tempConsumerApp = async (): Promise<string> => {
  const dir = await makeTempDir("pipeline-public-api-consumer-");
  tempDirs.push(dir);
  const [{ filename }] = parseJsonWithSchema(
    packOutput,
    await runChecked(
      "nub",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", dir],
      { cwd: process.cwd() }
    )
  );
  const { packageManager } = parseJsonWithSchema(
    rootPackageManagerSchema,
    await readText(joinPath(process.cwd(), "package.json"))
  );
  await copyFile(joinPath(process.cwd(), ".npmrc"), joinPath(dir, ".npmrc"));

  await writeJson(joinPath(dir, "package.json"), {
    dependencies: {
      "@oisincoveney/pipeline": `file:${filename}`,
    },
    packageManager,
    private: true,
    type: "module",
  });
  await writeJson(joinPath(dir, "tsconfig.json"), {
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      // effect@4 beta declarations currently fail lib checking via
      // node_modules/effect/dist/internal/schema/schema.d.ts (`SchemaErrorTypeId`).
      // This fixture validates our exported subpaths, not upstream package internals.
      skipLibCheck: true,
      strict: true,
      target: "ES2022",
    },
    include: ["usage.ts"],
  });
  await runChecked(
    "nub",
    [
      "install",
      "--ignore-scripts",
      "--no-frozen-lockfile",
      "--node-linker",
      "hoisted",
    ],
    {
      cwd: dir,
    }
  );

  return dir;
};

const expectCommandToFail = async (
  command: string,
  args: string[],
  options: { cwd: string }
): Promise<string> => {
  const result = await execa(command, args, {
    cwd: options.cwd,
    reject: false,
  });
  expect(result.exitCode).not.toBe(0);
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
};

const packJson = (output: string): string => {
  const start = output.lastIndexOf("[\n  {");
  expect(start).not.toBe(-1);
  return output.slice(start);
};

describe("package public app-facing API", () => {
  it("pins the package export map and CLI bin surface before structural cleanup", async () => {
    const packageJson = parseJsonWithSchema(
      packageJsonSchema,
      await readText(joinPath(process.cwd(), "package.json"))
    );

    expect(packageJson.bin).toEqual({ moka: "dist/index.js" });
    expect(packageJson.exports).toEqual(EXPECTED_PUBLIC_EXPORTS);
  });

  it("does not pack install-managed skills but packs package-owned defaults", async () => {
    const output = await runChecked("npm", ["pack", "--dry-run", "--json"], {
      cwd: process.cwd(),
    });
    const [{ files }] = parseJsonWithSchema(packDryRunOutput, packJson(output));
    const packedPaths = files.map((file) => file.path);

    // Skills are installed by the shared agent harness into host dirs, so the
    // package must not ship skill bodies.
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

  it("documents stable app-facing config, planner, and runtime imports", async () => {
    const readme = await readText(joinPath(process.cwd(), "README.md"));

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

  it("lets a separate TypeScript app compile type and value imports from public subpaths", async () => {
    await runChecked("nub", ["run", "build:cli"], {
      cwd: process.cwd(),
    });

    const consumer = await tempConsumerApp();
    await writeText(
      joinPath(consumer, "usage.ts"),
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
import type {
  SubmitDynamicRunnerArgoWorkflowOptions,
  SubmitRunnerArgoWorkflowOptions,
} from "@oisincoveney/pipeline/argo-submit";
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
import { Schema } from "effect";

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
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const directHooks: MokaSubmitDirectHooksInput = Schema.decodeUnknownSync(mokaSubmitDirectHooksSchema)({
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
const hookPolicy: MokaSubmitHookPolicyInput = Schema.decodeUnknownSync(mokaSubmitHookPolicySchema)({
  allowCommandHooks: false,
});
const mokaSubmitInput: MokaSubmitOptionsOutput = Schema.decodeUnknownSync(mokaSubmitOptionsSchema)({
  activeDeadlineSeconds: 3600,
  brokerAuth: {
    secretName: "broker-api-key",
  },
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
  podGC: {
    deleteDelayDuration: "30s",
    strategy: "OnPodSuccess",
  },
  scheduleYaml: ${jsonStringLiteral("kind: pipeline-schedule\nversion: 1\nschedule_id: smoke-a\ngenerated_at: 2026-06-03T12:00:00.000Z\nsource_entrypoint: execute\ntask: consumer compile smoke\nroot_workflow: root\nworkflows:\n  root:\n    nodes:\n      - id: check\n        kind: command\n        command: [node, -e, \"console.log('ok')\"]\n")},
  task: {
    id: "PIPE-56",
    kind: "ticket",
    title: "Expose typed Zod moka submit API for Pipeline Console",
  },
  type: "graph",
  ttlStrategy: {
    secondsAfterFailure: 604_800,
    secondsAfterSuccess: 300,
  },
});
const mokaSubmitOutput: MokaSubmitOutput = Schema.decodeUnknownSync(mokaSubmitResultSchema)({
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
  ${jsonStringLiteral("momokaya:\n  kubernetes:\n    kubeconfig: /tmp/cluster.kubeconfig\n    namespace: pipeline-namespace\n  submit:\n    brokerAuth:\n      secretName: broker-api-key\n    eventAuthSecretKey: EVENT_AUTH_TOKEN_KEY\n    eventAuthSecretName: event-auth-secret\n    eventUrl: https://console.example.test/api/pipeline/runner-events\n    gitCredentialsSecretName: git-credentials-secret\n    githubAuthSecretName: github-auth-secret\n    imagePullSecretName: image-pull-secret\n    serviceAccountName: runner-service-account\n")},
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
  encodeUnknownJson(runnerPayload)
);
Schema.decodeUnknownSync(runnerCommandPayloadSchema)(parsedPayload);
const runnerManifest: ArgoWorkflowManifest = buildRunnerArgoWorkflowManifest({
  brokerAuth: {
    secretName: "broker-api-key",
  },
  generateName: "pipeline-runner-smoke-",
  namespace: "pipeline-namespace",
  plan,
  payloadConfigMapName: "pipeline-runner-payload",
  payloadConfigMapKey: "payload.json",
  scheduleConfigMapName: "pipeline-runner-schedule",
  taskDescriptorConfigMapName: "pipeline-runner-tasks",
});
Schema.decodeUnknownSync(runnerArgoWorkflowManifestSchema)(runnerManifest);
const staticSubmitOptions: SubmitRunnerArgoWorkflowOptions = {
  activeDeadlineSeconds: 3600,
  brokerAuth: { secretName: "broker-api-key" },
  config,
  generateName: "pipeline-runner-smoke-",
  namespace: "pipeline-namespace",
  payloadJson: encodeUnknownJson(runnerPayload),
  podGC: {
    deleteDelayDuration: "30s",
    strategy: "OnPodSuccess",
  },
  scheduleYaml: ${jsonStringLiteral("kind: pipeline-schedule\nversion: 1\nschedule_id: smoke-a\ngenerated_at: 2026-06-03T12:00:00.000Z\nsource_entrypoint: execute\ntask: consumer compile smoke\nroot_workflow: root\nworkflows:\n  root:\n    nodes:\n      - id: check\n        kind: command\n        command: [node, -e, \"console.log('ok')\"]\n")},
  ttlStrategy: {
    secondsAfterFailure: 604_800,
    secondsAfterSuccess: 300,
  },
};
const dynamicSubmitOptions: SubmitDynamicRunnerArgoWorkflowOptions = {
  activeDeadlineSeconds: 3600,
  brokerAuth: { secretName: "broker-api-key" },
  config,
  generateName: "pipeline-runner-smoke-",
  namespace: "pipeline-namespace",
  payloadJson: encodeUnknownJson(runnerPayload),
  podGC: {
    deleteDelayDuration: "30s",
    strategy: "OnPodSuccess",
  },
  ttlStrategy: {
    secondsAfterFailure: 604_800,
    secondsAfterSuccess: 300,
  },
  workflowId: "schedule-smoke-a-root",
};

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
void staticSubmitOptions;
void dynamicSubmitOptions;
`
    );

    await runChecked(
      joinPath(process.cwd(), "node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", "tsconfig.json"],
      {
        cwd: consumer,
      }
    );
  }, 30_000);

  it("does not expose nullable or missing runtime config affordances from the public config API", async () => {
    await runChecked("nub", ["run", "build:cli"], {
      cwd: process.cwd(),
    });

    const consumer = await tempConsumerApp();
    await writeText(
      joinPath(consumer, "usage.ts"),
      `
	import { PipelineConfigError, tryLoadPipelineConfig } from "@oisincoveney/pipeline/config";

	void tryLoadPipelineConfig;
	void new PipelineConfigError("PIPELINE_CONFIG_MISSING", "missing");
	`
    );

    const output = await expectCommandToFail(
      joinPath(process.cwd(), "node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", "tsconfig.json"],
      { cwd: consumer }
    );

    expect(output).toMatch(MISSING_CONFIG_AFFORDANCE_RE);
  }, 30_000);

  it("lets a separate JavaScript app load runtime values from public subpaths after build", async () => {
    await runChecked("nub", ["run", "build:cli"], {
      cwd: process.cwd(),
    });

    const consumer = await tempConsumerApp();
    await writeText(
      joinPath(consumer, "runtime-smoke.mjs"),
      `
import { PipelineConfigError, loadPipelineConfig, parsePipelineConfigParts } from "@oisincoveney/pipeline/config";
import { WorkflowPlannerError, compileWorkflowPlan } from "@oisincoveney/pipeline/planner";
import { formatConfigError, runPipelineFromConfig } from "@oisincoveney/pipeline/runtime";
import { compileScheduleArtifact, parseScheduleArtifact } from "@oisincoveney/pipeline/schedule";
import { buildRunnerCommandPayload, parseRunnerCommandPayload, runnerCommandPayloadSchema } from "@oisincoveney/pipeline/runner-command-contract";
import { buildRunnerArgoWorkflowManifest } from "@oisincoveney/pipeline/argo-workflow";
import { defineHook, parseHookResult } from "@oisincoveney/pipeline/hooks";
import { mokaSubmitOptionsSchema, mokaSubmitResultSchema, submitMoka } from "@oisincoveney/pipeline/moka-submit";
import { Schema } from "effect";

class PublicApiSmokeError extends Error {}

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
  throw new PublicApiSmokeError("public API subpath did not expose expected runtime values");
}
if (typeof Schema.decodeUnknownSync(runnerCommandPayloadSchema) !== "function") {
  throw new PublicApiSmokeError("runner command payload schema was not exported");
}
if (typeof Schema.decodeUnknownSync(mokaSubmitOptionsSchema) !== "function") {
  throw new PublicApiSmokeError("moka submit options schema was not exported");
}
if (typeof Schema.decodeUnknownSync(mokaSubmitResultSchema) !== "function") {
  throw new PublicApiSmokeError("moka submit result schema was not exported");
}
`
    );

    await runChecked("node", ["runtime-smoke.mjs"], {
      cwd: consumer,
    });
  }, 30_000);
});
