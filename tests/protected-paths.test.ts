import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parsePipelineConfigParts } from "../src/config.ts";
import { opencodeAdapter } from "../src/install-commands/opencode.ts";
import type { RunnerLaunchPlan } from "../src/runner";
import { createRunnerLaunchPlan } from "../src/runner";
import { runLaunchPlan } from "../src/runner/subprocess";
import { createProtectedPathGuard } from "../src/runtime/protected-paths/protected-paths.ts";
import { RepoIoServiceLive } from "../src/runtime/services/repo-io-service.ts";
import { loadBacklogTaskStoreEffect } from "../src/tickets/backlog-task-store.ts";

const VIOLATION_RE = /Protected-path violation/;
const AC_FILE = "backlog/tasks/PIPE-1.md";
const TEST_FILE = "tests/foo.test.ts";
const PROTECTED = ["backlog/tasks/**", "tests/**"] as const;
const AC_CONTENT = [
  "---",
  "id: PIPE-1",
  "title: Sample",
  "status: To Do",
  "---",
  "## Acceptance Criteria",
  "<!-- AC:BEGIN -->",
  "- [ ] #1 The widget renders",
  "<!-- AC:END -->",
  "",
].join("\n");
const TEST_CONTENT = 'it("adjudicates", () => expect(1).toBe(1));\n';

const permissionEntrySchema = z.union([
  z.string(),
  z.record(z.string(), z.string()),
]);
const agentPermissionSchema = z.object({
  permission: z.record(z.string(), permissionEntrySchema),
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "moka-protected-"));
  tempDirs.push(root);
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, AC_FILE), AC_CONTENT);
  writeFileSync(join(root, TEST_FILE), TEST_CONTENT);
  return root;
}

function shellPlan(
  cwd: string,
  script: string,
  protectedPaths: readonly string[] | undefined
): RunnerLaunchPlan {
  return {
    args: ["-c", script],
    command: "bash",
    cwd,
    env: {},
    nodeId: "node",
    outputFormat: "text",
    ...(protectedPaths ? { protectedPaths } : {}),
    runnerId: "shell",
    type: "command",
  };
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

const ORIGINAL: Record<string, string> = {
  [AC_FILE]: AC_CONTENT,
  [TEST_FILE]: TEST_CONTENT,
};

// Run a tampering script in a fresh guarded worktree and return the outcome for
// the caller to assert on.
async function runTamper(script: string) {
  const root = makeWorktree();
  const result = await runLaunchPlan(shellPlan(root, script, PROTECTED));
  return { result, root };
}

describe("protected-path guard module", () => {
  it("detects and reverts a modified protected file", () => {
    const root = makeWorktree();
    const guard = createProtectedPathGuard(root, PROTECTED);
    writeFileSync(join(root, AC_FILE), "tampered criteria");

    const violations = guard.verifyAndRestore();

    expect(violations).toEqual([{ kind: "modified", path: AC_FILE }]);
    expect(read(root, AC_FILE)).toBe(AC_CONTENT);
  });

  it("detects and recreates a deleted protected file", () => {
    const root = makeWorktree();
    const guard = createProtectedPathGuard(root, PROTECTED);
    rmSync(join(root, TEST_FILE));

    const violations = guard.verifyAndRestore();

    expect(violations).toEqual([{ kind: "deleted", path: TEST_FILE }]);
    expect(read(root, TEST_FILE)).toBe(TEST_CONTENT);
  });

  it("is a no-op when no protected patterns are configured", () => {
    const root = makeWorktree();
    const guard = createProtectedPathGuard(root, undefined);
    writeFileSync(join(root, AC_FILE), "freely edited");

    expect(guard.verifyAndRestore()).toEqual([]);
    expect(read(root, AC_FILE)).toBe("freely edited");
  });
});

describe("runLaunchPlan — CLI/runner transport enforcement", () => {
  it.each([
    [
      "AC#1: write to the ticket criteria file",
      `printf 'H' > ${AC_FILE}`,
      AC_FILE,
    ],
    [
      "AC#2: overwrite of an adjudicating test",
      `printf 'x' > ${TEST_FILE}`,
      TEST_FILE,
    ],
    ["AC#2: deletion of an adjudicating test", `rm -f ${TEST_FILE}`, TEST_FILE],
    [
      "AC#2/AC#7: bash >> append to a test",
      `printf 'evil' >> ${TEST_FILE}`,
      TEST_FILE,
    ],
    [
      "AC#7: path-traversal write",
      `mkdir -p src/sub && cd src/sub && printf 'HACK' > ../../${TEST_FILE}`,
      TEST_FILE,
    ],
    [
      "AC#7: symlink write-through",
      `ln -s "$PWD/${TEST_FILE}" evil-link && printf 'HACK' > evil-link`,
      TEST_FILE,
    ],
  ])("rejects %s — file unchanged, node failed", async (_name, script, target) => {
    const { result, root } = await runTamper(script);

    expect(read(root, target)).toBe(ORIGINAL[target]);
    expect(result.stderr).toMatch(VIOLATION_RE);
    expect(result.exitCode).not.toBe(0);
  });

  it("AC#7: reverts a symlink substituted for the protected path itself", async () => {
    const script = `rm -f ${TEST_FILE} && ln -s /etc/hosts ${TEST_FILE}`;
    const { root } = await runTamper(script);

    expect(read(root, TEST_FILE)).toBe(TEST_CONTENT);
    expect(lstatSync(join(root, TEST_FILE)).isSymbolicLink()).toBe(false);
  });

  it("AC#5: removing the protected entry re-enables the write (live, not inert)", async () => {
    const guarded = makeWorktree();
    await runLaunchPlan(
      shellPlan(guarded, `printf 'HACKED' > ${AC_FILE}`, PROTECTED)
    );
    expect(read(guarded, AC_FILE)).toBe(AC_CONTENT);

    const unguarded = makeWorktree();
    const result = await runLaunchPlan(
      shellPlan(unguarded, `printf 'HACKED' > ${AC_FILE}`, [])
    );
    expect(read(unguarded, AC_FILE)).toBe("HACKED");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(VIOLATION_RE);
  });
});

function protectedConfig() {
  return parsePipelineConfigParts({
    runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    model: openai/gpt-5.5
    capabilities:
      native_subagents: true
      output_formats: [text, json]
      tools: [read, edit, write, bash]
      filesystem: [read-only, workspace-write]
`,
    profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: []
  code-writer:
    runner: opencode
    instructions: { inline: Write code }
    tools: [read, edit, write, bash]
    filesystem:
      mode: workspace-write
      protected: ["backlog/tasks/**", "tests/**"]
`,
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - { id: run, kind: agent, profile: code-writer }
`,
  });
}

describe("filesystem.protected wiring", () => {
  it("AC#5: createRunnerLaunchPlan copies filesystem.protected onto the plan", () => {
    const plan = createRunnerLaunchPlan(protectedConfig(), {
      profileId: "code-writer",
      nodeId: "run",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });

    expect(plan.protectedPaths).toEqual(["backlog/tasks/**", "tests/**"]);
  });

  it("AC#3: opencode permission map emits per-path deny for edit and write", () => {
    const definitions = opencodeAdapter.definitions(protectedConfig(), "/repo");
    const agent = definitions.find(
      (def) => def.path === ".opencode/agents/code-writer.md"
    );
    expect(agent).toBeDefined();
    const { permission } = agentPermissionSchema.parse(
      matter(agent?.content ?? "").data
    );

    const expected = {
      "*": "allow",
      "backlog/tasks/**": "deny",
      "tests/**": "deny",
    };
    expect(permission.edit).toEqual(expected);
    expect(permission.write).toEqual(expected);
  });
});

describe("gate/planner read access retained (AC#6)", () => {
  it("the acceptance store still reads criteria with protection configured", async () => {
    const root = makeWorktree();

    const store = await Effect.runPromise(
      Effect.provide(loadBacklogTaskStoreEffect(root), RepoIoServiceLive)
    );

    expect(existsSync(join(root, AC_FILE))).toBe(true);
    expect(store.tasksById.get("PIPE-1")?.acceptanceCriteria).toEqual([
      "The widget renders",
    ]);
  });
});
