import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import {
  DEFAULT_HARNESS_SCOPE,
  type HarnessScope,
} from "./install-commands/shared";

const DEFAULT_RULES_INSTALL_SOURCE = "oisin-ee/rules";

const RULESYNC_TARGETS = [
  "claudecode",
  "codexcli",
  "geminicli",
  "opencode",
] as const;

function packageRoot(): string {
  // This module lives at src/install-rules.ts (compiled to dist/install-rules.js).
  // Walk up one directory from the compiled output to reach the package root.
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "..");
}

const PACKAGE_ROOT = packageRoot();

export type RulesyncRunner = (
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<void>;

export interface InstallRulesOptions {
  check?: boolean;
  cwd?: string;
  dryRun?: boolean;
  force?: boolean;
  rulesyncRunner?: RulesyncRunner;
  scope?: HarnessScope;
  sourceOverride?: string;
}

export interface InstallRulesItem {
  action: "generate" | "skip";
  path: string;
}

export interface InstallRulesResult {
  items: InstallRulesItem[];
  source: string;
}

async function cloneRulesRepository(targetDir: string): Promise<void> {
  await execa(
    "gh",
    [
      "repo",
      "clone",
      DEFAULT_RULES_INSTALL_SOURCE,
      targetDir,
      "--",
      "--depth=1",
    ],
    { stdio: "inherit" }
  );
}

async function withRulesSource<T>(
  sourceOverride: string | undefined,
  useSource: (source: string) => Promise<T>
): Promise<T> {
  if (sourceOverride !== undefined) {
    return useSource(sourceOverride);
  }
  const parent = await mkdtemp(join(tmpdir(), "moka-rules-"));
  const source = join(parent, "rules");
  try {
    await cloneRulesRepository(source);
    return await useSource(source);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}

async function defaultRulesyncRunner(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<void> {
  try {
    await execa("rulesync", args, {
      cwd: opts.cwd,
      env: opts.env,
      localDir: PACKAGE_ROOT,
      preferLocal: true,
      stdio: "inherit",
    });
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Failed to generate global rules from ${DEFAULT_RULES_INSTALL_SOURCE}${cause}. ` +
        "If this is a private repository, authenticate GitHub access with `gh auth login` and rerun `moka refresh-harnesses --scope global`."
    );
  }
}

async function buildRootRule(source: string): Promise<void> {
  const rulesDir = join(source, "rules");
  let entries: string[] = [];
  try {
    const dirents = await readdir(rulesDir, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // rules/ directory may not exist yet — produce empty body
  }

  const bodies = await Promise.all(
    entries.map(async (name) => {
      const content = await readFile(join(rulesDir, name), "utf8");
      return content.trimEnd();
    })
  );

  const mergedBody = bodies.join("\n\n");
  const frontmatter = '---\nroot: true\ntargets:\n  - "*"\n---\n\n';
  const rootContent = `${frontmatter}${mergedBody}\n`;

  const rulesyncRulesDir = join(source, ".rulesync", "rules");
  await mkdir(rulesyncRulesDir, { recursive: true });
  await writeFile(join(rulesyncRulesDir, "_root.md"), rootContent);
}

export function installRules(
  options: InstallRulesOptions = {}
): Promise<InstallRulesResult> {
  const scope = options.scope ?? DEFAULT_HARNESS_SCOPE;

  if (scope !== "global") {
    return Promise.resolve({ items: [], source: DEFAULT_RULES_INSTALL_SOURCE });
  }

  const runner = options.rulesyncRunner ?? defaultRulesyncRunner;

  return withRulesSource(options.sourceOverride, async (source) => {
    await buildRootRule(source);

    const home = process.env.HOME_DIR ?? homedir();

    const args = [
      "generate",
      "-t",
      RULESYNC_TARGETS.join(","),
      "-f",
      "rules",
      "--delete",
    ];
    if (options.dryRun) {
      args.push("--dry-run");
    }
    if (options.check) {
      args.push("--check");
    }

    await runner(args, {
      cwd: source,
      env: { ...process.env, HOME_DIR: home },
    });

    const action = (options.dryRun ?? options.check) ? "skip" : "generate";
    const items: InstallRulesItem[] = [
      { action, path: join(home, ".claude/CLAUDE.md") },
      { action, path: join(home, ".codex/AGENTS.md") },
      { action, path: join(home, ".gemini/GEMINI.md") },
      { action, path: join(home, ".config/opencode/AGENTS.md") },
    ];

    return { items, source: DEFAULT_RULES_INSTALL_SOURCE };
  });
}

export function formatInstallRulesResult(result: InstallRulesResult): string {
  return result.items.map((item) => `${item.action} ${item.path}`).join("\n");
}
