import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { installHooks } from "../src/install-hooks";

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

function writeFixture(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function installMockHookRepo(
  target: string,
  options: { includeOpenCodeHook?: boolean } = {}
): void {
  writeFixture(
    target,
    "claude-code/hooks/check.sh",
    "#!/bin/sh\necho claude\n"
  );
  writeFixture(target, "codex/hooks/check.sh", "#!/bin/sh\necho codex\n");
  if (options.includeOpenCodeHook ?? true) {
    writeFixture(
      target,
      "opencode/plugins/agent-hooks.ts",
      "export const AgentHooks = async () => ({})\n"
    );
  }
  writeFixture(target, "README.md", "not installed\n");
}

describe("installHooks", () => {
  let home: string;
  let includeOpenCodeHook: boolean;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pipeline-hooks-home-"));
    includeOpenCodeHook = true;
    for (const key of [
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "OPENCODE_CONFIG_DIR",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    process.env.CODEX_HOME = join(home, ".codex");
    process.env.OPENCODE_CONFIG_DIR = join(home, ".config", "opencode");
    mockExeca.mockImplementation((command: string, args?: string[]) => {
      if (command === "gh" && Array.isArray(args)) {
        installMockHookRepo(args[3], { includeOpenCodeHook });
      }
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("copies host hook files into global per-machine host dirs", async () => {
    const result = await installHooks({});

    expect(mockExeca).toHaveBeenCalledWith(
      "gh",
      [
        "repo",
        "clone",
        "oisin-ee/agent-hooks",
        expect.any(String),
        "--",
        "--depth=1",
      ],
      expect.objectContaining({ stdio: "inherit" })
    );
    expect(result.items.map((item) => `${item.action}:${item.path}`)).toEqual([
      "create:.claude/hooks/check.sh",
      "create:.codex/hooks/check.sh",
      "create:.opencode/plugins/agent-hooks.ts",
    ]);
    expect(readFileSync(join(home, ".claude/hooks/check.sh"), "utf8")).toBe(
      "#!/bin/sh\necho claude\n"
    );
    expect(readFileSync(join(home, ".codex/hooks/check.sh"), "utf8")).toBe(
      "#!/bin/sh\necho codex\n"
    );
    expect(
      readFileSync(
        join(home, ".config/opencode/plugins/agent-hooks.ts"),
        "utf8"
      )
    ).toContain("AgentHooks");
    expect(existsSync(join(home, "README.md"))).toBe(false);
  });

  it("is idempotent and --check passes after install", async () => {
    await installHooks({});

    const second = await installHooks({});
    expect(second.items.every((item) => item.action === "unchanged")).toBe(
      true
    );

    const checked = await installHooks({ check: true });
    expect(checked.items.every((item) => item.action === "unchanged")).toBe(
      true
    );
  });

  it("protects manually edited hook files unless forced", async () => {
    await installHooks({});
    writeFileSync(join(home, ".claude/hooks/check.sh"), "manual edit\n");

    await expect(installHooks({})).rejects.toThrow("Refusing to overwrite");

    const forced = await installHooks({ force: true });
    expect(
      forced.items.find((item) => item.path === ".claude/hooks/check.sh")
        ?.action
    ).toBe("update");
    expect(readFileSync(join(home, ".claude/hooks/check.sh"), "utf8")).toBe(
      "#!/bin/sh\necho claude\n"
    );
  });

  it("fails --check when installed hook files drift", async () => {
    await installHooks({});
    writeFileSync(
      join(home, ".config/opencode/plugins/agent-hooks.ts"),
      "drift\n"
    );

    await expect(installHooks({ check: true })).rejects.toThrow(
      "not up to date"
    );
  });

  it("deletes previously installed hook files removed from the hook repository", async () => {
    await installHooks({});
    includeOpenCodeHook = false;

    const result = await installHooks({});

    expect(result.items).toContainEqual(
      expect.objectContaining({
        action: "delete",
        path: ".opencode/plugins/agent-hooks.ts",
      })
    );
    expect(
      existsSync(join(home, ".config/opencode/plugins/agent-hooks.ts"))
    ).toBe(false);
    expect(
      existsSync(join(home, ".config/opencode/.moka-agent-hooks.json"))
    ).toBe(false);
  });
});
