import { describe, expect, it, vi } from "vitest";
import type { RunnerJobPayload } from "../src/runner-job-contract.js";

function cleanDevspacePayload(): Pick<
  RunnerJobPayload,
  "repository" | "task" | "workspace"
> {
  return {
    repository: {
      branch: "main",
      cloneUrl: "https://github.com/oisin-ee/tova.git",
      fullName: "oisin-ee/tova",
      owner: "oisin-ee",
      repo: "tova",
      sha: "0123456789abcdef0123456789abcdef01234567",
    },
    task: {
      prompt: "Ship it",
      taskId: "PIPE-49",
    },
    workspace: {
      mode: "clean-devspace",
    },
  };
}

describe("runner-job PR delivery", () => {
  it("creates PRs with oisin-bot as the default head owner", async () => {
    const { createPullRequest } = await import("../src/runner-job/delivery.js");
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "runner/pipe-49\n" })
      .mockResolvedValueOnce({
        stdout: "https://github.com/oisin-ee/tova/pull/123\n",
      });

    await expect(
      createPullRequest({
        env: { GH_TOKEN: "redacted" },
        payload: cleanDevspacePayload(),
        runCommand,
        worktreePath: "/workspace",
      })
    ).resolves.toEqual({
      url: "https://github.com/oisin-ee/tova/pull/123",
    });

    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "gh",
      [
        "pr",
        "create",
        "--fill",
        "--base",
        "main",
        "--head",
        "oisin-bot:runner/pipe-49",
        "--repo",
        "oisin-ee/tova",
      ],
      {
        cwd: "/workspace",
        env: { GH_TOKEN: "redacted" },
        stdin: "ignore",
      }
    );
  });

  it("allows the PR head owner to be overridden by runner env", async () => {
    const { createPullRequest } = await import("../src/runner-job/delivery.js");
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "runner/pipe-49\n" })
      .mockResolvedValueOnce({
        stdout: "https://github.com/oisin-ee/tova/pull/124\n",
      });

    await createPullRequest({
      env: { PIPELINE_PR_HEAD_OWNER: "custom-bot" },
      payload: cleanDevspacePayload(),
      runCommand,
      worktreePath: "/workspace",
    });

    expect(runCommand.mock.calls[1]?.[1]).toContain(
      "custom-bot:runner/pipe-49"
    );
  });
});
