import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPipelineConfig,
  type PipelineConfig,
  parsePipelineConfigParts,
} from "../src/config.js";
import { runPipelineFromConfig } from "../src/pipeline-runtime.js";
import { createRunnerLaunchPlan } from "../src/runner.js";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
} from "../src/schedule-planner.js";
import { compileWorkflowPlan } from "../src/workflow-planner.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-installed-dogfood-"));
  tempDirs.push(dir);
  return dir;
}

function writeProjectFile(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function loadFixturePipelineConfig(project: string): PipelineConfig {
  return parsePipelineConfigParts(
    {
      pipeline: readFileSync(join(project, ".pipeline/pipeline.yaml"), "utf8"),
      profiles: readFileSync(join(project, ".pipeline/profiles.yaml"), "utf8"),
      runners: readFileSync(join(project, ".pipeline/runners.yaml"), "utf8"),
    },
    project
  );
}

function writeBacklogTask(
  root: string,
  id: string,
  title: string,
  body: string,
  options: { dependencies?: string[]; parentTaskId?: string } = {}
): void {
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
}

function writePc37BacklogFixture(root: string): void {
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
    { dependencies: ["PC-37.1"] }
  );
  writeBacklogTask(
    root,
    "PC-37.3",
    "Build console view",
    "## Description\n\nBuild the console view.",
    { dependencies: ["PC-37.1"] }
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
    { dependencies: ["PC-37.2", "PC-37.3", "PC-37.4", "PC-37.5"] }
  );
}

function writeDogfoodProject(root: string): void {
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
    readFileSync(".pipeline/schemas/dogfood.schema.json", "utf8")
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
}

describe("installed dogfood configuration", () => {
  it("keeps installed YAML workflows valid and explainable", () => {
    const config = loadPipelineConfig(process.cwd(), {
      allowMissingLintFileReferences: true,
    });

    expect(
      compileWorkflowPlan(config, "default").topologicalOrder.map(
        (node) => node.id
      )
    ).toEqual(["research", "red", "green", "acceptance", "verify", "learn"]);
    expect(
      compileWorkflowPlan(config, "inspect").topologicalOrder.map(
        (node) => node.id
      )
    ).toEqual(["inspect"]);
  });

  it("keeps installed host resources aligned with orchestrator and agent grants", () => {
    const config = loadPipelineConfig(process.cwd(), {
      allowMissingLintFileReferences: true,
    });
    const root = process.cwd();
    for (const surface of entrypointCommandSurfaces(config)) {
      expect(existsSync(join(root, surface.path)), surface.path).toBe(true);
      const content = readFileSync(join(root, surface.path), "utf8");
      const profile = config.profiles[config.orchestrator.profile];
      expect(profile).toBeTruthy();
      expect(content).toContain("Configured orchestrator:");
      expect(content).toContain(`model: ${profile.model ?? "default"}`);
      expect(content).toContain(`tools: ${(profile.tools ?? []).join(", ")}`);
      expect(content).toContain(`rules: ${(profile.rules ?? []).join(", ")}`);
      expect(content).toContain(`skills: ${(profile.skills ?? []).join(", ")}`);
      expect(content).toContain(
        `mcp_servers: ${(profile.mcp_servers ?? []).join(", ")}`
      );
      expect(content).toContain(`filesystem: ${profile.filesystem?.mode}`);
      expect(content).toContain(`network: ${profile.network?.mode}`);
      expect(content).toContain(
        `hooks: ${Object.keys(config.hooks.functions).join(", ")}`
      );
      expect(content).toContain(surface.invocation);
      expect(content).toContain(surface.targetId);
    }

    const pipelineOrchestratorContent = readFileSync(
      join(root, ".opencode/agents/pipeline-orchestrator.md"),
      "utf8"
    );
    const profile = config.profiles[config.orchestrator.profile];
    expect(profile).toBeTruthy();
    expect(pipelineOrchestratorContent).toContain("Configured orchestrator:");
    expect(pipelineOrchestratorContent).toContain(
      `model: ${profile.model ?? "default"}`
    );
    expect(pipelineOrchestratorContent).toContain(
      `tools: ${(profile.tools ?? []).join(", ")}`
    );
    expect(pipelineOrchestratorContent).toContain(
      `rules: ${(profile.rules ?? []).join(", ")}`
    );
    expect(pipelineOrchestratorContent).toContain(
      `skills: ${(profile.skills ?? []).join(", ")}`
    );
    expect(pipelineOrchestratorContent).toContain(
      `mcp_servers: ${(profile.mcp_servers ?? []).join(", ")}`
    );
    expect(pipelineOrchestratorContent).toContain(
      `filesystem: ${profile.filesystem?.mode}`
    );
    expect(pipelineOrchestratorContent).toContain(
      `network: ${profile.network?.mode}`
    );
    expect(pipelineOrchestratorContent).toContain(
      `hooks: ${Object.keys(config.hooks.functions).join(", ")}`
    );

    for (const profileId of workflowProfileIds(config)) {
      const runner = config.profiles[profileId]?.runner;
      const nativeAgentPath = nativeAgentPathFor(runner, profileId);
      if (nativeAgentPath) {
        const content = readFileSync(join(root, nativeAgentPath), "utf8");
        if (nativeAgentPath.endsWith(".toml")) {
          expect(content).toContain(`name = "${profileId}"`);
          expect(content).toContain("developer_instructions = ");
        } else {
          expect(content).toContain("Configured grants:");
        }
      }
    }

    for (const profileId of workflowProfileIds(config)) {
      const profile = config.profiles[profileId];
      if (profile?.runner !== "codex") {
        continue;
      }

      const codexAgentContent = readFileSync(
        join(root, `.codex/agents/${profileId}.toml`),
        "utf8"
      );
      const projectCodexConfig = readFileSync(
        join(root, ".codex/config.toml"),
        "utf8"
      );
      expect(codexAgentContent).toContain(`name = "${profileId}"`);
      expect(codexAgentContent).toContain("developer_instructions = ");
      expect(codexAgentContent).not.toContain("[mcp_servers.");
      expect(projectCodexConfig).toContain(
        "# @oisincoveney/pipeline:codex-agents:start"
      );
      expect(projectCodexConfig).toContain("[mcp_servers.pipeline-gateway]");
      expect(projectCodexConfig).toContain(
        "[mcp_servers.pipeline-gateway.env_http_headers]"
      );
      expect(projectCodexConfig).toContain("[agents]");
      expect(projectCodexConfig).toContain("max_depth = 1");
      expect(projectCodexConfig).not.toContain(`[agents.${profileId}]`);
      for (const skillId of profile.skills ?? []) {
        const skill = config.skills[skillId];
        expect(skill, `${profileId} skill ${skillId}`).toBeTruthy();
        const skillPath = join(root, skill.path);
        const installedSkillPath = skill.path.replaceAll("\\", "/");
        if (existsSync(skillPath)) {
          expect(
            codexAgentContent,
            `${profileId} names skill ${skillId}`
          ).toContain("[[skills.config]]");
          expect(
            codexAgentContent,
            `${profileId} uses project-relative skill context`
          ).not.toContain(skillPath);
        } else {
          expect(
            codexAgentContent,
            `${profileId} skips missing lint-only skill ${skillId}`
          ).not.toContain(installedSkillPath);
        }
      }
      for (const mcpId of profile.mcp_servers ?? []) {
        if (mcpId === "pipeline-gateway") {
          expect(config.mcp_gateway, `${profileId} MCP gateway`).toBeTruthy();
        } else {
          expect(
            config.mcp_servers[mcpId],
            `${profileId} MCP ${mcpId}`
          ).toBeTruthy();
        }
        expect(
          codexAgentContent,
          `${profileId} does not start MCP ${mcpId} at host startup`
        ).not.toContain(`[mcp_servers.${mcpId}]`);
      }

      const launch = createRunnerLaunchPlan(config, {
        nodeId: profileId,
        profileId,
        prompt: "verify configured grants",
        worktreePath: root,
      });
      const launchArgs = launch.args.join("\n");
      for (const skillId of profile.skills ?? []) {
        const skill = config.skills[skillId];
        const skillPath = join(root, skill.path);
        if (existsSync(skillPath)) {
          expect(
            launchArgs,
            `${profileId} launches skill ${skillId}`
          ).toContain(skillPath);
        } else {
          expect(
            launchArgs,
            `${profileId} skips missing lint-only skill ${skillId}`
          ).not.toContain(skillPath);
        }
      }
      for (const mcpId of profile.mcp_servers ?? []) {
        expect(
          launchArgs,
          `${profileId} uses project MCP ${mcpId}`
        ).not.toContain(`mcp_servers.${mcpId}.`);
      }
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
source_entrypoint: epic
task: PC-37
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: pc-37-1-green
        kind: agent
        profile: pipeline-code-writer
        needs: [research]
        task_context:
          id: PC-37.1
      - id: pc-37-2-green
        kind: agent
        profile: pipeline-code-writer
        needs: [pc-37-1-green]
        task_context:
          id: PC-37.2
      - id: pc-37-3-green
        kind: agent
        profile: pipeline-code-writer
        needs: [pc-37-1-green]
        task_context:
          id: PC-37.3
      - id: pc-37-4-green
        kind: agent
        profile: pipeline-code-writer
        needs: [research]
        task_context:
          id: PC-37.4
      - id: pc-37-5-green
        kind: agent
        profile: pipeline-code-writer
        needs: [research]
        task_context:
          id: PC-37.5
      - id: pc-37-6-green
        kind: agent
        profile: pipeline-code-writer
        needs: [pc-37-2-green, pc-37-3-green, pc-37-4-green, pc-37-5-green]
        task_context:
          id: PC-37.6
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [pc-37-6-green]
`;

    const generated = await generateScheduleArtifact({
      config,
      entrypointId: "epic",
      executor: () => ({ exitCode: 0, stdout: plannerSchedule }),
      generatedAt: new Date("2026-06-03T12:00:00.000Z"),
      runId: "run-pc37-dogfood",
      task: "PC-37",
      worktreePath: project,
    });
    const generatedArtifact = generated.artifact;
    const generatedNodeIds = generatedArtifact.workflows.root.nodes.map(
      (node) => node.id
    );
    const generatedTaskContextIds =
      generatedArtifact.workflows.root.nodes.flatMap((node) =>
        node.task_context?.id ? [node.task_context.id] : []
      );

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
    expect(generated.path).toBe("memory:run-pc37-dogfood");
    expect(
      generatedArtifact.workflows.root.nodes.some(
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
    expect(
      new Set(compiled.plan.topologicalOrder.map((node) => node.id))
    ).toEqual(
      new Set([
        "research",
        "pc-37-1-green",
        "pc-37-4-green",
        "pc-37-5-green",
        "pc-37-2-green",
        "pc-37-3-green",
        "pc-37-6-green",
        "verify",
      ])
    );
    expect(
      compiled.plan.topologicalOrder.find((node) => node.id === "pc-37-2-green")
    ).toMatchObject({
      kind: "agent",
      needs: ["pc-37-1-green"],
    });
    expect(
      compiled.plan.topologicalOrder.find((node) => node.id === "pc-37-6-green")
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
      readFileSync(join(project, ".pipeline/dogfood/hooks.log"), "utf8")
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
});

function workflowProfileIds(config: PipelineConfig) {
  return [
    ...new Set(
      Object.values(config.workflows).flatMap((workflow) =>
        workflow.nodes.flatMap((node) =>
          node.kind === "agent" && node.profile ? [node.profile] : []
        )
      )
    ),
  ].sort();
}

function entrypointCommandSurfaces(config: PipelineConfig) {
  return Object.entries(config.entrypoints).flatMap(
    ([entrypointId, entrypoint]) => [
      {
        invocation: `/${entrypointId} <task description>`,
        path: `.opencode/commands/${entrypointId}.md`,
        targetId:
          "workflow" in entrypoint ? entrypoint.workflow : entrypoint.schedule,
      },
      {
        invocation: `$${entrypointId} <task description>`,
        path: `.agents/skills/${entrypointId}/SKILL.md`,
        targetId:
          "workflow" in entrypoint ? entrypoint.workflow : entrypoint.schedule,
      },
      {
        invocation: `/${entrypointId} <task description>`,
        path: `.agents/plugins/oisin-pipeline/commands/${entrypointId}.md`,
        targetId:
          "workflow" in entrypoint ? entrypoint.workflow : entrypoint.schedule,
      },
    ]
  );
}

function nativeAgentPathFor(
  runner: string | undefined,
  profileId: string
): string | undefined {
  if (runner === "opencode") {
    return `.opencode/agents/${profileId}.md`;
  }
  if (runner === "codex") {
    return `.codex/agents/${profileId}.toml`;
  }
  return;
}

function configuredDogfoodOrchestrator(project: string) {
  const config = loadFixturePipelineConfig(project);
  const profile = config.profiles[config.orchestrator.profile];
  return {
    hooks: Object.keys(config.hooks.functions),
    mcp_servers: profile.mcp_servers,
    model: profile.model,
    rules: profile.rules,
    skills: profile.skills,
    tools: profile.tools,
  };
}
