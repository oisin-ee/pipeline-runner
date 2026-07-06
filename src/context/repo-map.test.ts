import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildRepoMapContext } from "./repo-map";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "moka-repomap-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
  writeFileSync(join(dir, "b.ts"), "import { alpha } from './a';\nexport function beta() {\n  return alpha();\n}\n");
  writeFileSync(join(dir, "c.ts"), "export function gamma() {\n  return 2;\n}\n");
  return dir;
};

const byChars = (text: string) => text.length;

describe("buildRepoMapContext", () => {
  it("fits the token budget and selects more symbols with a larger budget", async () => {
    const dir = fixture();
    const small = await buildRepoMapContext({
      artifacts: [],
      estimateTokens: byChars,
      taskText: "x",
      tokenBudget: 40,
      worktreePath: dir,
    });
    const large = await buildRepoMapContext({
      artifacts: [],
      estimateTokens: byChars,
      taskText: "x",
      tokenBudget: 10_000,
      worktreePath: dir,
    });

    expect(small.estimatedTokens).toBeLessThanOrEqual(40);
    expect(large.selected.length).toBeGreaterThan(0);
    expect(large.selected.length).toBeGreaterThanOrEqual(small.selected.length);
  });

  it("seeds the ranking by task text so the named symbol ranks first", async () => {
    const dir = fixture();
    const seeded = await buildRepoMapContext({
      artifacts: [],
      estimateTokens: byChars,
      taskText: "fix the gamma helper",
      tokenBudget: 10_000,
      worktreePath: dir,
    });

    expect(seeded.selected[0].name).toBe("gamma");
    expect(seeded.selected[0].matchedSeed).toBe(true);
  });

  it("is deterministic for a fixed input", async () => {
    const dir = fixture();
    const input = {
      artifacts: [],
      estimateTokens: byChars,
      taskText: "alpha",
      tokenBudget: 10_000,
      worktreePath: dir,
    };

    const first = await buildRepoMapContext({ ...input });
    const second = await buildRepoMapContext({ ...input });

    expect(first.context).toEqual(second.context);
    expect(first.selected).toEqual(second.selected);
  });
});
