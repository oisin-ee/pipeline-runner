import { describe, expect, it, vi } from "vitest";

const WORKSPACE_PATH = "/workspace";
const CLONE_CREDENTIAL_URL_RE =
  /^https:\/\/x-access-token:super-secret-token@github\.com\/oisin-ee\/tova\.git$/;
const MISSING_CLONE_CREDENTIAL_RE = /PIPELINE_GIT_TOKEN/;
const REDACTED_CREDENTIAL_RE = /<redacted>/;
const SECRET_TOKEN_RE = /super-secret-token/;

function cleanDevspacePayload(): any {
  return {
    repository: {
      branch: "main",
      cloneUrl: "https://github.com/oisin-ee/tova.git",
      fullName: "oisin-ee/tova",
      owner: "oisin-ee",
      repo: "tova",
      sha: "0123456789abcdef0123456789abcdef01234567",
    },
    run: {
      projectId: "project_123",
      requestedBy: "user_456",
      runId: "run_123",
    },
    task: {
      prompt: "Ship PIPE-49",
      taskId: "PIPE-49",
    },
    workspace: {
      mode: "clean-devspace",
    },
  };
}

describe("runner-job workspace bootstrap", () => {
  it("clones clean devspace payloads into /workspace and checks out an exact-SHA runner branch", async () => {
    const { prepareRunnerWorkspace } = await import(
      "../src/runner-job/workspace.js"
    );
    const checkoutBranch = vi.fn(() => Promise.resolve(undefined));
    const cwd = vi.fn(() => ({ checkoutBranch }));
    const clone = vi.fn(() => Promise.resolve(undefined));

    const prepared = await prepareRunnerWorkspace({
      createGitClient: () => ({ clone, cwd }),
      env: {},
      payload: cleanDevspacePayload(),
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

  it("uses cloneCredentialEnv without exposing the credential in clone errors", async () => {
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
        payload: {
          ...cleanDevspacePayload(),
          workspace: {
            cloneCredentialEnv: "PIPELINE_GIT_TOKEN",
            mode: "clean-devspace",
          },
        },
      })
    ).rejects.toThrow(REDACTED_CREDENTIAL_RE);
    await expect(
      prepareRunnerWorkspace({
        createGitClient: () => ({
          clone,
          cwd: vi.fn(() => ({ checkoutBranch: vi.fn() })),
        }),
        env: { PIPELINE_GIT_TOKEN: "super-secret-token" },
        payload: {
          ...cleanDevspacePayload(),
          workspace: {
            cloneCredentialEnv: "PIPELINE_GIT_TOKEN",
            mode: "clean-devspace",
          },
        },
      })
    ).rejects.not.toThrow(SECRET_TOKEN_RE);
    expect(clone).toHaveBeenCalledWith(
      expect.stringMatching(CLONE_CREDENTIAL_URL_RE),
      WORKSPACE_PATH,
      ["--no-tags"]
    );
  });

  it("fails before clone when the requested clone credential env is missing", async () => {
    const { prepareRunnerWorkspace } = await import(
      "../src/runner-job/workspace.js"
    );
    const clone = vi.fn(() => Promise.resolve(undefined));

    await expect(
      prepareRunnerWorkspace({
        createGitClient: () => ({
          clone,
          cwd: vi.fn(() => ({ checkoutBranch: vi.fn() })),
        }),
        env: {},
        payload: {
          ...cleanDevspacePayload(),
          workspace: {
            cloneCredentialEnv: "PIPELINE_GIT_TOKEN",
            mode: "clean-devspace",
          },
        },
      })
    ).rejects.toThrow(MISSING_CLONE_CREDENTIAL_RE);
    expect(clone).not.toHaveBeenCalled();
  });

  it("preserves the existing cwd for non-clean workspace payloads", async () => {
    const { prepareRunnerWorkspace } = await import(
      "../src/runner-job/workspace.js"
    );

    await expect(
      prepareRunnerWorkspace({
        cwd: "/existing/worktree",
        env: { PIPELINE_TARGET_PATH: "/target/path" },
        payload: {},
      })
    ).resolves.toEqual({
      env: { PIPELINE_TARGET_PATH: "/target/path" },
      worktreePath: "/target/path",
    });
  });
});
