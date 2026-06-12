import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");

const scheduleModuleBoundaries = [
  {
    exports: [
      "ScheduleArtifactError",
      "compileScheduleArtifact",
      "parseScheduleArtifact",
      "scheduleArtifactPath",
    ],
    importPath: "../src/schedule/artifact.ts",
    sourcePath: "src/schedule/artifact.ts",
  },
  {
    exports: ["generateScheduleArtifact"],
    importPath: "../src/schedule/planner.ts",
    sourcePath: "src/schedule/planner.ts",
  },
  {
    exports: [],
    importPath: "../src/schedule/prompts.ts",
    sourcePath: "src/schedule/prompts.ts",
  },
] as const;

const generatedSchedulePassOrder = [
  {
    importPath: "../src/schedule/passes/coverage.ts",
    sourcePath: "src/schedule/passes/coverage.ts",
  },
  {
    importPath: "../src/schedule/passes/models.ts",
    sourcePath: "src/schedule/passes/models.ts",
  },
  {
    importPath: "../src/schedule/passes/ids.ts",
    sourcePath: "src/schedule/passes/ids.ts",
  },
  {
    importPath: "../src/schedule/passes/references.ts",
    sourcePath: "src/schedule/passes/references.ts",
  },
] as const;

const expectedSchedulePassOrder = [
  "coverage",
  "models",
  "ids",
  "references",
] as const;

function importFromTestFile(
  importPath: string
): Promise<Record<string, unknown>> {
  return import(importPath) as Promise<Record<string, unknown>>;
}

describe("schedule planner module boundaries", () => {
  it("keeps src/schedule-planner as the stable public barrel", async () => {
    const publicBarrel = await importFromTestFile("../src/schedule-planner.ts");

    expect(publicBarrel).toEqual(
      expect.objectContaining({
        ScheduleArtifactError: expect.any(Function),
        compileScheduleArtifact: expect.any(Function),
        generateScheduleArtifact: expect.any(Function),
        parseScheduleArtifact: expect.any(Function),
        scheduleArtifactPath: expect.any(Function),
      })
    );
  });

  it("splits artifact, planner, and prompt concerns into importable schedule modules", async () => {
    const missingModules = scheduleModuleBoundaries
      .map(({ sourcePath }) => sourcePath)
      .filter((sourcePath) => !existsSync(join(repoRoot, sourcePath)));

    expect(missingModules).toEqual([]);

    for (const boundary of scheduleModuleBoundaries) {
      const module = await importFromTestFile(boundary.importPath);

      for (const exportName of boundary.exports) {
        expect(
          module,
          `${boundary.sourcePath} should export ${exportName}`
        ).toHaveProperty(exportName);
      }
    }
  });

  it("documents generated schedule pass order as coverage, models, ids, then references", async () => {
    const missingPassModules = generatedSchedulePassOrder
      .map(({ sourcePath }) => sourcePath)
      .filter((sourcePath) => !existsSync(join(repoRoot, sourcePath)));

    expect(missingPassModules).toEqual([]);

    expect(
      generatedSchedulePassOrder.map(({ sourcePath }) => sourcePath)
    ).toEqual([
      "src/schedule/passes/coverage.ts",
      "src/schedule/passes/models.ts",
      "src/schedule/passes/ids.ts",
      "src/schedule/passes/references.ts",
    ]);

    for (const boundary of generatedSchedulePassOrder) {
      await expect(
        importFromTestFile(boundary.importPath)
      ).resolves.toBeDefined();
    }

    await expect(
      importFromTestFile("../src/schedule/passes/index.ts")
    ).resolves.toHaveProperty("SCHEDULE_PASS_ORDER", expectedSchedulePassOrder);
  });
});
