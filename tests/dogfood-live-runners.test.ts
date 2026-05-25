import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsePipelineConfigYaml } from "../src/mastra/config.js";
import { runPipelineFromConfig } from "../src/pipeline-runtime.js";

const RUN_LIVE = process.env.PIPELINE_LIVE_RUNNERS === "1";
const OK_RESPONSE_PATTERN = /\bOK\b/;
const describeLive = RUN_LIVE ? describe : describe.skip;
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-live-runner-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { test: "node -e ''", typecheck: "node -e ''" } })
  );
  return dir;
}

function liveRunnerConfig() {
  return parsePipelineConfigYaml(`
version: 1
default_workflow: live
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text, json, jsonl, json_schema]
  claude:
    type: claude
    command: claude
    capabilities:
      native_subagents: true
      output_formats: [text, json, json_schema]
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text, json, jsonl, json_schema]
  kimi:
    type: kimi
    command: kimi
    capabilities:
      native_subagents: true
      output_formats: [text, json]
  pi:
    type: pi
    command: pi
    capabilities:
      native_subagents: true
      output_formats: [text, json]
agents:
  codex-live:
    runner: codex
    instructions: { inline: "Reply with exactly OK. Do not inspect files. Do not run tools." }
  claude-live:
    runner: claude
    instructions: { inline: "Reply with exactly OK. Do not inspect files. Do not run tools." }
  opencode-live:
    runner: opencode
    instructions: { inline: "Reply with exactly OK. Do not inspect files. Do not run tools." }
  kimi-live:
    runner: kimi
    instructions: { inline: "Reply with exactly OK. Do not inspect files. Do not run tools." }
  pi-live:
    runner: pi
    instructions: { inline: "Reply with exactly OK. Do not inspect files. Do not run tools." }
workflows:
  live:
    nodes:
      - id: codex
        kind: agent
        agent: codex-live
      - id: claude
        kind: agent
        agent: claude-live
      - id: opencode
        kind: agent
        agent: opencode-live
      - id: kimi
        kind: agent
        agent: kimi-live
      - id: pi
        kind: agent
        agent: pi-live
`);
}

describeLive("live runner dogfood", () => {
  it("invokes Codex, Claude, OpenCode, Kimi, and Pi with tiny prompts", async () => {
    const previousTimeout = process.env.PIPELINE_AGENT_TIMEOUT_MS;
    process.env.PIPELINE_AGENT_TIMEOUT_MS =
      process.env.PIPELINE_AGENT_TIMEOUT_MS ?? "45000";
    try {
      const result = await runPipelineFromConfig({
        config: liveRunnerConfig(),
        task: "Reply exactly OK.",
        workflowId: "live",
        worktreePath: tempProject(),
      });
      const diagnostic = {
        failureDetails: result.failureDetails,
        nodes: result.nodes.map((node) => ({
          evidence: node.evidence,
          exitCode: node.exitCode,
          nodeId: node.nodeId,
          output: node.output,
          status: node.status,
        })),
        outcome: result.outcome,
      };

      expect(result.outcome, JSON.stringify(diagnostic, null, 2)).toBe("PASS");
      expect(result.nodes.map((node) => [node.nodeId, node.status])).toEqual([
        ["codex", "passed"],
        ["claude", "passed"],
        ["opencode", "passed"],
        ["kimi", "passed"],
        ["pi", "passed"],
      ]);
      expect(
        result.nodes.every((node) => OK_RESPONSE_PATTERN.test(node.output))
      ).toBe(true);
      expect(result.agentInvocations.map((plan) => plan.type).sort()).toEqual([
        "claude",
        "codex",
        "kimi",
        "opencode",
        "pi",
      ]);
      expect(result.agentInvocations).toHaveLength(5);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.PIPELINE_AGENT_TIMEOUT_MS;
      } else {
        process.env.PIPELINE_AGENT_TIMEOUT_MS = previousTimeout;
      }
    }
  }, 120_000);
});
