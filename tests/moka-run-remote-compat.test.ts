import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliProgram } from "../src/cli/program";
import type { submitMoka } from "../src/moka-submit";
import { runnerCommandPayloadSchema } from "../src/runner-command-contract";

type CapturedMokaSubmitInput = Parameters<typeof submitMoka>[0];

const mockState = vi.hoisted(() => ({
  submitInputs: [] as unknown[],
}));

vi.mock("../src/moka-global-config", () => ({
  loadMokaGlobalConfig: vi.fn(() => ({
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
  })),
}));

vi.mock("../src/moka-submit", () => ({
  submitMoka: vi.fn((input: unknown) => {
    mockState.submitInputs.push(input);
    return Promise.resolve({
      namespace: "test-runners",
      workflowName: "submitted-run",
    });
  }),
}));

const ORIGINAL_PIPELINE_TARGET_PATH = process.env.PIPELINE_TARGET_PATH;

beforeEach(() => {
  mockState.submitInputs.length = 0;
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_PIPELINE_TARGET_PATH === undefined) {
    delete process.env.PIPELINE_TARGET_PATH;
  } else {
    process.env.PIPELINE_TARGET_PATH = ORIGINAL_PIPELINE_TARGET_PATH;
  }
});

async function withTempWorktree(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "moka-run-remote-compat-"));
  process.env.PIPELINE_TARGET_PATH = dir;
  try {
    await run();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

async function parseMoka(args: string[]): Promise<void> {
  await createCliProgram().parseAsync(
    ["node", "/repo/node_modules/.bin/moka", ...args],
    { from: "node" }
  );
}

function onlySubmitInput(): CapturedMokaSubmitInput {
  if (mockState.submitInputs.length !== 1) {
    throw new Error(
      `Expected exactly one moka submit input, received ${mockState.submitInputs.length}`
    );
  }
  return mockState.submitInputs[0] as CapturedMokaSubmitInput;
}

function graphSubmitShape(input: CapturedMokaSubmitInput) {
  if (input.type !== "graph") {
    throw new Error(`Expected graph submit input, received ${input.type}`);
  }
  return {
    mode: input.mode,
    schedulePath: input.schedulePath,
    task: input.task,
    type: input.type,
    worktreePath: input.worktreePath,
  };
}

function baseRunnerPayload(mode: "execute" | "full" | "quick") {
  return {
    events: {
      authTokenFile: "/etc/pipeline/event-auth/token",
      url: "https://console.example/api/pipeline/runner-events",
    },
    repository: {
      baseBranch: "main",
      sha: "0123456789abcdef0123456789abcdef01234567",
      url: "https://github.com/oisin-ee/rondo.git",
    },
    run: { id: "run-remote-compat", project: "rondo" },
    submission: { kind: "graph", mode },
    task: { kind: "prompt", prompt: "Ship remote compatibility" },
    workflow: { id: "schedule-run-remote-compat-root" },
  };
}

describe("moka run remote submit compatibility", () => {
  it("submits the same quick graph shape as the existing moka submit --quick path", async () => {
    await withTempWorktree(async () => {
      await parseMoka([
        "run",
        "Ship the quick remote graph",
        "--target",
        "remote",
        "--effort",
        "quick",
      ]);
      const runSubmitShape = graphSubmitShape(onlySubmitInput());

      mockState.submitInputs.length = 0;

      await parseMoka(["submit", "--quick", "Ship the quick remote graph"]);
      const submitAliasShape = graphSubmitShape(onlySubmitInput());

      expect(runSubmitShape).toEqual(submitAliasShape);
      expect(runSubmitShape).toMatchObject({ mode: "quick", type: "graph" });
    });
  });

  it("maps thorough remote runs to the full graph submission mode", async () => {
    await withTempWorktree(async () => {
      await parseMoka([
        "run",
        "Ship the full remote graph",
        "--target",
        "remote",
        "--effort",
        "thorough",
      ]);

      expect(graphSubmitShape(onlySubmitInput())).toMatchObject({
        mode: "full",
        task: "Ship the full remote graph",
        type: "graph",
      });
    });
  });

  it("documents moka submit as a compatibility alias with canonical moka run equivalents", () => {
    const program = createCliProgram();
    const submitCommand = program.commands.find(
      (command) => command.name() === "submit"
    );
    const help = submitCommand?.helpInformation() ?? "";
    const compactHelp = help.replace(/\s+/g, " ");

    expect(compactHelp).toContain(
      'Compatibility alias for `moka run "<task>" --target remote --effort thorough`'
    );
    expect(compactHelp).toContain(
      'Quick equivalent: `moka run "<task>" --target remote --effort quick`'
    );
    expect(compactHelp).toContain(
      "Command equivalent: `moka run --target remote --command -- <argv...>`"
    );
  });

  it("submits explicit argv through moka run --target remote --command", async () => {
    await withTempWorktree(async () => {
      await parseMoka([
        "run",
        "--target",
        "remote",
        "--command",
        "--",
        "bun",
        "test",
      ]);

      expect(onlySubmitInput()).toMatchObject({
        commandArgv: ["bun", "test"],
        type: "command",
      });
    });
  });

  it("keeps runner graph payload modes compatible with full and quick only", () => {
    expect(
      runnerCommandPayloadSchema.safeParse(baseRunnerPayload("full")).success
    ).toBe(true);
    expect(
      runnerCommandPayloadSchema.safeParse(baseRunnerPayload("quick")).success
    ).toBe(true);
    expect(
      runnerCommandPayloadSchema.safeParse(baseRunnerPayload("execute")).success
    ).toBe(false);
  });
});
