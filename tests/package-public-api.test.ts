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

describe("package public app-facing API", () => {
  it("documents stable app-facing config, planner, and runtime imports", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("@oisincoveney/pipeline/config");
    expect(readme).toContain("@oisincoveney/pipeline/planner");
    expect(readme).toContain("@oisincoveney/pipeline/runner-job-contract");
    expect(readme).toContain("@oisincoveney/pipeline/runtime");
    expect(readme).toContain("@oisincoveney/pipeline/schedule");
    expect(readme).toContain("@oisincoveney/pipeline/hooks");
    expect(readme).toContain("buildRunnerJobPayload");
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
  RUNNER_JOB_CONTRACT_VERSION,
  buildRunnerJobPayload,
  parseRunnerJobPayload,
  type RunnerJobPayload,
} from "@oisincoveney/pipeline/runner-job-contract";
import {
  defineHook,
  parseHookResult,
  type HookContext,
  type HookResult,
} from "@oisincoveney/pipeline/hooks";

const parts: PipelineConfigParts = {
  pipeline: "version: 1\\ndefault_workflow: smoke\\norchestrator: { profile: orchestrator }\\nworkflows:\\n  smoke:\\n    nodes:\\n      - id: check\\n        kind: command\\n        command: [node, -e, \\"console.log('ok')\\"]\\n",
  profiles: "version: 1\\nprofiles:\\n  orchestrator:\\n    runner: local\\n    instructions: { inline: Coordinate the smoke workflow. }\\n",
  runners: "version: 1\\nrunners:\\n  local:\\n    type: command\\n    command: node\\n    capabilities: { native_subagents: false }\\n",
};

const config: PipelineConfig = parsePipelineConfigParts(parts, "/tmp/project");
const plan: WorkflowExecutionPlan = compileWorkflowPlan(config, "smoke");
const scheduleArtifact: ScheduleArtifact = parseScheduleArtifact("version: 1\\nkind: pipeline-schedule\\nschedule_id: smoke-a\\nsource_entrypoint: pipe\\ntask: consumer compile smoke\\ngenerated_at: 2026-06-03T12:00:00.000Z\\nroot_workflow: root\\nworkflows:\\n  root:\\n    nodes:\\n      - id: check\\n        kind: command\\n        command: [node, -e, \\"console.log('ok')\\"]\\n        task_context:\\n          id: PC-37.2\\n          title: Build API endpoint\\n          description: Build the console API endpoint.\\n          acceptance_criteria:\\n            - id: \\"1\\"\\n              text: Endpoint validates runner events.\\n");
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
const result: Promise<PipelineRuntimeResult> = runPipelineFromConfig(options);
const eventType = (event: PipelineRuntimeEvent) => event.type;
const formattedError = formatConfigError(
  new PipelineConfigError("PIPELINE_CONFIG_MISSING", "missing")
);
const runnerPayload: RunnerJobPayload = buildRunnerJobPayload({
  eventSink: {
    authHeader: "Authorization",
    url: "https://console.example.test/api/pipeline/runner-events",
  },
  run: {
    projectId: "project_123",
    runId: "run_123",
  },
  task: {
    prompt: "Ship PIPE-42",
    taskId: "PIPE-42",
  },
  workflowId: "default",
});
const parsedPayload: RunnerJobPayload = parseRunnerJobPayload(
  JSON.stringify(runnerPayload)
);

void loadPipelineConfig;
void WorkflowPlannerError;
void result;
void taskContext;
void hook;
void hookResult;
void eventType;
void formattedError;
void runnerType;
void nodeKind;
void scheduledPlan;
void RUNNER_JOB_CONTRACT_VERSION;
void parsedPayload;
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
import { RUNNER_JOB_CONTRACT_VERSION, buildRunnerJobPayload, parseRunnerJobPayload } from "@oisincoveney/pipeline/runner-job-contract";
import { defineHook, parseHookResult } from "@oisincoveney/pipeline/hooks";

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
  buildRunnerJobPayload,
  parseRunnerJobPayload,
  defineHook,
  parseHookResult,
];

if (values.some((value) => typeof value !== "function")) {
  throw new Error("public API subpath did not expose expected runtime values");
}
if (typeof RUNNER_JOB_CONTRACT_VERSION !== "string") {
  throw new Error("runner job contract version was not exported");
}
`,
      "utf8"
    );

    runChecked("node", ["runtime-smoke.mjs"], {
      cwd: consumer,
    });
  }, 30_000);
});
