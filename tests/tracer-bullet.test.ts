import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipe } from "../src/index.js";

interface LoggedCommand {
  args?: string[];
  cwd?: string;
  prompt?: string;
  type: string;
}

interface TracerEnvironment {
  binPath: string;
  logPath: string;
  statePath: string;
  worktreePath: string;
}

function writeExecutable(binPath: string, name: string, source: string): void {
  const scriptPath = join(binPath, name);
  writeFileSync(scriptPath, source);
  chmodSync(scriptPath, 0o755);
}

function writeFixtureWorktree(worktreePath: string): void {
  writeFileSync(
    join(worktreePath, "package.json"),
    JSON.stringify({
      scripts: { test: "project-test", typecheck: "project-typecheck" },
    })
  );
  writeFileSync(join(worktreePath, "tsconfig.json"), "{}");
  mkdirSync(join(worktreePath, "rules"));
  writeFileSync(
    join(worktreePath, "rules", "test-first.md"),
    "# Test first\n\nWrite the failing test before implementation."
  );
  mkdirSync(join(worktreePath, ".pipeline"), { recursive: true });
}

function writeFakeExecutables(env: TracerEnvironment): void {
  mkdirSync(env.binPath, { recursive: true });

  // Fake backlog: logs every invocation and, for "task create" calls, emits
  // a minimal stdout that mimics real backlog so createSwarmTasks can parse
  // the assigned task id. We assign sequential ids per process: TASK-1 for
  // the parent, then TASK-1.1..TASK-1.5 for the children.
  writeExecutable(
    env.binPath,
    "backlog",
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.PIPELINE_TRACER_LOG,
  JSON.stringify({ type: "backlog", args, cwd: process.cwd() }) + "\\n"
);
if (args[0] === "task" && args[1] === "create") {
  const counterPath = path.join(process.env.PIPELINE_TRACER_STATE || "/tmp/state.json").replace(/state\\.json$/, "backlog-counter.json");
  let counter;
  try {
    counter = JSON.parse(fs.readFileSync(counterPath, "utf8"));
  } catch {
    counter = { next: 1 };
  }
  const isChild = args.includes("--parent");
  let id;
  if (isChild) {
    counter.childOf = counter.childOf ?? counter.next - 1;
    counter.childIdx = (counter.childIdx ?? 0) + 1;
    id = "TASK-" + counter.childOf + "." + counter.childIdx;
  } else {
    id = "TASK-" + counter.next;
    counter.next += 1;
    counter.childOf = counter.next - 1;
    counter.childIdx = 0;
  }
  fs.writeFileSync(counterPath, JSON.stringify(counter));
  const titleArg = args[2] ?? "task";
  process.stdout.write("File: backlog/tasks/" + id.toLowerCase() + " - x.md\\n\\nTask " + id + " - " + titleArg + "\\n");
}
`
  );

  writeExecutable(
    env.binPath,
    "claude",
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function log(entry) {
  fs.appendFileSync(
    process.env.PIPELINE_TRACER_LOG,
    JSON.stringify(entry) + "\\n"
  );
}

const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
log({ type: "role", args, prompt, cwd: process.cwd() });

if (
  prompt.includes("You are a researcher") ||
  prompt.includes("You are a bounded researcher")
) {
  fs.mkdirSync(path.join(process.cwd(), ".pipeline"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), ".pipeline", "research.json"),
    JSON.stringify({
      findings: ["researched deterministic integrated pipeline behavior"],
      ac: ["tracer feature passes"]
    })
  );
  process.stdout.write("researched deterministic integrated pipeline behavior");
  process.exit(0);
}

if (prompt.includes("You are the LEARN phase")) {
  process.stdout.write(JSON.stringify({
    qdrant: { attempted: true, succeeded: true },
    evidence: ["stored tracer lesson"]
  }));
  process.exit(0);
}

if (prompt.includes("You are a test-writer")) {
  fs.writeFileSync(
    path.join(process.cwd(), "pipeline-feature.test"),
    "starts red for the configured project test command\\n"
  );
  process.stdout.write("wrote failing tracer test");
  process.exit(0);
}

if (prompt.includes("You are a code-writer")) {
  fs.writeFileSync(
    path.join(process.cwd(), "pipeline-feature.impl"),
    "tracerBullet=green\\n"
  );
  process.stdout.write("implemented tracer feature");
  process.exit(0);
}

if (prompt.includes("You are a code verifier")) {
  const verdict = process.env.PIPELINE_TRACER_VERDICT || "PASS";
  const evidence =
    verdict === "PASS"
      ? ["implementation matches tracer task"]
      : ["verifier found missing edge-case evidence"];
  process.stdout.write(JSON.stringify({ verdict, evidence }));
  process.exit(0);
}

process.stderr.write("Unknown claude prompt");
process.exit(1);
`
  );

  writeExecutable(
    env.binPath,
    "project-test",
    `#!/usr/bin/env node
const fs = require("node:fs");

function log(entry) {
  fs.appendFileSync(
    process.env.PIPELINE_TRACER_LOG,
    JSON.stringify(entry) + "\\n"
  );
}

const args = process.argv.slice(2);
log({ type: "command", command: "project-test", args, cwd: process.cwd() });

const statePath = process.env.PIPELINE_TRACER_STATE;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { testRuns: 0 };
state.testRuns += 1;
fs.writeFileSync(statePath, JSON.stringify(state));
if (state.testRuns === 1) {
  process.stdout.write("✗ tracer feature should start red");
  process.exit(1);
}
process.stdout.write("✓ tracer feature should pass after implementation");
process.exit(0);
`
  );

  writeExecutable(
    env.binPath,
    "bunx",
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.PIPELINE_TRACER_LOG,
  JSON.stringify({ type: "command", command: "bunx", args, cwd: process.cwd() }) + "\\n"
);
if (args[0] === "jscpd") {
  process.stdout.write(JSON.stringify({ duplicates: [] }));
  process.exit(0);
}
process.stderr.write("Unexpected bunx command: " + args.join(" "));
process.exit(1);
`
  );

  writeExecutable(
    env.binPath,
    "project-typecheck",
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(
  process.env.PIPELINE_TRACER_LOG,
  JSON.stringify({ type: "command", command: "project-typecheck", args: process.argv.slice(2), cwd: process.cwd() }) + "\\n"
);
`
  );
}

function readCommandLog(logPath: string): LoggedCommand[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedCommand);
}

function backlogStatusUpdates(logPath: string): [string, string][] {
  return readCommandLog(logPath)
    .filter(
      (entry) =>
        entry.type === "backlog" &&
        entry.args?.[0] === "task" &&
        entry.args?.[1] === "edit" &&
        entry.args.includes("--status")
    )
    .map((entry) => [
      entry.args?.[2] ?? "",
      entry.args?.[entry.args.indexOf("--status") + 1] ?? "",
    ]);
}

function backlogCreateTaskIds(logPath: string): string[] {
  return readCommandLog(logPath)
    .filter(
      (entry) =>
        entry.type === "backlog" &&
        entry.args?.[0] === "task" &&
        entry.args?.[1] === "create"
    )
    .map((entry) => entry.args?.[2] ?? "");
}

function backlogNoteUpdates(logPath: string): [string, string][] {
  return readCommandLog(logPath)
    .filter(
      (entry) =>
        entry.type === "backlog" &&
        entry.args?.[0] === "task" &&
        entry.args?.[1] === "edit" &&
        entry.args.includes("--append-notes")
    )
    .map((entry) => [
      entry.args?.[2] ?? "",
      entry.args?.[entry.args.indexOf("--append-notes") + 1] ?? "",
    ]);
}

async function localKnowledgeMarkdown(worktreePath: string): Promise<string> {
  const knowledgeDir = join(worktreePath, ".pipeline", "knowledge");
  let files: string[];
  try {
    files = (await readdir(knowledgeDir)).filter((file) =>
      file.endsWith(".md")
    );
  } catch {
    return "";
  }
  const contents = await Promise.all(
    files.map((file) => readFile(join(knowledgeDir, file), "utf8"))
  );
  return contents.join("\n");
}

describe("PIPE-14 tracer-bullet pipeline", () => {
  let env: TracerEnvironment;
  let originalPath: string | undefined;
  let originalTargetPath: string | undefined;
  let originalTracerLog: string | undefined;
  let originalTracerState: string | undefined;
  let originalTracerVerdict: string | undefined;
  let originalTestCommand: string | undefined;
  let originalTypecheckCommand: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "pipe-14-tracer-"));
    env = {
      binPath: join(root, "bin"),
      logPath: join(root, "commands.jsonl"),
      statePath: join(root, "state.json"),
      worktreePath: join(root, "worktree"),
    };
    mkdirSync(env.worktreePath);
    writeFixtureWorktree(env.worktreePath);
    writeFakeExecutables(env);
    writeFileSync(env.logPath, "");

    originalPath = process.env.PATH;
    originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    originalTracerLog = process.env.PIPELINE_TRACER_LOG;
    originalTracerState = process.env.PIPELINE_TRACER_STATE;
    originalTracerVerdict = process.env.PIPELINE_TRACER_VERDICT;
    originalTestCommand = process.env.PIPELINE_TEST_COMMAND;
    originalTypecheckCommand = process.env.PIPELINE_TYPECHECK_COMMAND;

    process.env.PATH = `${env.binPath}${delimiter}${process.env.PATH ?? ""}`;
    process.env.PIPELINE_TARGET_PATH = env.worktreePath;
    process.env.PIPELINE_TRACER_LOG = env.logPath;
    process.env.PIPELINE_TRACER_STATE = env.statePath;
    process.env.PIPELINE_TEST_COMMAND = "project-test";
    process.env.PIPELINE_TYPECHECK_COMMAND = "project-typecheck";

    vi.spyOn(Date, "now").mockReturnValue(14);
    consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalTargetPath === undefined) {
      delete process.env.PIPELINE_TARGET_PATH;
    } else {
      process.env.PIPELINE_TARGET_PATH = originalTargetPath;
    }
    if (originalTracerLog === undefined) {
      delete process.env.PIPELINE_TRACER_LOG;
    } else {
      process.env.PIPELINE_TRACER_LOG = originalTracerLog;
    }
    if (originalTracerState === undefined) {
      delete process.env.PIPELINE_TRACER_STATE;
    } else {
      process.env.PIPELINE_TRACER_STATE = originalTracerState;
    }
    if (originalTracerVerdict === undefined) {
      delete process.env.PIPELINE_TRACER_VERDICT;
    } else {
      process.env.PIPELINE_TRACER_VERDICT = originalTracerVerdict;
    }
    if (originalTestCommand === undefined) {
      delete process.env.PIPELINE_TEST_COMMAND;
    } else {
      process.env.PIPELINE_TEST_COMMAND = originalTestCommand;
    }
    if (originalTypecheckCommand === undefined) {
      delete process.env.PIPELINE_TYPECHECK_COMMAND;
    } else {
      process.env.PIPELINE_TYPECHECK_COMMAND = originalTypecheckCommand;
    }

    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(join(env.binPath, ".."), { force: true, recursive: true });
  });

  it("runs the integrated tracer to PASS through real child-process commands", async () => {
    process.env.PIPELINE_TRACER_VERDICT = "PASS";

    await pipe("PIPE-14 tracer bullet", { strict: true, harness: "claude" });

    const contextPath = join(
      env.worktreePath,
      ".pipeline",
      "knowledge-context.md"
    );
    const researchPath = join(env.worktreePath, ".pipeline", "research.json");
    const localKnowledge = await localKnowledgeMarkdown(env.worktreePath);
    const rolePrompts = readCommandLog(env.logPath)
      .filter((entry) => entry.type === "role")
      .map((entry) => entry.prompt ?? "");

    expect(consoleLogSpy).toHaveBeenCalledWith("Pipeline complete: PASS");
    expect(existsSync(contextPath)).toBe(true);
    expect(readFileSync(contextPath, "utf8")).toContain("Current Rules");
    expect(readFileSync(contextPath, "utf8")).not.toContain(
      ".pipeline/knowledge"
    );
    expect(readFileSync(researchPath, "utf8")).toContain(
      "researched deterministic integrated pipeline behavior"
    );
    expect(localKnowledge).toBe("");
    expect(rolePrompts.some((prompt) => prompt.includes("Test first"))).toBe(
      true
    );
    expect(rolePrompts.some((prompt) => prompt.includes("researcher"))).toBe(
      true
    );
    expect(rolePrompts.some((prompt) => prompt.includes("test-writer"))).toBe(
      true
    );
    expect(rolePrompts.some((prompt) => prompt.includes("code-writer"))).toBe(
      true
    );
    expect(rolePrompts.some((prompt) => prompt.includes("code verifier"))).toBe(
      true
    );
    // createSwarmTasks now creates a real parent + 5 children. `args[2]` of
    // `backlog task create` is the title, not the id (backlog auto-assigns
    // ids). The fake backlog binary issues TASK-1 (parent) then
    // TASK-1.1..TASK-1.5 (children); assertion on the assigned ids happens
    // indirectly via the status-updates assertion below.
    expect(backlogCreateTaskIds(env.logPath)).toEqual([
      "PIPE-14 tracer bullet",
      "PIPE-14 tracer bullet — research",
      "PIPE-14 tracer bullet — test-write",
      "PIPE-14 tracer bullet — implement",
      "PIPE-14 tracer bullet — verify",
      "PIPE-14 tracer bullet — learn",
    ]);
    expect(backlogStatusUpdates(env.logPath)).toEqual([
      ["TASK-1.1", "In Progress"],
      ["TASK-1.1", "Done"],
      ["TASK-1.2", "In Progress"],
      ["TASK-1.2", "Done"],
      ["TASK-1.3", "In Progress"],
      ["TASK-1.3", "Done"],
      ["TASK-1.4", "In Progress"],
      ["TASK-1.4", "Done"],
      ["TASK-1.5", "In Progress"],
      ["TASK-1.5", "Done"],
    ]);
    expect(backlogNoteUpdates(env.logPath)).toEqual([]);
  });

  it("runs the integrated tracer to FAIL and preserves failed phase evidence", async () => {
    process.env.PIPELINE_TRACER_VERDICT = "FAIL";

    await pipe("PIPE-14 tracer bullet", { strict: true, harness: "claude" });

    const notes = backlogNoteUpdates(env.logPath);

    expect(consoleLogSpy).toHaveBeenCalledWith("Pipeline complete: FAIL");
    expect(await localKnowledgeMarkdown(env.worktreePath)).toBe("");
    expect(backlogStatusUpdates(env.logPath)).toEqual([
      ["TASK-1.1", "In Progress"],
      ["TASK-1.1", "Done"],
      ["TASK-1.2", "In Progress"],
      ["TASK-1.2", "Done"],
      ["TASK-1.3", "In Progress"],
      ["TASK-1.3", "Done"],
      ["TASK-1.4", "In Progress"],
    ]);
    expect(backlogStatusUpdates(env.logPath)).not.toContainEqual([
      "TASK-1.4",
      "Done",
    ]);
    expect(backlogStatusUpdates(env.logPath)).not.toContainEqual([
      "TASK-1.5",
      "In Progress",
    ]);
    expect(notes).toEqual([
      [
        "TASK-1.4",
        "VERIFY gate failed: VERIFY gate failed: verification checks did not pass\n\nEvidence:\n- LLM verifier verdict: FAIL\n- verifier found missing edge-case evidence",
      ],
    ]);
  });
});
