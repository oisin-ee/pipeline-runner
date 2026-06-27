import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const CREDENTIAL_OWNER_FILES = [
  "src/credentials/broker.ts",
  "src/credentials/codex-config.ts",
  "src/credentials/file-targets.ts",
  "src/credentials/local-codex-auth-sync.ts",
  "src/credentials/opencode-config.ts",
  "src/credentials/runner.ts",
];

const LEGACY_AUTH_OWNER_FILES = [
  "src/broker-auth.ts",
  "src/codex-auth-sync.ts",
  "src/run-state/opencode-accounts.ts",
];

const LEGACY_IMPORT_PATTERNS = [
  /from "\.\/broker-auth"/,
  /from "\.\.\/broker-auth"/,
  /from "\.\.\/codex-auth-sync"/,
  /from "\.\.\/run-state\/opencode-accounts"/,
  /from "\.\.\/\.\.\/run-state\/opencode-accounts"/,
];

describe("credential/auth ownership boundaries", () => {
  it("keeps broker, Codex, OpenCode, and credential file handling under src/credentials", () => {
    expect(
      CREDENTIAL_OWNER_FILES.filter((path) => !existsSync(join(ROOT, path)))
    ).toEqual([]);
    expect(
      LEGACY_AUTH_OWNER_FILES.filter((path) => existsSync(join(ROOT, path)))
    ).toEqual([]);
  });

  it("keeps production callers importing the credential owner directly", () => {
    const offenders = sourceFiles(join(ROOT, "src")).filter((path) => {
      const content = readFileSync(path, "utf8");
      return LEGACY_IMPORT_PATTERNS.some((pattern) => pattern.test(content));
    });

    expect(offenders.map((path) => relative(ROOT, path))).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"));
}
