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
  options: { includeOpenCodeHook?: boolean; claudeSettings?: string } = {}
): void {
  writeFixture(
    target,
    "hooks/claude-code/hooks/check.sh",
    "#!/bin/sh\necho claude\n"
  );
  writeFixture(target, "hooks/codex/hooks/check.sh", "#!/bin/sh\necho codex\n");
  if (options.includeOpenCodeHook ?? true) {
    writeFixture(
      target,
      "hooks/opencode/opencode.json",
      '{"plugin":["@prevalentware/opencode-goal-plugin"]}\n'
    );
    writeFixture(
      target,
      "hooks/opencode/plugin/agent-hooks.ts",
      "export const AgentHooks = async () => ({})\n"
    );
  }
  if (options.claudeSettings !== undefined) {
    writeFixture(
      target,
      "hooks/claude-code/settings.json",
      options.claudeSettings
    );
  }
  writeFixture(target, "README.md", "not installed\n");
}

describe("installHooks", () => {
  let home: string;
  let includeOpenCodeHook: boolean;
  let claudeSettings: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pipeline-hooks-home-"));
    includeOpenCodeHook = true;
    claudeSettings = undefined;
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
        installMockHookRepo(args[3], { claudeSettings, includeOpenCodeHook });
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
        "oisin-ee/agent",
        expect.any(String),
        "--",
        "--depth=1",
      ],
      expect.objectContaining({ stdio: "inherit" })
    );
    expect(result.items.map((item) => `${item.action}:${item.path}`)).toEqual([
      "create:.claude/hooks/check.sh",
      "create:.codex/hooks/check.sh",
      "create:.opencode/plugin/agent-hooks.ts",
    ]);
    expect(readFileSync(join(home, ".claude/hooks/check.sh"), "utf8")).toBe(
      "#!/bin/sh\necho claude\n"
    );
    expect(readFileSync(join(home, ".codex/hooks/check.sh"), "utf8")).toBe(
      "#!/bin/sh\necho codex\n"
    );
    expect(
      readFileSync(join(home, ".config/opencode/plugin/agent-hooks.ts"), "utf8")
    ).toContain("AgentHooks");
    expect(existsSync(join(home, ".config/opencode/opencode.json"))).toBe(
      false
    );
    expect(existsSync(join(home, "README.md"))).toBe(false);
  });

  it("does not delete OpenCode config from old hook manifests", async () => {
    const opencodeConfigPath = join(home, ".config/opencode/opencode.json");
    const oldManifestPath = join(
      home,
      ".config/opencode/.moka-agent-hooks.json"
    );
    const commandOwnedConfig = '{"plugin":["@pipeline/owned"]}\n';
    mkdirSync(dirname(opencodeConfigPath), { recursive: true });
    writeFileSync(opencodeConfigPath, commandOwnedConfig);
    writeFileSync(
      oldManifestPath,
      `${JSON.stringify(
        {
          files: {
            ".opencode/opencode.json": { hash: "old-hook-hash" },
          },
          repository: "oisin-ee/agent",
          version: 1,
        },
        null,
        2
      )}\n`
    );

    const result = await installHooks({ force: true });

    expect(readFileSync(opencodeConfigPath, "utf8")).toBe(commandOwnedConfig);
    expect(result.items.map((item) => item.path)).not.toContain(
      ".opencode/opencode.json"
    );
    const manifest = JSON.parse(readFileSync(oldManifestPath, "utf8"));
    expect(manifest.files[".opencode/opencode.json"]).toBeUndefined();
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
      join(home, ".config/opencode/plugin/agent-hooks.ts"),
      "drift\n"
    );

    await expect(installHooks({ check: true })).rejects.toThrow(
      "not up to date"
    );
  });

  it("merges hooks into an existing settings.json without clobbering other keys", async () => {
    claudeSettings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: "sh new.sh", type: "command" }] }] },
    });
    const settingsPath = join(home, ".claude/settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ command: "sh OLD.sh", type: "command" }] }],
          },
          mcpServers: { neon: { command: "neon" } },
          permissions: { allow: ["Bash"] },
          theme: "dark",
        },
        null,
        2
      )}\n`
    );

    await installHooks({ force: true });

    const merged = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(merged.mcpServers).toEqual({ neon: { command: "neon" } });
    expect(merged.permissions).toEqual({ allow: ["Bash"] });
    expect(merged.theme).toBe("dark");
    expect(merged.hooks).toEqual({
      Stop: [{ hooks: [{ command: "sh new.sh", type: "command" }] }],
    });

    const second = await installHooks({});
    expect(
      second.items.find((item) => item.path === ".claude/settings.json")?.action
    ).toBe("unchanged");
    await expect(installHooks({ check: true })).resolves.toBeDefined();
  });

  it("deletes previously installed hook files removed from the hook repository", async () => {
    await installHooks({});
    includeOpenCodeHook = false;

    const result = await installHooks({});

    expect(result.items).toContainEqual(
      expect.objectContaining({
        action: "delete",
        path: ".opencode/plugin/agent-hooks.ts",
      })
    );
    expect(
      existsSync(join(home, ".config/opencode/plugin/agent-hooks.ts"))
    ).toBe(false);
    expect(
      existsSync(join(home, ".config/opencode/.moka-agent-hooks.json"))
    ).toBe(false);
  });
});
