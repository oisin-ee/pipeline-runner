import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipe } from "../src/index";

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
  writeFileSync(
    join(worktreePath, ".pipeline", "runners.yaml"),
    `version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      rules: false
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, jsonl, json_schema]
`
  );
  writeFileSync(
    join(worktreePath, ".pipeline", "profiles.yaml"),
    `version: 1
profiles:
  orchestrator:
    runner: codex
    instructions:
      inline: Coordinate the tracer pipeline.
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  researcher:
    runner: codex
    instructions:
      inline: You are a researcher for the tracer pipeline.
    tools: [read, list, grep, glob, bash]
    output: { format: text }
  test-writer:
    runner: codex
    instructions:
      inline: You are a test-writer for the tracer pipeline.
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem: { mode: workspace-write }
    output: { format: text }
  code-writer:
    runner: codex
    instructions:
      inline: You are a code-writer for the tracer pipeline.
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem: { mode: workspace-write }
    output: { format: text }
  verifier:
    runner: codex
    instructions:
      inline: You are a code verifier for the tracer pipeline.
    tools: [read, list, grep, glob, bash]
    output: { format: text }
  learner:
    runner: codex
    instructions:
      inline: You are the LEARN phase for the tracer pipeline.
    tools: [read, list, grep, glob, bash]
    output: { format: text }
`
  );
  writeFileSync(
    join(worktreePath, ".pipeline", "pipeline.yaml"),
    `version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
hooks:
  functions: {}
  on: {}
workflows:
  default:
    nodes:
      - id: research
        kind: agent
        profile: researcher
      - id: red
        kind: agent
        profile: test-writer
        needs: [research]
        gates:
          - kind: command
            command: [project-test]
            expect_exit_code: 1
      - id: green
        kind: agent
        profile: code-writer
        needs: [red]
        gates:
          - kind: builtin
            builtin: test
          - kind: builtin
            builtin: typecheck
      - id: verify
        kind: agent
        profile: verifier
        needs: [green]
      - id: learn
        kind: agent
        profile: learner
        needs: [verify]
`
  );
  execFileSync("git", ["init"], { cwd: worktreePath, stdio: "ignore" });
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
    "codex",
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
const prompt = args.at(-1) || "";
log({ type: "role", args, prompt, cwd: process.cwd() });

if (
  prompt.includes("You are a researcher") ||
  prompt.includes("You are a bounded researcher") ||
  prompt.includes("pipeline-researcher")
) {
  process.stdout.write(JSON.stringify({
    ac: ["integrated tracer reaches deterministic pipeline behavior"],
    findings: ["researched deterministic integrated pipeline behavior"],
    risks: []
  }));
  process.exit(0);
}

if (
  prompt.includes("You are the LEARN phase") ||
  prompt.includes("pipeline-learner")
) {
  process.stdout.write(JSON.stringify({
    qdrant: { attempted: true, succeeded: true },
    evidence: ["stored tracer lesson"]
  }));
  process.exit(0);
}

if (
  prompt.includes("You are a test-writer") ||
  prompt.includes("pipeline-test-writer")
) {
  fs.writeFileSync(
    path.join(process.cwd(), "pipeline-feature.test.ts"),
    "starts red for the configured project test command\\n"
  );
  process.stdout.write(JSON.stringify({
    changes: [
      {
        summary: "Added tracer failing test",
        why: "The RED phase needs a focused failing test before implementation",
        files: ["pipeline-feature.test.ts"]
      }
    ],
    verification: ["project-test fails before implementation"]
  }));
  process.exit(0);
}

if (
  prompt.includes("You are a code-writer") ||
  prompt.includes("pipeline-code-writer")
) {
  fs.writeFileSync(
    path.join(process.cwd(), "pipeline-feature.impl"),
    "tracerBullet=green\\n"
  );
  process.stdout.write(JSON.stringify({
    changes: [
      {
        summary: "Implemented tracer feature",
        why: "The tracer test requires the feature marker to pass",
        files: ["pipeline-feature.impl"]
      }
    ],
    verification: ["project-test passes after implementation"]
  }));
  process.exit(0);
}

if (
  prompt.includes("You are an acceptance reviewer") ||
  prompt.includes("pipeline-acceptance-reviewer")
) {
  process.stdout.write(JSON.stringify({
    verdict: "PASS",
    evidence: ["acceptance passed"],
    acceptance: [{ id: "1", verdict: "PASS", evidence: ["accepted"] }],
    violations: []
  }));
  process.exit(0);
}

if (
  prompt.includes("You are a code verifier") ||
  prompt.includes("pipeline-verifier")
) {
  const verdict = process.env.PIPELINE_TRACER_VERDICT || "PASS";
  const evidence =
    verdict === "PASS"
      ? ["implementation matches tracer task"]
      : ["verifier found missing edge-case evidence"];
  process.stdout.write(JSON.stringify({ verdict, evidence }));
  if (verdict !== "PASS") {
    process.exit(1);
  }
  process.exit(0);
}

process.stderr.write("Unknown codex prompt");
process.exit(1);
`
  );

  writeExecutable(
    env.binPath,
    "opencode",
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const result = spawnSync("codex", process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
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

if (!fs.existsSync("pipeline-feature.impl")) {
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
    "uvx",
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.PIPELINE_TRACER_LOG,
  JSON.stringify({ type: "command", command: "uvx", args, cwd: process.cwd() }) + "\\n"
);
if (args[0] === "semgrep") {
  process.stdout.write("semgrep clean");
  process.exit(0);
}
process.stderr.write("Unexpected uvx command: " + args.join(" "));
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

    await pipe("PIPE-14 tracer bullet", { workflow: "default" });

    const rolePrompts = readCommandLog(env.logPath)
      .filter((entry) => entry.type === "role")
      .map((entry) => entry.prompt ?? "");

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pipeline complete: PASS")
    );
    expect(rolePrompts.some((prompt) => prompt.includes("Test first"))).toBe(
      false
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
    expect(
      rolePrompts.some(
        (prompt) =>
          prompt.includes("code verifier") ||
          prompt.includes("pipeline-verifier")
      )
    ).toBe(true);
    expect(
      readCommandLog(env.logPath).some((entry) => entry.type === "backlog")
    ).toBe(false);
  });

  it("runs the integrated tracer to FAIL and blocks dependent nodes", async () => {
    process.env.PIPELINE_TRACER_VERDICT = "FAIL";

    await expect(
      pipe("PIPE-14 tracer bullet", { workflow: "default" })
    ).rejects.toThrow("Pipeline failed");

    const rolePrompts = readCommandLog(env.logPath)
      .filter((entry) => entry.type === "role")
      .map((entry) => entry.prompt ?? "");

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pipeline complete: FAIL")
    );
    expect(
      rolePrompts.some(
        (prompt) =>
          prompt.includes("code verifier") ||
          prompt.includes("pipeline-verifier")
      )
    ).toBe(true);
    expect(rolePrompts.some((prompt) => prompt.includes("LEARN phase"))).toBe(
      false
    );
  });
});
