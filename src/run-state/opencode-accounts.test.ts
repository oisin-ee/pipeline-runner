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
import { prepareOpencodeAccounts } from "./opencode-accounts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
  tempDirs.push(dir);
  return dir;
}

describe("prepareOpencodeAccounts", () => {
  it("copies the staged secret to a writable plugin path the plugin can rewrite", () => {
    const fixture = tempDir();
    const stagedPath = join(fixture, "staged", "accounts.json");
    const destPath = join(fixture, "home", ".opencode", "accounts.json");
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, '{"version":1,"accounts":[]}\n');
    // The real secret mount is read-only; the copy must land somewhere writable.
    chmodSync(stagedPath, 0o400);

    const result = prepareOpencodeAccounts({ destPath, stagedPath });

    expect(result.copied).toBe(true);
    expect(readFileSync(destPath, "utf8")).toContain('"accounts"');
    // Writable for the owner so the plugin's atomic rewrite (temp + rename) works,
    // even though the staged source was read-only.
    expect(() => accessSync(destPath, constants.W_OK)).not.toThrow();
  });

  it("is a no-op when no staged secret is mounted (local dev, tests)", () => {
    const fixture = tempDir();
    const result = prepareOpencodeAccounts({
      destPath: join(fixture, ".opencode", "accounts.json"),
      stagedPath: join(fixture, "absent", "accounts.json"),
    });

    expect(result.copied).toBe(false);
  });
});
