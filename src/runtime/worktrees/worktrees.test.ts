import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePipelineConfigParts } from "../../config";
import { compileWorkflowPlan } from "../../workflow-planner";
import type { RuntimeContext } from "../contracts";
import {
  ensurePipelineSymlink,
  prepareWorkflowNodeWorktree,
  resolveWorkflowNodeWorktreePath,
} from "./worktrees";

const tempDirs: string[] = [];
const RUN_ID_TOKEN = ["$", "{runId}"].join("");
const NODE_ID_TOKEN = ["$", "{nodeId}"].join("");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-worktrees-"));
  tempDirs.push(dir);
  return dir;
}

function contextForWorktrees(worktreePath: string): RuntimeContext {
  const config = parsePipelineConfigParts({
    runners: `
version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
    profiles: `
version: 1
profiles:
  a:
    runner: codex
    instructions: { inline: A }
`,
    pipeline: `
version: 1
default_workflow: child
orchestrator:
  profile: a
workflows:
  child:
    nodes:
      - id: noop
        kind: command
        command: ["node", "-e", "console.log('ok')"]
`,
  });
  return {
    agentInvocations: [],
    config,
    executor: () => ({ exitCode: 0, stdout: "" }),
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: true,
      allowUntrustedCommandHooks: true,
      env: {},
      envPassthrough: ["PATH"],
      outputLimitBytes: 1024,
      timeoutMs: 1000,
    },
    hookResults: new Map(),
    inheritedOutputNodeIds: new Set(),
    lastOutputByNode: new Map(),
    nodeActors: new Map(),
    nodeSnapshots: new Map(),
    nodeStates: new Map(),
    plan: compileWorkflowPlan(config),
    runId: "run-123",
    task: "task",
    workflowId: "child",
    worktreePath,
  };
}

describe("runtime worktrees", () => {
  it("substitutes run and node tokens relative to the parent worktree", () => {
    const root = tempProject();
    const context = contextForWorktrees(root);

    expect(
      resolveWorkflowNodeWorktreePath(
        {
          children: [],
          dependents: [],
          id: "child",
          index: 0,
          kind: "workflow",
          needs: [],
          workflow: "child",
          worktreeRoot: `.pipeline/worktrees/${RUN_ID_TOKEN}/${NODE_ID_TOKEN}`,
        },
        context
      )
    ).toBe(join(root, ".pipeline/worktrees/run-123/child"));
  });

  it("links the pipeline directory into child worktrees", () => {
    const parent = tempProject();
    const child = tempProject();
    mkdirSync(join(parent, ".pipeline"), { recursive: true });

    ensurePipelineSymlink(parent, child);

    expect(existsSync(join(child, ".pipeline"))).toBe(true);
  });

  it("does not create a git worktree for workflow nodes without worktreeRoot", async () => {
    const context = contextForWorktrees(tempProject());

    await expect(
      prepareWorkflowNodeWorktree(
        {
          children: [],
          dependents: [],
          id: "child",
          index: 0,
          kind: "workflow",
          needs: [],
          workflow: "child",
        },
        context
      )
    ).resolves.toEqual({ baseSha: null, branch: null, worktreePath: null });
  });
});
