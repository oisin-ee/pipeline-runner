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

describe("prepareOpencodeCredentials", () => {
  it("copies every staged credential file to a writable live path", () => {
    const fixture = tempDir();
    const accountsStaged = join(fixture, "staged-accounts", "accounts.json");
    const authStaged = join(fixture, "staged-auth", "auth.json");
    const accountsDest = join(fixture, "home", ".opencode", "accounts.json");
    const authDest = join(
      fixture,
      "home",
      ".local",
      "share",
      "opencode",
      "auth.json"
    );
    stage(accountsStaged, '{"version":1,"accounts":[]}\n');
    stage(authStaged, '{"openai":{"type":"oauth"}}\n');

    const result = prepareOpencodeCredentials({
      files: [
        { destPath: accountsDest, stagedPath: accountsStaged },
        { destPath: authDest, stagedPath: authStaged },
      ],
    });

    expect(result.copied.sort()).toEqual(["accounts.json", "auth.json"]);
    expect(readFileSync(accountsDest, "utf8")).toContain('"accounts"');
    expect(readFileSync(authDest, "utf8")).toContain('"openai"');
    // Both writable so the plugin's atomic rewrite + token backfill succeed,
    // even though the staged sources were read-only.
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
