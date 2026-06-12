import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const FIND_PLANNED_NODE_DECLARATION_RE = /function findPlannedNode\b/g;
const TOML_IMPORT_RE = /from ["'](?:\.\/|\.\.\/)toml["']/;
const UNIQUE_STRINGS_DECLARATION_RE = /function uniqueStrings\b/g;

function readProjectFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function sourceFilePaths(): string[] {
  return walkSourceFiles(join(ROOT, "src"));
}

function walkSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        return walkSourceFiles(fullPath);
      }
      const projectPath = fullPath.slice(ROOT.length + 1);
      return projectPath.endsWith(".ts") && !projectPath.endsWith(".test.ts")
        ? [projectPath]
        : [];
    })
    .sort();
}

describe("PIPE-58 cleanup contracts", () => {
  it("removes the legacy TOML helper from source and package surfaces", () => {
    expect(existsSync(join(ROOT, "src/toml.ts"))).toBe(false);

    for (const path of sourceFilePaths()) {
      expect(readProjectFile(path), path).not.toMatch(TOML_IMPORT_RE);
    }
  });

  it("keeps only one shared uniqueStrings implementation", () => {
    const declarations = sourceFilePaths().flatMap((path) => {
      const matches =
        readProjectFile(path).match(UNIQUE_STRINGS_DECLARATION_RE) ?? [];
      return matches.map(() => path);
    });

    expect(declarations).toEqual(["src/strings.ts"]);
  });

  it("keeps planned-node lookup centralized while preserving public exports", () => {
    const declarations = sourceFilePaths().flatMap((path) => {
      const matches =
        readProjectFile(path).match(FIND_PLANNED_NODE_DECLARATION_RE) ?? [];
      return matches.map(() => path);
    });
    const pkg = JSON.parse(readProjectFile("package.json")) as {
      exports: Record<string, unknown>;
    };

    expect(declarations).toEqual(["src/planned-node.ts"]);
    expect(Object.keys(pkg.exports).sort()).toEqual([
      ".",
      "./argo-submit",
      "./argo-workflow",
      "./config",
      "./hooks",
      "./moka-global-config",
      "./moka-submit",
      "./planner",
      "./runner",
      "./runner-command-contract",
      "./runtime",
      "./schedule",
    ]);
  });
});
