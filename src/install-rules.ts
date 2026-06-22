import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { AGENT_ASSET_SOURCE, AGENT_RULES_DIR } from "./agent-assets";

const DEFAULT_RULES_INSTALL_SOURCE = AGENT_ASSET_SOURCE;
const RULESYNC_PACKAGE = "rulesync@8.30.1";

const RULESYNC_TARGETS = [
  "claudecode",
  "codexcli",
  "geminicli",
  "opencode",
] as const;

export type RulesyncRunner = (
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<void>;

export interface InstallRulesOptions {
  check?: boolean;
  dryRun?: boolean;
  force?: boolean;
  rulesyncRunner?: RulesyncRunner;
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
  const parent = await mkdtemp(join(tmpdir(), "moka-agent-rules-"));
  const source = join(parent, "agent");
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
    await execa("npx", ["--yes", RULESYNC_PACKAGE, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "inherit",
    });
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Failed to generate global rules from ${DEFAULT_RULES_INSTALL_SOURCE}${cause}. ` +
        "If this is a private repository, authenticate GitHub access with `gh auth login` and rerun `moka init`."
    );
  }
}

async function buildRootRule(source: string): Promise<void> {
  const rulesDir = join(source, AGENT_RULES_DIR);
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
