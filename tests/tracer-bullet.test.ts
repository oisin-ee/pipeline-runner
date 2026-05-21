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
import { workNext } from "../src/index.js";

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
    JSON.stringify({ scripts: { test: "vitest run" } })
  );
  writeFileSync(join(worktreePath, "tsconfig.json"), "{}");
  mkdirSync(join(worktreePath, "rules"));
  writeFileSync(
    join(worktreePath, "rules", "test-first.md"),
    "# Test first\n\nWrite the failing test before implementation."
  );
  mkdirSync(join(worktreePath, ".pipeline", "knowledge"), {
    recursive: true,
  });
  writeFileSync(
    join(worktreePath, ".pipeline", "knowledge", "2026-01-01.md"),
    "# Existing knowledge\n\nPrefer deterministic tracer fixtures."
  );
}

function writeFakeExecutables(env: TracerEnvironment): void {
  mkdirSync(env.binPath, { recursive: true });

  writeExecutable(
    env.binPath,
    "backlog",
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(
  process.env.PIPELINE_TRACER_LOG,
  JSON.stringify({ type: "backlog", args: process.argv.slice(2), cwd: process.cwd() }) + "\\n"
);
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

if (prompt.includes("You are a researcher")) {
  process.stdout.write("researched deterministic integrated pipeline behavior");
  process.exit(0);
}

if (prompt.includes("You are a test-writer")) {
  fs.writeFileSync(
    path.join(process.cwd(), "pipeline-feature.test.ts"),
    "import { expect, it } from 'vitest';\\nit('starts red', () => expect(false).toBe(true));\\n"
  );
  process.stdout.write("wrote failing tracer test");
  process.exit(0);
}

if (prompt.includes("You are a code-writer")) {
  fs.writeFileSync(
    path.join(process.cwd(), "pipeline-feature.ts"),
    "export const tracerBullet = 'green';\\n"
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
    "bunx",
    `#!/usr/bin/env node
const fs = require("node:fs");

function log(entry) {
  fs.appendFileSync(
    process.env.PIPELINE_TRACER_LOG,
    JSON.stringify(entry) + "\\n"
  );
}

const args = process.argv.slice(2);
log({ type: "command", command: "bunx", args, cwd: process.cwd() });

if (args[0] === "vitest") {
  const statePath = process.env.PIPELINE_TRACER_STATE;
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8"))
    : { vitestRuns: 0 };
  state.vitestRuns += 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (state.vitestRuns === 1) {
    process.stdout.write("✗ tracer feature should start red");
    process.exit(1);
  }
  process.stdout.write("✓ tracer feature should pass after implementation");
  process.exit(0);
}

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
    "tsc",
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(
  process.env.PIPELINE_TRACER_LOG,
  JSON.stringify({ type: "command", command: "tsc", args: process.argv.slice(2), cwd: process.cwd() }) + "\\n"
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

async function learnedOutcome(worktreePath: string): Promise<string> {
  const knowledgeDir = join(worktreePath, ".pipeline", "knowledge");
  const files = (await readdir(knowledgeDir)).filter((file) =>
    file.endsWith(".md")
  );
  const contents = await Promise.all(
    files.map((file) => readFile(join(knowledgeDir, file), "utf8"))
  );
  return contents.find((content) => content.includes("## Outcome:")) ?? "";
}

describe("PIPE-14 tracer-bullet pipeline", () => {
  let env: TracerEnvironment;
  let originalHarness: string | undefined;
  let originalPath: string | undefined;
  let originalTargetPath: string | undefined;
  let originalTracerLog: string | undefined;
  let originalTracerState: string | undefined;
  let originalTracerVerdict: string | undefined;
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

    originalHarness = process.env.PIPELINE_HARNESS;
    originalPath = process.env.PATH;
    originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    originalTracerLog = process.env.PIPELINE_TRACER_LOG;
    originalTracerState = process.env.PIPELINE_TRACER_STATE;
    originalTracerVerdict = process.env.PIPELINE_TRACER_VERDICT;

    process.env.PATH = `${env.binPath}${delimiter}${process.env.PATH ?? ""}`;
    process.env.PIPELINE_HARNESS = "claude";
    process.env.PIPELINE_TARGET_PATH = env.worktreePath;
    process.env.PIPELINE_TRACER_LOG = env.logPath;
    process.env.PIPELINE_TRACER_STATE = env.statePath;

    vi.spyOn(Date, "now").mockReturnValue(14);
    consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalHarness === undefined) {
      delete process.env.PIPELINE_HARNESS;
    } else {
      process.env.PIPELINE_HARNESS = originalHarness;
    }
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

    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(join(env.binPath, ".."), { force: true, recursive: true });
  });

  it("runs the integrated tracer to PASS through real child-process commands", async () => {
    process.env.PIPELINE_TRACER_VERDICT = "PASS";

    await workNext("PIPE-14 tracer bullet");

    const contextPath = join(
      env.worktreePath,
      ".pipeline",
      "knowledge-context.md"
    );
    const researchPath = join(env.worktreePath, ".pipeline", "research.json");
    const learned = await learnedOutcome(env.worktreePath);
    const rolePrompts = readCommandLog(env.logPath)
      .filter((entry) => entry.type === "role")
      .map((entry) => entry.prompt ?? "");

    expect(consoleLogSpy).toHaveBeenCalledWith("Pipeline complete: PASS");
    expect(existsSync(contextPath)).toBe(true);
    expect(readFileSync(contextPath, "utf8")).toContain("Current Rules");
    expect(readFileSync(contextPath, "utf8")).toContain(
      "Recent Learned Knowledge"
    );
    expect(readFileSync(researchPath, "utf8")).toContain(
      "researched deterministic integrated pipeline behavior"
    );
    expect(learned).toContain("## Outcome: PASS");
    expect(learned).toContain("tracer feature should pass");
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
    expect(backlogCreateTaskIds(env.logPath)).toEqual([
      "TASK-14-R",
      "TASK-14-TW",
      "TASK-14-CW",
      "TASK-14-V",
      "TASK-14-L",
    ]);
    expect(backlogStatusUpdates(env.logPath)).toEqual([
      ["TASK-14-R", "In Progress"],
      ["TASK-14-R", "Done"],
      ["TASK-14-TW", "In Progress"],
      ["TASK-14-TW", "Done"],
      ["TASK-14-CW", "In Progress"],
      ["TASK-14-CW", "Done"],
      ["TASK-14-V", "In Progress"],
      ["TASK-14-V", "Done"],
      ["TASK-14-L", "In Progress"],
      ["TASK-14-L", "Done"],
    ]);
    expect(backlogNoteUpdates(env.logPath)).toEqual([]);
  });

  it("runs the integrated tracer to FAIL and preserves failed phase evidence", async () => {
    process.env.PIPELINE_TRACER_VERDICT = "FAIL";

    await workNext("PIPE-14 tracer bullet");

    const learned = await learnedOutcome(env.worktreePath);
    const notes = backlogNoteUpdates(env.logPath);

    expect(consoleLogSpy).toHaveBeenCalledWith("Pipeline complete: FAIL");
    expect(learned).toContain("## Outcome: FAIL");
    expect(learned).toContain("tracer feature should pass");
    expect(backlogStatusUpdates(env.logPath)).toEqual([
      ["TASK-14-R", "In Progress"],
      ["TASK-14-R", "Done"],
      ["TASK-14-TW", "In Progress"],
      ["TASK-14-TW", "Done"],
      ["TASK-14-CW", "In Progress"],
      ["TASK-14-CW", "Done"],
      ["TASK-14-V", "In Progress"],
    ]);
    expect(backlogStatusUpdates(env.logPath)).not.toContainEqual([
      "TASK-14-V",
      "Done",
    ]);
    expect(backlogStatusUpdates(env.logPath)).not.toContainEqual([
      "TASK-14-L",
      "In Progress",
    ]);
    expect(notes).toEqual([
      [
        "TASK-14-V",
        "VERIFY gate failed: VERIFY gate failed: verification checks did not pass\n\nEvidence:\n- LLM verifier verdict: FAIL\n- verifier found missing edge-case evidence",
      ],
    ]);
  });
});
