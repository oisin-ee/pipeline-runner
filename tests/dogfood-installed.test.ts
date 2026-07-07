import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPipelineConfig, parsePipelineConfigParts } from "../src/config";
import type { PipelineConfig } from "../src/config";
import { installCommands } from "../src/install-commands";
import { runPipelineFromConfig } from "../src/pipeline-runtime";
import { compileWorkflowPlan } from "../src/planning/compile";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
} from "../src/planning/generate";
import { createRunnerLaunchPlan } from "../src/runner";
import {
  createGoalContinuationLaunchPlan,
  runBoundedGoalLoop,
} from "../src/runtime/goal-loop/goal-loop";
import {
  applyGoalStateEvent,
  createGoalState,
  loadGoalStateFromRunDirectory,
  recordGoalStateChangedFiles,
  saveGoalState,
} from "../src/runtime/goal-state/goal-state";

const tempDirs: string[] = [];
const RUNNER_ORCHESTRATOR_METADATA_RE = /runner orchestrator metadata/iu;

class DogfoodInstalledTestError extends Schema.TaggedErrorClass<DogfoodInstalledTestError>()(
  "DogfoodInstalledTestError",
  {
    message: Schema.String,
  }
) {}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const tempProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-installed-dogfood-"));
  tempDirs.push(dir);
  return dir;
};

const writeProjectFile = (
  root: string,
  path: string,
  content: string
): void => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const loadFixturePipelineConfig = (project: string): PipelineConfig =>
  parsePipelineConfigParts(
    {
      pipeline: readFileSync(join(project, ".pipeline/pipeline.yaml"), "utf-8"),
      profiles: readFileSync(join(project, ".pipeline/profiles.yaml"), "utf-8"),
      runners: readFileSync(join(project, ".pipeline/runners.yaml"), "utf-8"),
    },
    project
  );

const cliSourcePath = (): string => join(process.cwd(), "src/index.ts");

const writeBacklogTask = (
  root: string,
  id: string,
  title: string,
  body: string,
  options: { dependencies?: string[]; parentTaskId?: string } = {}
): void => {
  const parentTaskId =
    options.parentTaskId ?? (id.includes(".") ? "PC-37" : "");
  const dependencies =
    options.dependencies && options.dependencies.length > 0
      ? `dependencies:\n${options.dependencies.map((dep) => `  - ${dep}`).join("\n")}\n`
      : "";
  writeProjectFile(
    root,
    `backlog/tasks/${id.toLowerCase()} - task.md`,
    `---\nid: ${id}\ntitle: ${title}\nparent_task_id: ${parentTaskId}\n${dependencies}---\n\n${body}`
  );
};

const writePc37BacklogFixture = (root: string): void => {
  writeBacklogTask(
    root,
    "PC-37",
    "Pipeline console rollout",
    "## Description\n\nParent epic.",
    { parentTaskId: "" }
  );
  writeBacklogTask(
    root,
    "PC-37.1",
    "Define runner contract",
    "## Description\n\nDefine the runner contract."
  );
  writeBacklogTask(
    root,
    "PC-37.2",
    "Build API endpoint",
    "## Description\n\nBuild the API endpoint.",
    {
      dependencies: ["PC-37.1"],
    }
  );
  writeBacklogTask(
    root,
    "PC-37.3",
    "Build console view",
    "## Description\n\nBuild the console view.",
    {
      dependencies: ["PC-37.1"],
    }
  );
  writeBacklogTask(
    root,
    "PC-37.4",
    "Wire Kubernetes job",
    "## Description\n\nWire Kubernetes job launch."
  );
  writeBacklogTask(
    root,
    "PC-37.5",
    "Document rollout",
    "## Description\n\nDocument rollout steps."
  );
  writeBacklogTask(
    root,
    "PC-37.6",
    "Verify rollout",
    "## Description\n\nVerify the rollout.",
    {
      dependencies: ["PC-37.2", "PC-37.3", "PC-37.4", "PC-37.5"],
    }
  );
};

const writeDogfoodProject = (root: string): void => {
  writeProjectFile(
    root,
    "package.json",
    JSON.stringify({
      scripts: {
        test: "node -e \"console.log('dogfood tests pass')\"",
        typecheck: "node -e \"console.log('dogfood typecheck passes')\"",
      },
    })
  );
  writeProjectFile(
    root,
    ".pipeline/schemas/dogfood.schema.json",
    readFileSync(".pipeline/schemas/dogfood.schema.json", "utf-8")
  );
  writeProjectFile(
    root,
    ".pipeline/runners.yaml",
    `
version: 1
runners:
  artifact-command:
    type: command
    command: node
    args:
      - -e
      - "const fs=require('node:fs'); fs.mkdirSync('.pipeline/dogfood',{recursive:true}); const out={verdict:'PASS',evidence:['artifact written']}; fs.writeFileSync('.pipeline/dogfood/artifact.json', JSON.stringify(out)); console.log(JSON.stringify(out));"
    capabilities:
      native_subagents: false
      rules: true
      skills: true
      mcp_servers: true
      tools: [bash]
      output_formats: [text, json, json_schema]
      filesystem: [workspace-write]
      network: [disabled]
`
  );
  writeProjectFile(
    root,
    ".pipeline/profiles.yaml",
    `
version: 1
rules:
  orchestrator-rule:
    path: .pipeline/rules/orchestrator.md
skills:
  orchestrator-skill:
    path: .agents/skills/orchestrator/SKILL.md
mcp_gateway:
  provider: toolhive
  mode: local
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
profiles:
  orchestrator:
    runner: artifact-command
    model: dogfood-orchestrator-model
    instructions: { inline: Coordinate deterministic dogfood. }
    rules: [orchestrator-rule]
    skills: [orchestrator-skill]
    mcp_servers: [pipeline-gateway]
    tools: [bash]
    filesystem: { mode: workspace-write }
    network: { mode: disabled }
  artifact-writer:
    runner: artifact-command
    instructions: { inline: Write the deterministic artifact. }
    filesystem: { mode: workspace-write }
    network: { mode: disabled }
    output:
      format: json_schema
      schema_path: .pipeline/schemas/dogfood.schema.json
`
  );
  writeProjectFile(
    root,
    ".pipeline/pipeline.yaml",
    `
version: 1
default_workflow: dogfood-options
hooks:
  functions:
    workflow-start:
      kind: command
      command: [node, -e, "const fs=require('node:fs'); fs.mkdirSync('.pipeline/dogfood',{recursive:true}); fs.appendFileSync('.pipeline/dogfood/hooks.log', 'workflow.start\\\\n'); fs.writeFileSync(process.env.PIPELINE_HOOK_RESULT, JSON.stringify({status:'pass',summary:'workflow start'}));"]
      trusted: true
    node-start:
      kind: command
      command: [node, -e, "const fs=require('node:fs'); const input=JSON.parse(fs.readFileSync(process.env.PIPELINE_HOOK_INPUT,'utf8')); fs.mkdirSync('.pipeline/dogfood',{recursive:true}); fs.appendFileSync('.pipeline/dogfood/hooks.log', 'node.start ' + input.node.id + '\\\\n'); fs.writeFileSync(process.env.PIPELINE_HOOK_RESULT, JSON.stringify({status:'pass',summary:'node start'}));"]
      trusted: true
    optional-failure:
      kind: command
      command: [node, -e, "process.exit(9)"]
      trusted: true
  on:
    workflow.start:
      - id: workflow-start
        function: workflow-start
        failure: fail
    node.start:
      - id: node-start
        function: node-start
        where: { node: artifact }
        failure: fail
    workflow.complete:
      - id: optional-failure
        function: optional-failure
        failure: ignore
orchestrator:
  profile: orchestrator
workflows:
  dogfood-options:
    nodes:
      - id: artifact
        kind: agent
        profile: artifact-writer
        artifacts:
          - path: .pipeline/dogfood/artifact.json
        gates:
          - id: artifact-schema
            kind: json_schema
            target: artifact
            path: .pipeline/dogfood/artifact.json
            schema_path: .pipeline/schemas/dogfood.schema.json
          - id: expected-nonzero
            kind: command
            command: [node, -e, "process.exit(3)"]
            expect_exit_code: 3
      - id: retry-gate
        kind: command
        command: [node, -e, "console.log('retry node ran')"]
        retries: { max_attempts: 2 }
        gates:
          - id: flaky-once
            kind: command
            command: [node, -e, "const fs=require('node:fs'); const p='.pipeline/dogfood/retry-count'; let n=0; try{n=Number(fs.readFileSync(p,'utf8'))}catch{}; fs.writeFileSync(p,String(n+1)); process.exit(n === 0 ? 1 : 0);"]
        needs: [artifact]
      - id: parallel-left
        kind: builtin
        builtin: typecheck
        needs: [retry-gate]
      - id: parallel-right
        kind: builtin
        builtin: test
        needs: [retry-gate]
      - id: join
        kind: group
        nodes: [parallel-left, parallel-right]
        needs: [parallel-left, parallel-right]
`
  );
  writeProjectFile(root, ".pipeline/rules/orchestrator.md", "# Dogfood rule\n");
  writeProjectFile(
    root,
    ".agents/skills/orchestrator/SKILL.md",
    "# Dogfood orchestrator skill\n"
  );
};

const workflowProfileIds = (config: PipelineConfig) =>
  [
    ...new Set(
      Object.values(config.workflows).flatMap((workflow) =>
        workflow.nodes.flatMap((node) =>
          node.kind === "agent" && node.profile ? [node.profile] : []
        )
      )
    ),
  ].toSorted();

const entrypointCommandSurfaces = (config: PipelineConfig) =>
  Object.entries(config.entrypoints).map(([entrypointId, entrypoint]) => ({
    invocation: `/moka-${entrypointId} <task description>`,
    path: `.opencode/commands/moka-${entrypointId}.md`,
    targetId:
      "workflow" in entrypoint ? entrypoint.workflow : entrypoint.schedule,
  }));

const opencodeAgentNamePart = (part: string): string => {
  if (part === "opencode") {
    return "OpenCode";
  }
  return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
};

const opencodeAgentName = (profileId: string): string => {
  if (!profileId.startsWith("moka-")) {
    return profileId;
  }
  return `MoKa ${profileId.slice("moka-".length).split("-").map(opencodeAgentNamePart).join(" ")}`;
};

const nativeAgentPathFor = (
  runner: string,
  profileId: string
): Option.Option<string> => {
  if (runner === "opencode") {
    return Option.some(`.opencode/agents/${opencodeAgentName(profileId)}.md`);
  }
  return Option.none();
};

const flattenDogfoodNodes = (
  nodes: PipelineConfig["workflows"][string]["nodes"]
): PipelineConfig["workflows"][string]["nodes"] =>
  nodes.flatMap((node) =>
    node.kind === "parallel"
      ? [node, ...flattenDogfoodNodes(node.nodes)]
      : [node]
  );

const configuredDogfoodOrchestrator = (project: string) => {
  const config = loadFixturePipelineConfig(project);
  if (!config.orchestrator) {
    throw new DogfoodInstalledTestError({
      message: "Expected dogfood fixture to configure an orchestrator",
    });
  }
  const profile = config.profiles[config.orchestrator.profile];
  return {
    hooks: Object.keys(config.hooks.functions),
    mcp_servers: profile.mcp_servers,
    model: profile.model,
    rules: profile.rules,
    skills: profile.skills,
    tools: profile.tools,
  };
};

describe("installed dogfood configuration", () => {
  it("keeps installed YAML workflows valid and explainable", () => {
    const config = loadPipelineConfig(process.cwd(), {
      allowMissingLintFileReferences: true,
    });

    expect(
      compileWorkflowPlan(config, "inspect").topologicalOrder.map(
        (node) => node.id
      )
    ).toEqual(["inspect"]);
    expect(config.workflows.default).toBeUndefined();
    expect(config.workflows["epic-drain"]).toBeUndefined();
  });

  it("does not expose runner orchestrator metadata in installed moka submit help", () => {
    const result = spawnSync("nub", [cliSourcePath(), "submit", "--help"], {
      encoding: "utf-8",
    });
    const help = `${result.stdout}\n${result.stderr}`;

    expect(result.status, help).toBe(0);
    expect(help).not.toContain("--orchestrator");
    expect(help).not.toMatch(RUNNER_ORCHESTRATOR_METADATA_RE);
  });

  it("exposes loop and ticket graph schemas from built public subpaths", () => {
    const build = spawnSync("nub", ["run", "build:cli"], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

    const consumer = tempProject();
    mkdirSync(join(consumer, "node_modules", "@oisincoveney"), {
      recursive: true,
    });
    symlinkSync(
      process.cwd(),
      join(consumer, "node_modules", "@oisincoveney", "pipeline")
    );
    symlinkSync(
      join(process.cwd(), "node_modules", "effect"),
      join(consumer, "node_modules", "effect")
    );
    writeProjectFile(
      consumer,
      "schema-import-smoke.mjs",
      `
import {
  loopStateSchema,
  ticketGraphDtoSchema,
} from "@oisincoveney/pipeline/tickets";
import * as Schema from "effect/Schema";

if (Schema.decodeUnknownSync(loopStateSchema)("queued") !== "queued") {
  throw new Error("loopStateSchema decode failed");
}
Schema.decodeUnknownSync(ticketGraphDtoSchema)({
  batches: [["PIPE-1"]],
  dangling: [],
  edges: [],
  nodes: [{ id: "PIPE-1", loopState: "queued", status: "To Do", title: "One" }],
});
`
    );

    const result = spawnSync("node", ["schema-import-smoke.mjs"], {
      cwd: consumer,
      encoding: "utf-8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("keeps installed host resources aligned with package defaults and agent grants", async () => {
    const root = tempProject();
    // Redirect per-machine host dirs into `root` so installed files are
    // testable with resolveHarnessTarget, and the real ~/.config/opencode etc.
    // are never touched.
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, ".claude"));
    vi.stubEnv("CODEX_HOME", join(root, ".codex"));
    vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, ".opencode"));
    vi.stubEnv("GEMINI_CONFIG_DIR", join(root, ".gemini"));
    try {
      const { resolveHarnessTarget } =
        await import("../src/install-commands/shared");
      await installCommands({
        cwd: root,
        force: true,
        host: "all",
      });
      const config = loadPipelineConfig(root, {
        allowMissingLintFileReferences: true,
      });

      expect(config.orchestrator).toEqual({ profile: "moka-orchestrator" });
      for (const surface of entrypointCommandSurfaces(config)) {
        const absolutePath = resolveHarnessTarget(surface.path);
        expect(existsSync(absolutePath), surface.path).toBe(true);
        const content = readFileSync(absolutePath, "utf-8");
        expect(content).toContain("agent: MoKa Orchestrator");
        expect(content).toContain("Configured orchestrator:");
        expect(content).toContain(surface.invocation);
        expect(content).toContain(surface.targetId);
      }

      expect(
        existsSync(
          resolveHarnessTarget(".opencode/agents/MoKa Orchestrator.md")
        )
      ).toBe(true);

      for (const profileId of workflowProfileIds(config)) {
        const { runner } = config.profiles[profileId];
        const nativeAgentPath = nativeAgentPathFor(runner, profileId);
        Option.match(nativeAgentPath, {
          onNone: () => {},
          onSome: (path) => {
            const absolutePath = resolveHarnessTarget(path);
            const content = readFileSync(absolutePath, "utf-8");
            if (path.endsWith(".toml")) {
              expect(content).toContain(`name = "${profileId}"`);
              expect(content).toContain("developer_instructions = ");
            } else {
              expect(content).toContain("Configured grants:");
            }
          },
        });
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("validates and explains ticket-accurate epic schedules with task context through the CLI", async () => {
    const project = tempProject();
    writePc37BacklogFixture(project);
    writeProjectFile(project, ".pipeline/rules/test-first.md", "Test first.");
    writeProjectFile(
      project,
      ".pipeline/rules/verification.md",
      "Verify real usage."
    );
    const config = loadPipelineConfig(process.cwd(), {
      allowMissingLintFileReferences: true,
    });
    const plannerSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-pc37-dogfood
source_entrypoint: execute
task: PC-37
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: moka-researcher
      - id: pc-37-1-green
        kind: agent
        profile: moka-code-writer
        needs: [research]
        task_context:
          id: PC-37.1
      - id: pc-37-2-green
        kind: agent
        profile: moka-code-writer
        needs: [pc-37-1-green]
        task_context:
          id: PC-37.2
      - id: pc-37-3-green
        kind: agent
        profile: moka-code-writer
        needs: [pc-37-1-green]
        task_context:
          id: PC-37.3
      - id: pc-37-4-green
        kind: agent
        profile: moka-code-writer
        needs: [research]
        task_context:
          id: PC-37.4
      - id: pc-37-5-green
        kind: agent
        profile: moka-code-writer
        needs: [research]
        task_context:
          id: PC-37.5
      - id: pc-37-6-green
        kind: agent
        profile: moka-code-writer
        needs: [pc-37-2-green, pc-37-3-green, pc-37-4-green, pc-37-5-green]
        task_context:
          id: PC-37.6
      - id: verify
        kind: agent
        profile: moka-verifier
        needs: [pc-37-6-green]
`;

    const generated = await generateScheduleArtifact({
      config,
      entrypointId: "execute",
      executor: () => ({ exitCode: 0, stdout: plannerSchedule }),
      generatedAt: new Date("2026-06-03T12:00:00.000Z"),
      runId: "run-pc37-dogfood",
      task: "PC-37",
      worktreePath: project,
    });
    const generatedArtifact = generated.artifact;
    const generatedNodes = flattenDogfoodNodes(
      generatedArtifact.workflows.root.nodes
    );
    const generatedNodeIds = generatedNodes.map((node) => node.id);
    const generatedTaskContextIds = generatedNodes.flatMap((node) => {
      const taskContextId = node.task_context?.id;
      return taskContextId === undefined || taskContextId.length === 0
        ? []
        : [taskContextId];
    });

    expect(generatedNodeIds).not.toEqual([
      "research",
      "plan",
      "test",
      "frontend",
      "backend",
      "k8s",
      "merge",
      "review",
    ]);
    expect(new Set(generatedTaskContextIds)).toEqual(
      new Set([
        "PC-37.1",
        "PC-37.2",
        "PC-37.3",
        "PC-37.4",
        "PC-37.5",
        "PC-37.6",
      ])
    );
    expect(generated.path).toBe(
      ".pipeline/runs/run-pc37-dogfood/schedule.yaml"
    );
    expect(existsSync(join(project, generated.path))).toBe(true);
    expect(
      generatedNodes.some(
        (node) => node.task_context?.title === "Build API endpoint"
      )
    ).toBe(true);
    expect(generatedTaskContextIds.length).toBeGreaterThan(0);

    const compiled = compileScheduleArtifact(
      config,
      generated.artifact,
      project
    );

    expect(compiled.workflowId).toBe("schedule-run-pc37-dogfood-root");
    // Generated schedules carry their ticket-accurate work-unit nodes with no
    // candidate fan-out (best_of_n was removed).
    expect(
      new Set(compiled.plan.topologicalOrder.map((node) => node.id))
    ).toEqual(
      new Set([
        "research",
        "pc-37-1-green",
        "pc-37-2-green",
        "pc-37-3-green",
        "pc-37-4-green",
        "pc-37-5-green",
        "pc-37-6-green",
        "verify",
      ])
    );
    expect(generatedNodeIds.some((id) => id.includes("candidates"))).toBe(
      false
    );
    // Each green work-unit keeps the original agent node id + task_context...
    expect(
      generatedNodes.find((node) => node.id === "pc-37-2-green")
    ).toMatchObject({
      kind: "agent",
      needs: ["pc-37-1-green"],
      task_context: { id: "PC-37.2" },
    });
    // ...and cross-work-unit dependencies remain directly on the work-unit node.
    expect(
      generatedNodes.find((node) => node.id === "pc-37-6-green")
    ).toMatchObject({
      kind: "agent",
      needs: [
        "pc-37-2-green",
        "pc-37-3-green",
        "pc-37-4-green",
        "pc-37-5-green",
      ],
    });
  });

  it("runs deterministic dogfood options as a repeatable test", async () => {
    const project = tempProject();
    writeDogfoodProject(project);
    const { execa } = await import("execa");
    const execaMock = execa as unknown as {
      getMockImplementation?: () => unknown;
      mockImplementation?: (implementation: unknown) => unknown;
    };
    const previousExecaImplementation = execaMock.getMockImplementation?.();
    execaMock.mockImplementation?.(
      (
        command: string,
        args: string[] = [],
        options?: { cwd?: string; env?: Record<string, string> }
      ) => {
        const result = spawnSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          env: { ...process.env, ...options?.env },
        });
        const response = {
          exitCode: result.status ?? 0,
          stderr: result.stderr,
          stdout: result.stdout,
        };
        if ((result.status ?? 0) !== 0) {
          throw new DogfoodInstalledTestError({
            message: [
              `Command failed (${response.exitCode}): ${command} ${args.join(" ")}`,
              `stdout:\n${response.stdout}`,
              `stderr:\n${response.stderr}`,
            ].join("\n"),
          });
        }
        return response;
      }
    );
    const previousTestCommand = process.env.PIPELINE_TEST_COMMAND;
    const previousTypecheckCommand = process.env.PIPELINE_TYPECHECK_COMMAND;
    process.env.PIPELINE_TEST_COMMAND =
      "node -e \"console.log('dogfood tests pass')\"";
    process.env.PIPELINE_TYPECHECK_COMMAND =
      "node -e \"console.log('dogfood typecheck passes')\"";

    let result!: Awaited<ReturnType<typeof runPipelineFromConfig>>;
    try {
      result = await runPipelineFromConfig({
        config: loadFixturePipelineConfig(project),
        task: "repeatable deterministic dogfood",
        workflowId: "dogfood-options",
        worktreePath: project,
      });
    } finally {
      if (previousTestCommand === undefined) {
        delete process.env.PIPELINE_TEST_COMMAND;
      } else {
        process.env.PIPELINE_TEST_COMMAND = previousTestCommand;
      }
      if (previousTypecheckCommand === undefined) {
        delete process.env.PIPELINE_TYPECHECK_COMMAND;
      } else {
        process.env.PIPELINE_TYPECHECK_COMMAND = previousTypecheckCommand;
      }
      if (
        previousExecaImplementation !== undefined &&
        execaMock.mockImplementation !== undefined
      ) {
        execaMock.mockImplementation(previousExecaImplementation);
      }
    }
    expect(result.outcome, JSON.stringify(result, null, 2)).toBe("PASS");
    expect(result.agentInvocations).toHaveLength(1);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ["artifact-schema", true],
      ["expected-nonzero", true],
      ["artifact:.pipeline/dogfood/artifact.json", true],
      ["output:artifact", true],
      ["flaky-once", false],
      ["flaky-once", true],
    ]);
    expect(
      result.nodes.find((node) => node.nodeId === "retry-gate")
    ).toMatchObject({
      attempts: 2,
      status: "passed",
    });
    expect(result.hookFailures).toContainEqual(
      expect.objectContaining({ gate: "optional-failure" })
    );
    expect(existsSync(join(project, ".pipeline/dogfood/artifact.json"))).toBe(
      true
    );
    expect(
      readFileSync(join(project, ".pipeline/dogfood/hooks.log"), "utf-8")
    ).toContain("workflow.start");
    expect(configuredDogfoodOrchestrator(project)).toEqual({
      hooks: expect.arrayContaining([
        "workflow-start",
        "node-start",
        "optional-failure",
      ]),
      mcp_servers: ["pipeline-gateway"],
      model: "dogfood-orchestrator-model",
      rules: ["orchestrator-rule"],
      skills: ["orchestrator-skill"],
      tools: ["bash"],
    });
  });

  it("loads an opencode profile without runtime MCP injection", () => {
    const project = tempProject();
    writeProjectFile(
      project,
      ".pipeline/runners.yaml",
      `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      mcp_servers: true
      tools: [read]
      output_formats: [text]
`
    );
    writeProjectFile(
      project,
      ".pipeline/profiles.yaml",
      `
version: 1
mcp_gateway:
  provider: toolhive
  mode: local
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate. }
  opencode-agent:
    runner: opencode
    instructions: { inline: Use selected MCP only. }
    mcp_servers: [pipeline-gateway]
`
    );
    writeProjectFile(
      project,
      ".pipeline/pipeline.yaml",
      `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: inspect
        kind: agent
        profile: opencode-agent
`
    );

    const config = loadFixturePipelineConfig(project);
    const launch = createRunnerLaunchPlan(config, {
      nodeId: "inspect",
      profileId: "opencode-agent",
      prompt: "verify configured grants",
      worktreePath: project,
    });
    expect(launch.env).toEqual({});
    expect(launch.args.join("\n")).not.toContain("mcp_servers.");
  });

  it("dogfoods the OpenCode-first goal loop through persisted continuation state", async () => {
    const project = tempProject();
    const runDirectory = join(project, ".pipeline/runs/opencode-goal-loop");
    mkdirSync(runDirectory, { recursive: true });
    const config = loadPipelineConfig(process.cwd(), {
      allowMissingLintFileReferences: true,
    });
    const initial = applyGoalStateEvent(
      createGoalState({
        runId: "opencode-goal-loop",
        scheduleId: "planner-opencode",
        schedulePath: ".pipeline/runs/opencode-goal-loop/schedule.yaml",
        task: "Dogfood OpenCode goal loop",
        taskContext: {
          acceptanceCriteria: [
            { id: "AC1", text: "OpenCode launch plan is generated." },
            {
              id: "AC2",
              text: "Verifier and acceptance evidence are present.",
            },
          ],
          description: "Exercise persisted continuation state.",
          id: "PIPE-52.12",
          title: "Dogfood OpenCode first goal loop",
        },
        workflowId: "planner-opencode",
      }),
      {
        edges: [
          { source: "acceptance", target: "verify" },
          { source: "green", target: "acceptance" },
        ],
        nodes: [
          {
            id: "green",
            kind: "agent",
            needs: [],
            profile: "moka-code-writer",
            runnerId: "opencode",
          },
          {
            id: "acceptance",
            kind: "agent",
            needs: ["green"],
            profile: "moka-acceptance-reviewer",
            runnerId: "opencode",
          },
          {
            id: "verify",
            kind: "agent",
            needs: ["acceptance"],
            profile: "moka-verifier",
            runnerId: "opencode",
          },
        ],
        type: "workflow.planned",
        workflowId: "planner-opencode",
      }
    );
    const failed = applyGoalStateEvent(initial, {
      attempt: 1,
      format: "json_schema",
      nodeId: "acceptance",
      output: {
        acceptance: [
          {
            evidence: ["launch plan was checked"],
            id: "AC1",
            verdict: "PASS",
          },
          {
            evidence: ["verifier evidence missing on first pass"],
            id: "AC2",
            verdict: "FAIL",
            violations: ["missing verifier evidence"],
          },
        ],
        evidence: ["acceptance review ran"],
        verdict: "FAIL",
      },
      profile: "moka-acceptance-reviewer",
      schemaPath: ".pipeline/schemas/acceptance.schema.json",
      type: "node.output.recorded",
    });
    const failedWithGate = applyGoalStateEvent(failed, {
      evidence: ["acceptance criterion 'AC2' verdict 'FAIL'"],
      gateId: "acceptance-coverage",
      kind: "acceptance",
      nodeId: "acceptance",
      passed: false,
      reason: "acceptance coverage failed",
      type: "gate.finish",
    });
    saveGoalState(failedWithGate, runDirectory);

    const continuationLaunch = createGoalContinuationLaunchPlan({
      config,
      prompt: "Continue the OpenCode goal-loop dogfood.",
      worktreePath: project,
    });
    expect(continuationLaunch.runnerId).toBe("opencode");
    expect(continuationLaunch.profileId).toBe("moka-code-writer");
    expect(continuationLaunch.args).toContain("run");
    expect(continuationLaunch.args).toContain(
      "Continue the OpenCode goal-loop dogfood."
    );

    const result = await runBoundedGoalLoop({
      initialState: loadGoalStateFromRunDirectory(runDirectory),
      maxContinuations: 2,
      runContinuation: ({ attempt, state }) => {
        if (attempt === 1) {
          return recordGoalStateChangedFiles(state, "green", [
            "src/runtime/goal-loop/goal-loop.ts",
          ]);
        }
        const accepted = applyGoalStateEvent(state, {
          attempt: 2,
          format: "json_schema",
          nodeId: "acceptance",
          output: {
            acceptance: [
              {
                evidence: ["OpenCode launch plan generated"],
                id: "AC1",
                verdict: "PASS",
              },
              {
                evidence: ["verifier and acceptance evidence captured"],
                id: "AC2",
                verdict: "PASS",
              },
            ],
            evidence: ["acceptance passed"],
            verdict: "PASS",
          },
          profile: "moka-acceptance-reviewer",
          schemaPath: ".pipeline/schemas/acceptance.schema.json",
          type: "node.output.recorded",
        });
        const verified = applyGoalStateEvent(accepted, {
          attempt: 2,
          format: "json_schema",
          nodeId: "verify",
          output: {
            evidence: ["real package OpenCode launch plan inspected"],
            verdict: "PASS",
          },
          profile: "moka-verifier",
          schemaPath: ".pipeline/schemas/verify.schema.json",
          type: "node.output.recorded",
        });
        return applyGoalStateEvent(verified, {
          outcome: "PASS",
          type: "workflow.finish",
          workflowId: "planner-opencode",
        });
      },
      writePrompt: (attempt, prompt) => {
        const promptPath = join(runDirectory, `continuation-${attempt}.md`);
        writeFileSync(promptPath, prompt);
        return promptPath;
      },
    });
    saveGoalState(result.state, runDirectory);

    expect(result.terminalState, JSON.stringify(result, null, 2)).toBe(
      "passed"
    );
    expect(result.attempts).toBe(2);
    expect(result.prompts[0]).toContain("acceptance coverage failed");
    expect(result.prompts[1]).toContain("src/runtime/goal-loop/goal-loop.ts");
    expect(loadGoalStateFromRunDirectory(runDirectory)).toMatchObject({
      acceptance: [
        { id: "AC1", verdict: "PASS" },
        { id: "AC2", verdict: "PASS" },
      ],
      terminalOutcome: "PASS",
      verifier: {
        nodeId: "verify",
        verdict: "PASS",
      },
    });
  });
});
