import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatInstallRulesResult,
  type InstallRulesResult,
  installRules,
  type RulesyncRunner,
} from "../src/install-rules";

interface RunnerCall {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function makeCapturingRunner(): {
  calls: RunnerCall[];
  runner: RulesyncRunner;
} {
  const calls: RunnerCall[] = [];
  const runner: RulesyncRunner = (args, opts) => {
    calls.push({ args, cwd: opts.cwd, env: opts.env });
    return Promise.resolve();
  };
  return { calls, runner };
}

function writeRuleFragment(dir: string, name: string, body: string): void {
  const rulesDir = join(dir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, name), `${body}\n`);
}

describe("installRules", () => {
  let sourceDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "install-rules-source-"));
  });

  afterEach(() => {
    rmSync(sourceDir, { force: true, recursive: true });
  });

  it("(a) concatenates fragment files in ascending filename order", async () => {
    writeRuleFragment(sourceDir, "10-b.md", "# Rule B\n\nContent of B.");
    writeRuleFragment(sourceDir, "00-a.md", "# Rule A\n\nContent of A.");
    writeRuleFragment(sourceDir, "20-c.md", "# Rule C\n\nContent of C.");

    const { calls, runner } = makeCapturingRunner();
    await installRules({
      rulesyncRunner: runner,
      sourceOverride: sourceDir,
    });

    // The _root.md should be written — verify its body order by reading it.
    const rootMd = join(sourceDir, ".rulesync", "rules", "_root.md");
    expect(existsSync(rootMd)).toBe(true);
    const content = readFileSync(rootMd, "utf8");
    const aIndex = content.indexOf("Content of A.");
    const bIndex = content.indexOf("Content of B.");
    const cIndex = content.indexOf("Content of C.");
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(bIndex).toBeGreaterThan(aIndex);
    expect(cIndex).toBeGreaterThan(bIndex);
    expect(calls).toHaveLength(1);
  });

  it("(b) writes _root.md with root: true frontmatter and merged body", async () => {
    writeRuleFragment(sourceDir, "00-a.md", "# Rule A\n\nDo the thing.");
    writeRuleFragment(sourceDir, "10-b.md", "# Rule B\n\nAnother rule.");

    const { runner } = makeCapturingRunner();
    await installRules({
      rulesyncRunner: runner,
      sourceOverride: sourceDir,
    });

    const rootMd = join(sourceDir, ".rulesync", "rules", "_root.md");
    const content = readFileSync(rootMd, "utf8");

    expect(content).toContain("root: true");
    expect(content).toContain('targets:\n  - "*"');
    expect(content).toContain("# Rule A");
    expect(content).toContain("Do the thing.");
    expect(content).toContain("# Rule B");
    expect(content).toContain("Another rule.");
    expect(content.startsWith("---\nroot: true\n")).toBe(true);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("(c) runner is invoked with correct args and HOME_DIR env set", async () => {
    writeRuleFragment(sourceDir, "00-a.md", "# Rule A");

    const { calls, runner } = makeCapturingRunner();
    const savedHomeDir = process.env.HOME_DIR;
    process.env.HOME_DIR = "/test/home";
    try {
      await installRules({
        rulesyncRunner: runner,
        sourceOverride: sourceDir,
      });
    } finally {
      if (savedHomeDir === undefined) {
        delete process.env.HOME_DIR;
      } else {
        process.env.HOME_DIR = savedHomeDir;
      }
    }

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.args).toEqual([
      "generate",
      "-t",
      "claudecode,codexcli,geminicli,opencode",
      "-f",
      "rules",
      "--delete",
    ]);
    expect(call.env.HOME_DIR).toBe("/test/home");
    expect(call.cwd).toBe(sourceDir);
  });

  it("(d) returns the four expected home-relative output paths", async () => {
    writeRuleFragment(sourceDir, "00-a.md", "# Rule A");

    const { runner } = makeCapturingRunner();
    const savedHomeDir = process.env.HOME_DIR;
    process.env.HOME_DIR = "/fake/home";
    let result: InstallRulesResult;
    try {
      result = await installRules({
        rulesyncRunner: runner,
        sourceOverride: sourceDir,
      });
    } finally {
      if (savedHomeDir === undefined) {
        delete process.env.HOME_DIR;
      } else {
        process.env.HOME_DIR = savedHomeDir;
      }
    }

    const paths = result.items.map((item) => item.path);
    expect(paths).toContain("/fake/home/.claude/CLAUDE.md");
    expect(paths).toContain("/fake/home/.codex/AGENTS.md");
    expect(paths).toContain("/fake/home/.gemini/GEMINI.md");
    expect(paths).toContain("/fake/home/.config/opencode/AGENTS.md");
    expect(paths).toHaveLength(4);
  });

  it("(e) dryRun: true adds --dry-run to args and uses action skip", async () => {
    writeRuleFragment(sourceDir, "00-a.md", "# Rule A");

    const { calls, runner } = makeCapturingRunner();
    const result = await installRules({
      dryRun: true,
      rulesyncRunner: runner,
      sourceOverride: sourceDir,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--dry-run");
    expect(result.items.every((item) => item.action === "skip")).toBe(true);
  });

  it("source field is always DEFAULT_RULES_INSTALL_SOURCE", async () => {
    const { runner } = makeCapturingRunner();
    const result = await installRules({
      rulesyncRunner: runner,
      sourceOverride: sourceDir,
    });

    expect(result.source).toBe("oisin-ee/rules");
  });

  it("works with an empty rules/ directory producing a root-only file", async () => {
    mkdirSync(join(sourceDir, "rules"), { recursive: true });

    const { runner } = makeCapturingRunner();
    await installRules({
      rulesyncRunner: runner,
      sourceOverride: sourceDir,
    });

    const rootMd = join(sourceDir, ".rulesync", "rules", "_root.md");
    const content = readFileSync(rootMd, "utf8");
    expect(content).toContain("root: true");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("uses npx with the pinned rulesync package when no runner is injected", async () => {
    writeRuleFragment(sourceDir, "00-a.md", "# Rule A");
    const binDir = mkdtempSync(join(tmpdir(), "install-rules-bin-"));
    const argsFile = join(binDir, "npx-args.json");
    const npxPath = join(binDir, "npx");
    writeFileSync(
      npxPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
      ].join("\n")
    );
    chmodSync(npxPath, 0o755);

    const savedPath = process.env.PATH;
    process.env.PATH = [binDir, savedPath].filter(Boolean).join(":");
    try {
      await installRules({ sourceOverride: sourceDir });
    } finally {
      if (savedPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = savedPath;
      }
    }

    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([
      "--yes",
      "rulesync@8.30.1",
      "generate",
      "-t",
      "claudecode,codexcli,geminicli,opencode",
      "-f",
      "rules",
      "--delete",
    ]);
    rmSync(binDir, { force: true, recursive: true });
  });
});

describe("formatInstallRulesResult", () => {
  it("formats each item as action + path", () => {
    const result: InstallRulesResult = {
      items: [
        { action: "generate", path: "/home/.claude/CLAUDE.md" },
        { action: "skip", path: "/home/.codex/AGENTS.md" },
      ],
      source: "oisin-ee/rules",
    };
    const output = formatInstallRulesResult(result);
    expect(output).toBe(
      "generate /home/.claude/CLAUDE.md\nskip /home/.codex/AGENTS.md"
    );
  });
});
