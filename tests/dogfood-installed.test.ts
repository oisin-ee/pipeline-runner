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
import { loadPipelineConfig } from "../src/config.js";
import { runPipelineFromConfig } from "../src/pipeline-runtime.js";
import { createRunnerLaunchPlan } from "../src/runner.js";
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
mcp_servers:
  knowledge-base:
    command: node
    args: [kb.js]
profiles:
  orchestrator:
    runner: artifact-command
    model: dogfood-orchestrator-model
    instructions: { inline: Coordinate deterministic dogfood. }
    rules: [orchestrator-rule]
    skills: [orchestrator-skill]
    mcp_servers: [knowledge-base]
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
  workflow-start:
    event: workflow.start
    kind: command
    command: [node, -e, "const fs=require('node:fs'); fs.mkdirSync('.pipeline/dogfood',{recursive:true}); fs.appendFileSync('.pipeline/dogfood/hooks.log', 'workflow.start ' + process.argv[1] + '\\\\n');", "{{workflow.id}}"]
    required: true
  node-start:
    event: node.start
    kind: command
    command: [node, -e, "const fs=require('node:fs'); fs.mkdirSync('.pipeline/dogfood',{recursive:true}); fs.appendFileSync('.pipeline/dogfood/hooks.log', 'node.start ' + process.argv[1] + '\\\\n');", "{{node.id}}"]
    required: true
  optional-failure:
    event: workflow.complete
    kind: command
    command: [node, -e, "process.exit(9)"]
    required: false
orchestrator:
  profile: orchestrator
  hooks: [workflow-start]
workflows:
  dogfood-options:
    hooks: [workflow-start, optional-failure]
    nodes:
      - id: artifact
        kind: agent
        profile: artifact-writer
        hooks: [node-start]
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
        `hooks: ${(config.orchestrator.hooks ?? []).join(", ")}`
      );
      expect(content).toContain(surface.invocation);
      expect(content).toContain(`Run workflow \`${surface.workflowId}\``);
    }

    expect(existsSync(join(root, ".kimi/skills/pipe/SKILL.md"))).toBe(false);

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
      `hooks: ${(config.orchestrator.hooks ?? []).join(", ")}`
    );

    for (const profileId of workflowProfileIds(config)) {
      const runner = config.profiles[profileId]?.runner;
      const nativeAgentPath = nativeAgentPathFor(runner, profileId);
      if (nativeAgentPath) {
        const content = readFileSync(join(root, nativeAgentPath), "utf8");
        if (nativeAgentPath.endsWith(".yaml")) {
          expect(content).toContain("system_prompt_path:");
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

      const content = readFileSync(
        join(root, `.codex/agents/${profileId}.toml`),
        "utf8"
      );
      for (const skillId of profile.skills ?? []) {
        const skill = config.skills[skillId];
        expect(skill, `${profileId} skill ${skillId}`).toBeTruthy();
        const skillPath = join(root, skill.path);
        const installedSkillPath = skill.path.replaceAll("\\", "/");
        if (existsSync(skillPath)) {
          expect(content, `${profileId} loads skill ${skillId}`).toContain(
            `path = "${installedSkillPath}"`
          );
          expect(
            content,
            `${profileId} uses project-relative skill paths`
          ).not.toContain(`path = "${skillPath}"`);
        } else {
          expect(
            content,
            `${profileId} skips missing lint-only skill ${skillId}`
          ).not.toContain(`path = "${installedSkillPath}"`);
        }
      }
      for (const mcpId of profile.mcp_servers ?? []) {
        expect(
          config.mcp_servers[mcpId],
          `${profileId} MCP ${mcpId}`
        ).toBeTruthy();
        expect(content, `${profileId} loads MCP ${mcpId}`).toContain(
          `[mcp_servers.${mcpId}]`
        );
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
        expect(launchArgs, `${profileId} launches MCP ${mcpId}`).toContain(
          `mcp_servers.${mcpId}.`
        );
      }
    }
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
    ).toContain("workflow.start dogfood-options");
    expect(configuredDogfoodOrchestrator(project)).toEqual({
      hooks: ["workflow-start"],
      mcp_servers: ["knowledge-base"],
      model: "dogfood-orchestrator-model",
      rules: ["orchestrator-rule"],
      skills: ["orchestrator-skill"],
      tools: ["bash"],
    });
  });
});

function workflowProfileIds(config: ReturnType<typeof loadPipelineConfig>) {
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

function entrypointCommandSurfaces(
  config: ReturnType<typeof loadPipelineConfig>
) {
  return Object.entries(config.entrypoints).flatMap(
    ([entrypointId, entrypoint]) => [
      {
        invocation: `/${entrypointId} <task description>`,
        path: `.claude/commands/${entrypointId}.md`,
        workflowId: entrypoint.workflow,
      },
      {
        invocation: `/${entrypointId} <task description>`,
        path: `.opencode/commands/${entrypointId}.md`,
        workflowId: entrypoint.workflow,
      },
      {
        invocation: `$${entrypointId} <task description>`,
        path: `.agents/skills/${entrypointId}/SKILL.md`,
        workflowId: entrypoint.workflow,
      },
      {
        invocation: `/${entrypointId} <task description>`,
        path: `.kimi/commands/${entrypointId}.md`,
        workflowId: entrypoint.workflow,
      },
      {
        invocation: `/${entrypointId} <task description>`,
        path: `.pi/prompts/${entrypointId}.md`,
        workflowId: entrypoint.workflow,
      },
    ]
  );
}

function nativeAgentPathFor(
  runner: string | undefined,
  profileId: string
): string | undefined {
  if (runner === "claude") {
    return `.claude/agents/${profileId}.md`;
  }
  if (runner === "opencode") {
    return `.opencode/agents/${profileId}.md`;
  }
  if (runner === "codex") {
    return `.codex/agents/${profileId}.toml`;
  }
  if (runner === "kimi") {
    return `.kimi/agents/${profileId}.yaml`;
  }
  return;
}

function configuredDogfoodOrchestrator(project: string) {
  const config = loadPipelineConfig(project);
  const profile = config.profiles[config.orchestrator.profile];
  return {
    hooks: config.orchestrator.hooks,
    mcp_servers: profile.mcp_servers,
    model: profile.model,
    rules: profile.rules,
    skills: profile.skills,
    tools: profile.tools,
  };
}
