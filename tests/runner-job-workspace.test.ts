import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const detectMock = vi.hoisted(() => vi.fn());

vi.mock("package-manager-detector/detect", () => ({
  detect: detectMock,
}));

import { execa } from "execa";

const WORKSPACE_PATH = "/workspace";
const REDACTED_RE = /<redacted>/;
const REPOSITORY_REQUIRED_RE = /repository is required/;
const SECRET_TOKEN_RE = /super-secret-token/;

const mockExeca = vi.mocked(execa);

beforeEach(() => {
  vi.clearAllMocks();
});

function runnerPayload(): any {
  return {
    repository: {
      baseBranch: "main",
      sha: "0123456789abcdef0123456789abcdef01234567",
      url: "https://github.com/oisin-ee/tova.git",
    },
    run: {
      id: "run_123",
      project: "project_123",
      requestedBy: "user_456",
    },
    task: {
      id: "PIPE-49",
      kind: "ticket",
    },
  };
}

describe("runner-job workspace bootstrap", () => {
  it("clones repository payloads into /workspace and checks out an exact-SHA runner branch", async () => {
    const { prepareRunnerWorkspace } = await import(
      "../src/runner-job/workspace.js"
    );
    const checkoutBranch = vi.fn(() => Promise.resolve(undefined));
    const cwd = vi.fn(() => ({ checkoutBranch }));
    const clone = vi.fn(() => Promise.resolve(undefined));
    const installDependencies = vi.fn(async () => ({
      command: "pnpm i --frozen-lockfile",
      output: "installed",
      status: "installed" as const,
    }));

    const prepared = await prepareRunnerWorkspace({
      createGitClient: () => ({ clone, cwd }),
      env: {},
      installDependencies,
      payload: runnerPayload(),
    });

    expect(clone).toHaveBeenCalledWith(
      "https://github.com/oisin-ee/tova.git",
      WORKSPACE_PATH,
      ["--no-tags"]
    );
    expect(cwd).toHaveBeenCalledWith(WORKSPACE_PATH);
    expect(checkoutBranch).toHaveBeenCalledWith(
      "pipeline/pipe-49",
      "0123456789abcdef0123456789abcdef01234567"
    );
    expect(installDependencies).toHaveBeenCalledWith(WORKSPACE_PATH, {});
    expect(checkoutBranch.mock.invocationCallOrder[0]).toBeLessThan(
      installDependencies.mock.invocationCallOrder[0] ?? 0
    );
    expect(prepared).toEqual({
      dependencyBootstrap: {
        command: "pnpm i --frozen-lockfile",
        output: "installed",
        status: "installed",
      },
      env: { PIPELINE_TARGET_PATH: WORKSPACE_PATH },
      worktreePath: WORKSPACE_PATH,
    });
  });

  it("installs cloned repository dependencies with a frozen package-manager command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-runner-workspace-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({}));
      detectMock.mockResolvedValueOnce({ agent: "pnpm" });
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Lockfile is up to date",
        stderr: "",
      } as any);
      const { installRunnerWorkspaceDependencies } = await import(
        "../src/runner-job/workspace.js"
      );

      const result = await installRunnerWorkspaceDependencies(dir, {
        NPM_CONFIG_AUDIT: "false",
      });

      expect(result).toEqual({
        command: "pnpm i --frozen-lockfile",
        output: "Lockfile is up to date",
        status: "installed",
      });
      expect(mockExeca).toHaveBeenCalledWith(
        "pnpm",
        ["i", "--frozen-lockfile"],
        {
          cwd: dir,
          env: { NPM_CONFIG_AUDIT: "false" },
        }
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("does not install dependencies for an already prepared workspace", async () => {
    const { prepareRunnerWorkspace } = await import(
      "../src/runner-job/workspace.js"
    );
    const installDependencies = vi.fn();

    const prepared = await prepareRunnerWorkspace({
      env: { PIPELINE_TARGET_PATH: "/existing/workspace" },
      installDependencies,
      payload: runnerPayload(),
    });

    expect(installDependencies).not.toHaveBeenCalled();
    expect(prepared).toEqual({
      dependencyBootstrap: {
        reason: "existing PIPELINE_TARGET_PATH or cwd is already prepared",
        status: "skipped",
      },
      env: { PIPELINE_TARGET_PATH: "/existing/workspace" },
      worktreePath: "/existing/workspace",
    });
  });

  it("redacts credentials if git reports a credentialized clone URL error", async () => {
    const { prepareRunnerWorkspace } = await import(
      "../src/runner-job/workspace.js"
    );
    const clone = vi.fn(() =>
      Promise.reject(
        new Error(
          "fatal: https://x-access-token:super-secret-token@github.com/oisin-ee/tova.git denied"
        )
      )
    );

    await expect(
      prepareRunnerWorkspace({
        createGitClient: () => ({
          clone,
          cwd: vi.fn(() => ({ checkoutBranch: vi.fn() })),
        }),
        env: { PIPELINE_GIT_TOKEN: "super-secret-token" },
        payload: runnerPayload(),
      })
    ).rejects.toThrow(REDACTED_RE);
    await expect(
      prepareRunnerWorkspace({
        createGitClient: () => ({
          clone,
          cwd: vi.fn(() => ({ checkoutBranch: vi.fn() })),
        }),
        env: { PIPELINE_GIT_TOKEN: "super-secret-token" },
        payload: runnerPayload(),
      })
    ).rejects.not.toThrow(SECRET_TOKEN_RE);
  });

  it("requires repository context", async () => {
    const { prepareRunnerWorkspace } = await import(
      "../src/runner-job/workspace.js"
    );

    await expect(
      prepareRunnerWorkspace({
        env: {},
        payload: { run: { id: "run_123", project: "project_123" } },
      })
    ).rejects.toThrow(REPOSITORY_REQUIRED_RE);
  });
});
