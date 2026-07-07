import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createGhRunner } from "./gh-runner";
import type { GhExec } from "./gh-runner";

// ---------------------------------------------------------------------------
// Recording exec stub — captures the args and env each call received so the
// tests can assert the secret travelled via the ENV channel, never argv.
// ---------------------------------------------------------------------------

interface ExecCall {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

const recordingExec = (
  stdout: string
): {
  exec: GhExec;
  calls: ExecCall[];
} => {
  const calls: ExecCall[] = [];
  const exec: GhExec = async (args, options) => {
    calls.push({ args: [...args], env: options.env });
    return await Promise.resolve({ stdout });
  };
  return { calls, exec };
};

const failingGhExec: GhExec = () => {
  throw new Error("gh: not mergeable");
};

// ---------------------------------------------------------------------------
// AC3 — text() routes secretEnv to the child ENV, never into argv.
// ---------------------------------------------------------------------------

describe("createGhRunner — secretEnv channel", () => {
  it("injects secretEnv into the child env and keeps it out of argv", async () => {
    const { exec, calls } = recordingExec("ok");
    const gh = createGhRunner({ exec });

    const args = ["pr", "merge", "1", "--admin", "--squash"];
    await Effect.runPromise(
      gh.text(args, { secretEnv: { GH_TOKEN: "s3cr3t-admin-token" } })
    );

    expect(calls).toHaveLength(1);
    const call = calls.at(0);
    if (call === undefined) {
      throw new Error("expected one gh call");
    }
    // ENV channel carries the token.
    expect(call.env).toEqual({ GH_TOKEN: "s3cr3t-admin-token" });
    // argv carries exactly the provided args and NEVER the secret value.
    expect(call.args).toEqual(args);
    expect(call.args.join(" ")).not.toContain("s3cr3t-admin-token");
  });

  it("omits env entirely when no secretEnv is provided", async () => {
    const { exec, calls } = recordingExec("ok");
    const gh = createGhRunner({ exec });

    await Effect.runPromise(
      gh.text(["pr", "merge", "2", "--auto", "--squash"])
    );

    expect(calls[0]?.env).toBeUndefined();
  });

  it("json() parses the gh stdout into a value", async () => {
    const { exec } = recordingExec('[{"number":7,"headRefName":"moka/run/x"}]');
    const gh = createGhRunner({ exec });

    const parsed = await Effect.runPromise(
      gh.json(["pr", "list", "--json", "number,headRefName"])
    );

    expect(parsed).toEqual([{ headRefName: "moka/run/x", number: 7 }]);
  });

  it("surfaces a gh failure as a typed Error (no silent swallow)", async () => {
    const gh = createGhRunner({ exec: failingGhExec });

    const exit = await Effect.runPromiseExit(gh.text(["pr", "merge", "3"]));
    expect(exit._tag).toBe("Failure");
  });
});
