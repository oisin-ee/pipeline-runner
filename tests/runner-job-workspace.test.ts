import { describe, expect, it, vi } from "vitest";

const WORKSPACE_PATH = "/workspace";
const REDACTED_RE = /<redacted>/;
const REPOSITORY_REQUIRED_RE = /repository is required/;
const SECRET_TOKEN_RE = /super-secret-token/;

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

    const prepared = await prepareRunnerWorkspace({
      createGitClient: () => ({ clone, cwd }),
      env: {},
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
    expect(prepared).toEqual({
      env: { PIPELINE_TARGET_PATH: WORKSPACE_PATH },
      worktreePath: WORKSPACE_PATH,
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
