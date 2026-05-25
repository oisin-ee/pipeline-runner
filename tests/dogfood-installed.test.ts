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
import { loadPipelineConfig } from "../src/mastra/config.js";
import { runPipelineFromConfig } from "../src/pipeline-runtime.js";
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
    ".pipeline/pipeline.yaml",
    `
version: 1
default_workflow: dogfood-options
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
  runner: artifact-command
  model: dogfood-orchestrator-model
  instructions: { inline: Coordinate deterministic dogfood. }
  rules: [orchestrator-rule]
  skills: [orchestrator-skill]
  mcp_servers: [knowledge-base]
  tools: [bash]
  filesystem: { mode: workspace-write }
  network: { mode: disabled }
  hooks: [workflow-start]
agents:
  artifact-writer:
    runner: artifact-command
    instructions: { inline: Write the deterministic artifact. }
    filesystem: { mode: workspace-write }
    network: { mode: disabled }
    output:
      format: json_schema
      schema_path: .pipeline/schemas/dogfood.schema.json
workflows:
  dogfood-options:
    hooks: [workflow-start, optional-failure]
    nodes:
      - id: artifact
        kind: agent
        agent: artifact-writer
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
    const config = loadPipelineConfig(process.cwd());

    expect(
      compileWorkflowPlan(config, "dogfood").topologicalOrder
    ).toHaveLength(3);
    expect(
      compileWorkflowPlan(config, "dogfood-options").topologicalOrder.map(
        (node) => node.id
      )
    ).toEqual([
      "artifact",
      "retry-gate",
      "parallel-left",
      "parallel-right",
      "join",
    ]);
    expect(
      compileWorkflowPlan(config, "dogfood-live-runners").topologicalOrder.map(
        (node) => node.id
      )
    ).toEqual([
      "codex-live",
      "claude-live",
      "opencode-live",
      "kimi-live",
      "pi-live",
    ]);
  });

  it("keeps installed host resources aligned with orchestrator and agent grants", () => {
    const config = loadPipelineConfig(process.cwd());
    const root = process.cwd();
    const orchestratorSurfaces = [
      ".claude/commands/pipe.md",
      ".opencode/commands/pipe.md",
      ".opencode/agents/pipeline-orchestrator.md",
      ".agents/skills/pipe/SKILL.md",
      ".kimi/commands/pipe.md",
      ".pi/prompts/pipe.md",
      ".pi/extensions/pipe.ts",
    ];

    for (const path of orchestratorSurfaces) {
      const content = readFileSync(join(root, path), "utf8");
      expect(content).toContain("Configured orchestrator:");
      expect(content).toContain("model: gpt-5");
      expect(content).toContain("skills: dogfood-orchestrator");
      expect(content).toContain("mcp_servers: dogfood-knowledge-base");
      expect(content).toContain("hooks: dogfood-workflow-start");
    }

    for (const agentId of Object.keys(config.agents)) {
      for (const path of [
        `.claude/agents/${agentId}.md`,
        `.opencode/agents/${agentId}.md`,
        `.codex/agents/${agentId}.toml`,
        `.kimi/agents/${agentId}.md`,
      ]) {
        expect(readFileSync(join(root, path), "utf8")).toContain(
          "Configured grants:"
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

function configuredDogfoodOrchestrator(project: string) {
  const config = loadPipelineConfig(project);
  return {
    hooks: config.orchestrator.hooks,
    mcp_servers: config.orchestrator.mcp_servers,
    model: config.orchestrator.model,
    rules: config.orchestrator.rules,
    skills: config.orchestrator.skills,
    tools: config.orchestrator.tools,
  };
}
