import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { RunnerJobPayload } from "../src/runner-job-contract.js";

const PR_BODY_FILE_RE = /body\.md$/;

function cleanGitClient(overrides: Record<string, unknown> = {}) {
  return {
    add: vi.fn(async () => undefined),
    addConfig: vi.fn(async () => undefined),
    branch: vi.fn(async () => ({ current: "pipeline/run-123" })),
    branchLocal: vi.fn(async () => ({ branches: { "pipeline/run-123": {} } })),
    commit: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    revparse: vi.fn(async () => "abc123\n"),
    status: vi.fn(async () => ({ files: [] })),
    ...overrides,
  };
}

function cleanDevspacePayload(): Pick<
  RunnerJobPayload,
  "delivery" | "repository" | "run" | "task"
> {
  return {
    delivery: {
      pullRequest: false,
    },
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
      kind: "prompt",
      prompt: "Ship it",
    },
  };
}

function pullRequestSummary() {
  return {
    body: [
      "## Summary",
      "Pipeline run run_123 completed with outcome PASS.",
      "",
      "## Changes",
      "- Add explicit PR summary",
      "  - Why: Runner PRs need durable metadata",
      "  - Files: src/runner-job/delivery.ts",
    ].join("\n"),
    title: "Pipeline: Ship it",
  };
}

describe("runner-job git delivery", () => {
  it("commits all dirty work and pushes the branch without requiring a PR", async () => {
    const { deliverGitBranch } = await import("../src/runner-job/delivery.js");
    const git = cleanGitClient({
      branch: vi.fn(async () => ({ current: "pipeline/run-123" })),
      branchLocal: vi.fn(async () => ({
        branches: {
          "other/local": {},
          "pipeline/run-123": {},
          "run_123/child": {},
          "runs/integration/run_123": {},
        },
      })),
      status: vi
        .fn()
        .mockResolvedValueOnce({ files: [{ path: "src/app.ts" }] })
        .mockResolvedValueOnce({ files: [] }),
    });

    await expect(
      deliverGitBranch({
        committer: {
          email: "git@oisin.ee",
          name: "oisin-bot",
        },
        createGitClient: () => git,
        env: { GH_TOKEN: "redacted" },
        payload: cleanDevspacePayload(),
        worktreePath: "/workspace",
      })
    ).resolves.toEqual({
      branch: "pipeline/run-123",
      commitSha: "abc123",
      pushed: true,
    });

    expect(git.add).toHaveBeenCalledWith(["--all"]);
    expect(git.addConfig).toHaveBeenCalledWith(
      "user.name",
      "oisin-bot",
      false,
      "local"
    );
    expect(git.addConfig).toHaveBeenCalledWith(
      "user.email",
      "git@oisin.ee",
      false,
      "local"
    );
    expect(git.commit).toHaveBeenCalledWith("pipeline: run_123");
    expect(git.push.mock.calls).toEqual([
      ["origin", "pipeline/run-123", ["--set-upstream", "--force-with-lease"]],
      ["origin", "run_123/child", ["--set-upstream", "--force-with-lease"]],
      [
        "origin",
        "runs/integration/run_123",
        ["--set-upstream", "--force-with-lease"],
      ],
    ]);
  });
});

describe("runner-job PR delivery", () => {
  it("creates PRs with the repository owner as the default head owner", async () => {
    const { createPullRequest } = await import("../src/runner-job/delivery.js");
    let body = "";
    const runCommand = vi.fn((_command, args: string[]) => {
      const bodyFile = args.at(args.indexOf("--body-file") + 1);
      body = bodyFile ? readFileSync(bodyFile, "utf8") : "";
      return Promise.resolve({
        stdout: "https://github.com/oisin-ee/tova/pull/123\n",
      });
    });

    await expect(
      createPullRequest({
        createGitClient: () => ({
          ...cleanGitClient(),
          branch: vi.fn(async () => ({ current: "runner/pipe-49" })),
        }),
        env: { GH_TOKEN: "redacted" },
        payload: { ...cleanDevspacePayload(), delivery: { pullRequest: true } },
        pullRequestSummary: pullRequestSummary(),
        runCommand,
        worktreePath: "/workspace",
      })
    ).resolves.toEqual({
      url: "https://github.com/oisin-ee/tova/pull/123",
    });

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "gh",
      [
        "pr",
        "create",
        "--title",
        "Pipeline: Ship it",
        "--body-file",
        expect.stringMatching(PR_BODY_FILE_RE),
        "--base",
        "main",
        "--head",
        "oisin-ee:runner/pipe-49",
        "--repo",
        "oisin-ee/tova",
      ],
      {
        cwd: "/workspace",
        env: { GH_TOKEN: "redacted" },
        stdin: "ignore",
      }
    );
    expect(runCommand.mock.calls[0]?.[1]).not.toContain("--fill");
    expect(body).toContain("## Changes");
    expect(body).toContain("Why: Runner PRs need durable metadata");
  });

  it("allows the PR head owner to be overridden by runner env", async () => {
    const { createPullRequest } = await import("../src/runner-job/delivery.js");
    const runCommand = vi.fn().mockResolvedValueOnce({
      stdout: "https://github.com/oisin-ee/tova/pull/124\n",
    });

    await createPullRequest({
      createGitClient: () => ({
        ...cleanGitClient(),
        branch: vi.fn(async () => ({ current: "runner/pipe-49" })),
      }),
      env: { PIPELINE_PR_HEAD_OWNER: "custom-bot" },
      payload: { ...cleanDevspacePayload(), delivery: { pullRequest: true } },
      pullRequestSummary: pullRequestSummary(),
      runCommand,
      worktreePath: "/workspace",
    });

    expect(runCommand.mock.calls[0]?.[1]).toContain(
      "custom-bot:runner/pipe-49"
    );
  });

  it("returns the existing PR URL when the delivery branch already has a PR", async () => {
    const { createPullRequest } = await import("../src/runner-job/delivery.js");
    const createError = new Error(
      "a pull request for branch oisin-bot:runner/pipe-49 already exists"
    );
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(createError)
      .mockResolvedValueOnce({
        stdout: "https://github.com/oisin-ee/tova/pull/125\n",
      });

    await expect(
      createPullRequest({
        createGitClient: () => ({
          ...cleanGitClient(),
          branch: vi.fn(async () => ({ current: "runner/pipe-49" })),
        }),
        env: { GH_TOKEN: "redacted" },
        payload: { ...cleanDevspacePayload(), delivery: { pullRequest: true } },
        pullRequestSummary: pullRequestSummary(),
        runCommand,
        worktreePath: "/workspace",
      })
    ).resolves.toEqual({
      url: "https://github.com/oisin-ee/tova/pull/125",
    });

    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--head",
        "oisin-ee:runner/pipe-49",
        "--repo",
        "oisin-ee/tova",
        "--json",
        "url",
        "--jq",
        ".[0].url",
      ],
      {
        cwd: "/workspace",
        env: { GH_TOKEN: "redacted" },
        stdin: "ignore",
      }
    );
  });
});
