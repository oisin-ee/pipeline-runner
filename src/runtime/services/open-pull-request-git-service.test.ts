import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { runAuthenticatedGit } from "../../run-state/git-refs";
import {
  OpenPullRequestGitService,
  OpenPullRequestGitServiceLive,
} from "./open-pull-request-git-service";

vi.mock("../../run-state/git-refs", () => ({
  runAuthenticatedGit: vi.fn(() => "ok"),
}));

const mockedRunAuthenticatedGit = vi.mocked(runAuthenticatedGit);

describe("OpenPullRequestGitServiceLive", () => {
  it("routes every git op through the authenticated runner (no naked git)", async () => {
    mockedRunAuthenticatedGit.mockClear();

    const program = Effect.gen(function* program() {
      const service = yield* OpenPullRequestGitService;
      const git = yield* service.create("/workspace");
      return yield* git.raw([
        "push",
        "--force-with-lease",
        "origin",
        "HEAD:refs/heads/moka/run/x",
      ]);
    });

    const output = await Effect.runPromise(
      Effect.provide(program, OpenPullRequestGitServiceLive)
    );

    expect(output).toBe("ok");
    expect(mockedRunAuthenticatedGit).toHaveBeenCalledWith("/workspace", [
      "push",
      "--force-with-lease",
      "origin",
      "HEAD:refs/heads/moka/run/x",
    ]);
  });
});
