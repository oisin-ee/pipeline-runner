import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  createTerminalRuntimeReporter,
  formatRuntimeFailure,
  formatRuntimeProgressMessage,
  formatRuntimeResult,
} from "../src/cli/format";
import {
  addMokaSubmitOptions,
  buildMokaSubmitInputFromCli,
  parseImagePullPolicy,
} from "../src/cli/submit-options";
import { loadPackagePipelineConfig } from "../src/config";

const ROOT = process.cwd();
const CLI_APP_SERVICE_FILES = [
  "src/cli/bootstrap-commands.ts",
  "src/cli/loop-commands.ts",
  "src/cli/mcp-gateway-commands.ts",
  "src/cli/plan-commands.ts",
  "src/cli/run-commands.ts",
  "src/cli/run-service.ts",
];
const PROGRAM_MAX_LINES = 520;

const GLOBAL_CONFIG = {
  momokaya: {
    kubernetes: { namespace: "test-runners" },
    submit: {
      brokerAuth: {
        secretKey: "api-key",
        secretName: "broker-api-key",
        url: "https://cliproxy.momokaya.ee",
      },
      eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
      eventAuthSecretName: "event-auth-secret",
      eventUrl: "https://console.example/api/pipeline/runner-events",
      gitCredentialsSecretName: "git-credentials-secret",
      githubAuthSecretName: "github-auth-secret",
      imagePullSecretName: "image-pull-secret",
      serviceAccountName: "runner",
    },
  },
};

describe("PIPE-45.9 CLI app service boundaries", () => {
  it("keeps src/cli/program.ts thin and moves app services to owned modules", () => {
    const missingOwners = CLI_APP_SERVICE_FILES.filter(
      (path) => !existsSync(join(ROOT, path))
    );
    const programText = readFileSync(join(ROOT, "src/cli/program.ts"), "utf8");
    const programLines = programText.split("\n").length;

    expect(missingOwners).toEqual([]);
    expect(programLines).toBeLessThanOrEqual(PROGRAM_MAX_LINES);
    expect(programText).not.toContain("../mcp/gateway-reconcile");
    expect(programText).not.toContain("../pipeline-init");
    expect(programText).not.toContain("../credentials/local-codex-auth-sync");
    expect(programText).not.toContain("../loop/loop-command");
  });
});

describe("PIPE-65 CLI refactor boundaries", () => {
  it("exposes runtime formatting helpers from src/cli/format", () => {
    expect(formatRuntimeProgressMessage).toEqual(expect.any(Function));
    expect(createTerminalRuntimeReporter).toEqual(expect.any(Function));
    expect(formatRuntimeResult).toEqual(expect.any(Function));
    expect(formatRuntimeFailure).toEqual(expect.any(Function));
  });

  it("exposes submit option helpers from src/cli/submit-options", () => {
    expect(addMokaSubmitOptions).toEqual(expect.any(Function));
    expect(buildMokaSubmitInputFromCli).toEqual(expect.any(Function));
    expect(parseImagePullPolicy).toEqual(expect.any(Function));
  });

  it("threads --open-pr into the submit delivery.pullRequest option", () => {
    const config = loadPackagePipelineConfig(process.cwd());
    const withPr = buildMokaSubmitInputFromCli({
      config,
      cwd: "/repo",
      flags: { openPr: true },
      globalConfig: GLOBAL_CONFIG,
      input: ["do a thing"],
    });
    expect(withPr.delivery).toEqual({ pullRequest: true });

    const withoutPr = buildMokaSubmitInputFromCli({
      config,
      cwd: "/repo",
      flags: {},
      globalConfig: GLOBAL_CONFIG,
      input: ["do a thing"],
    });
    expect(withoutPr.delivery).toEqual({ pullRequest: false });
  });
});

describe("PIPE-65 CLI formatting behavior", () => {
  it("keeps terminal runtime event text unchanged after moving formatting out of index", () => {
    expect(
      formatRuntimeProgressMessage({
        nodeIds: ["research", "verify"],
        type: "workflow.start",
        workflowId: "root",
      })
    ).toBe("Pipeline starting: root (research -> verify)");

    expect(
      formatRuntimeProgressMessage({
        attempt: 2,
        nodeId: "research",
        profile: "pipeline-researcher",
        runnerId: "opencode",
        type: "node.start",
      })
    ).toBe(
      "Node starting: research runner=opencode profile=pipeline-researcher attempt=2"
    );
  });
});

describe("PIPE-65 moka submit option normalization", () => {
  it("keeps submit command options registered on the existing CLI surface", () => {
    const command = addMokaSubmitOptions(new Command("submit"));
    const optionNames = new Set(
      command.options.map((option) => option.long).filter(Boolean)
    );

    expect(optionNames).toEqual(
      new Set([
        "--quick",
        "--command",
        "--schedule",
        "--event-url",
        "--open-pr",
        "--task",
        "--name",
        "--generate-name",
        "--namespace",
        "--kubeconfig",
        "--service-account",
        "--image",
        "--image-pull-policy",
        "--image-pull-secret",
      ])
    );
  });

  it("normalizes image pull policy the same way as the current CLI", () => {
    expect(parseImagePullPolicy(undefined)).toBe("Always");
    expect(parseImagePullPolicy("Always")).toBe("Always");
    expect(parseImagePullPolicy("IfNotPresent")).toBe("IfNotPresent");
    expect(parseImagePullPolicy("Never")).toBe("Never");
    expect(parseImagePullPolicy("unexpected")).toBe("Always");
  });
});
