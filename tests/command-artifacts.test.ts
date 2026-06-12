import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");

describe("checked-in command artifacts", () => {
  it("does not commit installed plugin command output", () => {
    const commandsDir = join(
      repoRoot,
      ".agents/plugins/oisin-pipeline/commands"
    );
    const commandFiles = existsSync(commandsDir)
      ? readdirSync(commandsDir).filter((entry) => entry.endsWith(".md"))
      : [];

    expect(commandFiles).toEqual([]);
  });
});
