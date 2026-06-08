import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPipelineScaffoldFiles } from "../src/pipeline-init.js";

const OPTIONAL_RUNNER_CONFIG_RE = /\bconfig\?:\s*PipelineConfig\b/;
const PUBLIC_MISSING_CONFIG_API_RE =
  /tryLoadPipelineConfig|PIPELINE_CONFIG_MISSING|no exported member|not assignable/i;
const STALE_DOC_RUNTIME_SOURCE_RE =
  /\.pipeline\/pipeline\.yaml[\s\S]{0,120}(source of truth|required|fails without|runtime|runner jobs)|source of truth[\s\S]{0,120}\.pipeline\/pipeline\.yaml|runs a static workflow from `.pipeline\/pipeline\.yaml`/i;
const STALE_GENERATED_RUNTIME_SOURCE_RE =
  /source of truth[\s\S]{0,160}\.pipeline\/pipeline\.yaml|\.pipeline\/pipeline\.yaml[\s\S]{0,160}(source of truth|blocking|authoritative|declares a gate|declared a gate)/i;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempConsumerApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-config-contract-"));
  tempDirs.push(dir);

  const scopeDir = join(dir, "node_modules", "@oisincoveney");
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(process.cwd(), join(scopeDir, "pipeline"), "dir");

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2)
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2022",
        },
        include: ["usage.ts"],
      },
      null,
      2
    )
  );

  return dir;
}

function runChecked(
  command: string,
  args: string[],
  options: { cwd: string }
): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const output = error as {
      message?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    throw new Error(
      [output.message, output.stdout?.toString(), output.stderr?.toString()]
        .filter(Boolean)
        .join("\n")
    );
  }
}

function expectCommandToFail(
  command: string,
  args: string[],
  options: { cwd: string }
): string {
  try {
    execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const output = error as {
      message?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    return [
      output.message,
      output.stdout?.toString(),
      output.stderr?.toString(),
    ]
      .filter(Boolean)
      .join("\n");
  }
  throw new Error(`Expected ${command} ${args.join(" ")} to fail`);
}

describe("package-owned config runtime contract", () => {
  it("does not keep runner-job repository-config guard affordances", () => {
    const devspaceSource = readFileSync(
      join(process.cwd(), "src/runner-job/devspace.ts"),
      "utf8"
    );
    const runnerSource = readFileSync(
      join(process.cwd(), "src/runner-job/run.ts"),
      "utf8"
    );

    expect(devspaceSource).not.toMatch(OPTIONAL_RUNNER_CONFIG_RE);
    expect(runnerSource).not.toContain(
      "Runner jobs require a repository pipeline config"
    );
    expect(runnerSource).not.toContain(
      ".pipeline/pipeline.yaml is required for runner jobs"
    );
  });

  it("does not expose missing-config affordances in the public config API", () => {
    runChecked("bun", ["run", "build:cli"], { cwd: process.cwd() });

    const consumer = tempConsumerApp();
    writeFileSync(
      join(consumer, "usage.ts"),
      `
import { PipelineConfigError, tryLoadPipelineConfig } from "@oisincoveney/pipeline/config";

void tryLoadPipelineConfig;
void new PipelineConfigError("PIPELINE_CONFIG_MISSING", "missing");
`,
      "utf8"
    );

    const output = expectCommandToFail(
      join(process.cwd(), "node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", "tsconfig.json"],
      { cwd: consumer }
    );

    expect(output).toMatch(PUBLIC_MISSING_CONFIG_API_RE);
  }, 30_000);

  it("keeps docs from describing repo-local YAML as the runtime config source", () => {
    const docs = [
      "README.md",
      "docs/operator-guide.md",
      "docs/config-architecture.md",
      "docs/pipeline-console-runner-contract.md",
    ];
    for (const path of docs) {
      expect(readFileSync(join(process.cwd(), path), "utf8")).not.toMatch(
        STALE_DOC_RUNTIME_SOURCE_RE
      );
    }
  });

  it("keeps generated prompts and command text from naming repo-local YAML as the runtime source", () => {
    const generatedText = [
      ...Object.entries(defaultPipelineScaffoldFiles())
        .filter(([path]) =>
          [
            ".pipeline/host-resources/codex.md",
            ".pipeline/host-resources/opencode.md",
            ".pipeline/prompts/orchestrator.md",
            ".pipeline/prompts/verifier.md",
            ".pipeline/prompts/code-writer.md",
          ].includes(path)
        )
        .map(([path, content]) => `${path}\n${content}`),
      `src/install-commands.ts\n${readFileSync(
        join(process.cwd(), "src/install-commands.ts"),
        "utf8"
      )}`,
    ];
    for (const content of generatedText) {
      expect(content).not.toMatch(STALE_GENERATED_RUNTIME_SOURCE_RE);
    }
  });
});
