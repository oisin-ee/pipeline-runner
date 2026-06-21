import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpencodeCredentials } from "./opencode-accounts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-creds-"));
  tempDirs.push(dir);
  return dir;
}

function stage(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o400); // the real secret mount is read-only
}

const ACCOUNTS_DEST_NAME = "oc-codex-multi-auth-accounts.json";

describe("prepareOpencodeCredentials", () => {
  it("copies staged files writable and syncs the fresh openai token into auth.json", () => {
    const fixture = tempDir();
    const accountsStaged = join(fixture, "staged-accounts", "accounts.json");
    const authStaged = join(fixture, "staged-auth", "auth.json");
    const accountsDest = join(fixture, "home", ".opencode", ACCOUNTS_DEST_NAME);
    const authDest = join(
      fixture,
      "home",
      ".local",
      "share",
      "opencode",
      "auth.json"
    );
    // Pool has a FRESH token at the active index; auth.json has a STALE openai
    // token (the exact shape that caused the 401: plugin skips backfill of an
    // existing-but-expired entry).
    stage(
      accountsStaged,
      JSON.stringify({
        accounts: [
          {
            accessToken: "fresh-access",
            expiresAt: 9999,
            refreshToken: "fresh-refresh",
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { codex: 0 },
      })
    );
    stage(
      authStaged,
      JSON.stringify({
        anthropic: { type: "api", key: "keep-me" },
        openai: {
          access: "stale-access",
          expires: 1,
          refresh: "stale-refresh",
          type: "oauth",
        },
      })
    );

    const result = prepareOpencodeCredentials({
      files: [
        { destPath: accountsDest, stagedPath: accountsStaged },
        { destPath: authDest, stagedPath: authStaged },
      ],
    });

    expect(result.copied.sort()).toEqual(
      [ACCOUNTS_DEST_NAME, "auth.json"].sort()
    );
    expect(result.hostOpenaiTokenSynced).toBe(true);
    const auth = JSON.parse(readFileSync(authDest, "utf8"));
    // openai token replaced with the pool's fresh token...
    expect(auth.openai).toEqual({
      access: "fresh-access",
      expires: 9999,
      refresh: "fresh-refresh",
      type: "oauth",
    });
    // ...other providers preserved.
    expect(auth.anthropic).toEqual({ type: "api", key: "keep-me" });
    // Both writable so the plugin's atomic rewrite succeeds.
    expect(() => accessSync(accountsDest, constants.W_OK)).not.toThrow();
    expect(() => accessSync(authDest, constants.W_OK)).not.toThrow();
  });

  it("copies only the files whose staged source exists", () => {
    const fixture = tempDir();
    const authStaged = join(fixture, "staged-auth", "auth.json");
    const authDest = join(
      fixture,
      "home",
      ".local",
      "share",
      "opencode",
      "auth.json"
    );
    stage(authStaged, '{"openai":{"type":"oauth"}}\n');

    const result = prepareOpencodeCredentials({
      files: [
        {
          destPath: join(fixture, "home", ".opencode", "accounts.json"),
          stagedPath: join(fixture, "absent", "accounts.json"),
        },
        { destPath: authDest, stagedPath: authStaged },
      ],
    });

    expect(result.copied).toEqual(["auth.json"]);
  });

  it("is a no-op when no staged secret is mounted (local dev, tests)", () => {
    const fixture = tempDir();
    const result = prepareOpencodeCredentials({
      files: [
        {
          destPath: join(fixture, ".opencode", "accounts.json"),
          stagedPath: join(fixture, "absent", "accounts.json"),
        },
      ],
    });

    expect(result.copied).toEqual([]);
  });
});
