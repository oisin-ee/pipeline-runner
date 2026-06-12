import { execFileSync } from "node:child_process";
import {
  existsSync,
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

const PUBLIC_MISSING_CONFIG_API_RE =
  /tryLoadPipelineConfig|PIPELINE_CONFIG_MISSING|no exported member|not assignable/i;
const STALE_DOC_RUNTIME_SOURCE_RE =
  /\.pipeline\/pipeline\.yaml[\s\S]{0,120}(source of truth|required|fails without|runtime|runner jobs)|source of truth[\s\S]{0,120}\.pipeline\/pipeline\.yaml|runs a static workflow from `.pipeline\/pipeline\.yaml`/i;
const STALE_GENERATED_RUNTIME_SOURCE_RE =
  /source of truth[\s\S]{0,160}\.pipeline\/pipeline\.yaml|\.pipeline\/pipeline\.yaml[\s\S]{0,160}(source of truth|blocking|authoritative|declares a gate|declared a gate)/i;
const MISSING_EVENT_URL_FAILURE_DOC_RE =
  /without (the private config|it)[^\n.]*fails|fails with a validation error/i;
const CLUSTER_SCOPED_CRD_PREFLIGHT_RE =
  /customresourcedefinitions|CustomResourceDefinition|\bcrds?\b|kubectl\s+get\s+crd/i;
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
  it("does not keep the old runner-job command implementation", () => {
    expect(
      existsSync(join(process.cwd(), "src/commands/runner-job-command.ts"))
    ).toBe(false);
    expect(existsSync(join(process.cwd(), "src/runner-job/run.ts"))).toBe(
      false
    );
    expect(existsSync(join(process.cwd(), "src/k8s-submit.ts"))).toBe(false);
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

  it("loads package-owned skills from the installed package root", () => {
    runChecked("bun", ["run", "build:cli"], { cwd: process.cwd() });

    const consumer = tempConsumerApp();
    writeFileSync(
      join(consumer, "usage.mjs"),
      `
import { loadPackagePipelineConfig } from "@oisincoveney/pipeline/config";

const config = loadPackagePipelineConfig(process.cwd());
if (config.skills.execute.source_root !== "package") {
  throw new Error("execute skill is not package-scoped");
}
if (config.skills.quick.source_root !== "package") {
  throw new Error("quick skill is not package-scoped");
}
if (config.skills.inspect.source_root !== "package") {
  throw new Error("inspect skill is not package-scoped");
}
if (config.skills["claude-code-opencode-execute"].source_root !== "package") {
  throw new Error("claude-code-opencode-execute skill is not package-scoped");
}
`,
      "utf8"
    );

    runChecked("node", ["usage.mjs"], { cwd: consumer });
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

  it("documents Kubernetes runner prerequisites and quick/execute Argo default", () => {
    const guide = readFileSync(
      join(process.cwd(), "docs/operator-guide.md"),
      "utf8"
    );

    expect(guide).toContain("submits Argo Workflows by default");
    expect(guide).toContain("--schedule <path>");
    expect(guide).toContain("~/.config/moka/config.yaml");
    expect(guide).toContain("eventUrl: <runner-event-sink-url>");
    expect(guide).not.toMatch(MISSING_EVENT_URL_FAILURE_DOC_RE);
    expect(guide).toContain('moka submit "fix the login bug" --quick');
    expect(guide).toContain('moka submit "Implement PIPE-54"');
    expect(guide).toContain("--kubeconfig <path>");
    expect(guide).toContain("ServiceAccount");
    expect(guide).toContain(
      "opencodeAuthSecretName: <opencode-auth-secret-name>"
    );
    expect(guide).toContain("eventAuthSecretName: <event-auth-secret-name>");
    expect(guide).toContain("eventAuthSecretKey: <event-auth-secret-key>");
    expect(guide).toContain(
      "gitCredentialsSecretName: <git-credentials-secret-name>"
    );
    expect(guide).toContain("githubAuthSecretName: <github-auth-secret-name>");
    expect(guide).toContain("infra repository scripts");
    expect(guide).not.toContain("pipeline-runner-github-auth");
    expect(guide).not.toContain("moka submit --local");
    expect(guide).not.toContain("oisin-pipeline quick");
    expect(guide).not.toContain("oisin-pipeline execute");
  });

  it("keeps submit code free of cluster-scoped CRD preflight checks", () => {
    const submitSources = ["src/moka-submit.ts", "src/argo-submit.ts"]
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n");

    expect(submitSources).not.toMatch(CLUSTER_SCOPED_CRD_PREFLIGHT_RE);
  });

  it("keeps generated prompts and command text from naming repo-local YAML as the runtime source", () => {
    const generatedText = [
      `src/config.ts\n${readFileSync(join(process.cwd(), "src/config.ts"), "utf8")}`,
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
