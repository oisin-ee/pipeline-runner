import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { AGENT_ASSET_SOURCE, AGENT_RULES_DIR } from "./agent-assets";
import { resolveHarnessTarget } from "./install-commands/shared";

const DEFAULT_RULES_INSTALL_SOURCE = AGENT_ASSET_SOURCE;
const RULESYNC_PACKAGE = "rulesync@8.30.1";

const RULESYNC_TARGETS = [
  "claudecode",
  "codexcli",
  "geminicli",
  "opencode",
] as const;

const RULE_OUTPUTS = [
  {
    generatedPath: ".claude/CLAUDE.md",
    targetPath: ".claude/CLAUDE.md",
  },
  {
    generatedPath: ".codex/AGENTS.md",
    targetPath: ".codex/AGENTS.md",
  },
  {
    generatedPath: ".gemini/GEMINI.md",
    targetPath: ".gemini/GEMINI.md",
  },
  {
    generatedPath: ".config/opencode/AGENTS.md",
    targetPath: ".opencode/AGENTS.md",
  },
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

interface GeneratedRuleFile {
  content: string;
  path: string;
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

async function withRulesyncHome<T>(
  useHome: (home: string) => Promise<T>
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "moka-rules-home-"));
  try {
    return await useHome(home);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}

function rulesyncArgs(options: { dryRun?: boolean; silent?: boolean }) {
  const args = [
    "generate",
    "-t",
    RULESYNC_TARGETS.join(","),
    "-f",
    "rules",
    "--delete",
    "--global",
  ];
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if (options.silent) {
    args.push("--silent");
  }
  return args;
}

async function runRulesyncGenerate(input: {
  dryRun?: boolean;
  home: string;
  runner: RulesyncRunner;
  silent?: boolean;
  source: string;
}): Promise<void> {
  await input.runner(rulesyncArgs(input), {
    cwd: input.source,
    env: { ...process.env, HOME_DIR: input.home },
  });
}

function ruleItems(action: InstallRulesItem["action"]): InstallRulesItem[] {
  return RULE_OUTPUTS.map((output) => ({
    action,
    path: resolveHarnessTarget(output.targetPath),
  }));
}

function readGeneratedRuleFiles(home: string): Promise<GeneratedRuleFile[]> {
  return Promise.all(
    RULE_OUTPUTS.map(async (output) => ({
      content: await readFile(join(home, output.generatedPath), "utf8"),
      path: resolveHarnessTarget(output.targetPath),
    }))
  );
}

async function writeGeneratedRuleFiles(
  files: GeneratedRuleFile[]
): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
}

async function installedRuleAction(
  file: GeneratedRuleFile
): Promise<"create" | "unchanged" | "update"> {
  try {
    const current = await readFile(file.path, "utf8");
    return current === file.content ? "unchanged" : "update";
  } catch {
    return "create";
  }
}

async function assertInstalledRulesCurrent(
  files: GeneratedRuleFile[]
): Promise<void> {
  const actions = await Promise.all(
    files.map(async (file) => ({
      action: await installedRuleAction(file),
      path: file.path,
    }))
  );
  const changed = actions.filter((item) => item.action !== "unchanged");
  if (changed.length === 0) {
    return;
  }
  throw new Error(
    [
      "Installed rule files are not up to date.",
      ...changed.map((item) => `- ${item.path}: ${item.action}`),
    ].join("\n")
  );
}

export function installRules(
  options: InstallRulesOptions = {}
): Promise<InstallRulesResult> {
  const runner = options.rulesyncRunner ?? defaultRulesyncRunner;

  return withRulesSource(options.sourceOverride, async (source) => {
    await buildRootRule(source);

    return withRulesyncHome(async (home) => {
      if (options.dryRun) {
        await runRulesyncGenerate({
          dryRun: true,
          home,
          runner,
          source,
        });
        return {
          items: ruleItems("skip"),
          source: DEFAULT_RULES_INSTALL_SOURCE,
        };
      }

      await runRulesyncGenerate({
        home,
        runner,
        silent: options.check,
        source,
      });
      const files = await readGeneratedRuleFiles(home);
      if (options.check) {
        await assertInstalledRulesCurrent(files);
        return {
          items: ruleItems("skip"),
          source: DEFAULT_RULES_INSTALL_SOURCE,
        };
      }
      await writeGeneratedRuleFiles(files);
      return {
        items: ruleItems("generate"),
        source: DEFAULT_RULES_INSTALL_SOURCE,
      };
    });
  });
}

export function formatInstallRulesResult(result: InstallRulesResult): string {
  return result.items.map((item) => `${item.action} ${item.path}`).join("\n");
}
