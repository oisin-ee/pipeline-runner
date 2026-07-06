import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const RUNBOOK_DOCS = ["README.md", "docs/operator-guide.md", "docs/run-control.md"] as const;

interface Requirement {
  label: string;
  pattern: RegExp;
}

const CANONICAL_COMMANDS = [
  "moka run",
  "moka runs",
  "moka status",
  "moka logs",
  "moka stop",
  "moka export",
  "moka doctor",
  "moka init",
] as const;

const MOKA_TICKET_COMMANDS = [
  "moka ticket graph check --root PIPE-84",
  "moka ticket sequence --root PIPE-84 --plain",
  "moka ticket next --root PIPE-84 --json",
  "moka ticket next --claim --root PIPE-84",
  "moka ticket create --dry-run",
  "moka ticket create --apply --parent PIPE-84",
  "moka ticket start --root PIPE-84",
  "moka ticket start --dry-run --root PIPE-84",
] as const;

const MOKA_TICKET_RELATIONSHIP_PATTERN =
  /moka ticket selects and scopes Backlog work[\s\S]{0,220}moka run executes selected work/iu;

const MOKA_TICKET_READ_ONLY_BOUNDARY_PATTERN =
  /read-only[\s\S]{0,240}graph check[\s\S]{0,240}sequence[\s\S]{0,240}next[\s\S]{0,240}create --dry-run/iu;

const MOKA_TICKET_MUTATION_BOUNDARY_PATTERN =
  /mutate[\s\S]{0,240}next --claim[\s\S]{0,240}create --apply[\s\S]{0,240}ticket start[\s\S]{0,160}without `--dry-run`/iu;

const MOKA_TICKET_START_DRY_RUN_BOUNDARY_PATTERN = /ticket start --dry-run[\s\S]{0,160}read-only/iu;

const BACKLOG_CLI_MARKDOWN_BOUNDARY_PATTERN =
  /Backlog CLI[\s\S]{0,240}task creation and editing[\s\S]{0,240}direct markdown edits/iu;

const FLAG_DOCUMENTATION_REQUIREMENTS: Requirement[] = [
  {
    label: "--target local command example",
    pattern: /moka run[^\n]*--target local[^\n]*"[^"]+"/u,
  },
  {
    label: "--target remote command example",
    pattern: /moka run[^\n]*--target remote[^\n]*"[^"]+"/u,
  },
  {
    label: "--target choices explained as local and remote",
    pattern: /--target[\s\S]{0,260}`?local`?[\s\S]{0,260}`?remote`?/iu,
  },
  {
    label: "--effort quick command example",
    pattern: /moka run[^\n]*--effort quick[^\n]*"[^"]+"/u,
  },
  {
    label: "--effort normal command example",
    pattern: /moka run[^\n]*--effort normal[^\n]*"[^"]+"/u,
  },
  {
    label: "--effort thorough command example",
    pattern: /moka run[^\n]*--effort thorough[^\n]*"[^"]+"/u,
  },
  {
    label: "--effort choices explained as quick, normal, and thorough",
    pattern: /--effort[\s\S]{0,320}`?quick`?[\s\S]{0,320}`?normal`?[\s\S]{0,320}`?thorough`?/iu,
  },
  {
    label: "read-only mode command example",
    pattern: /moka run[^\n]*(?:--read-only|--mode (?:read|read-only))[^\n]*"[^"]+"/u,
  },
  {
    label: "write mode default explained",
    pattern: /(?:mode defaults? to|default(?:s)? .*mode is) `?write`?/iu,
  },
];

// Post-PIPE-91.18, run-control state (manifest, status, events, schedule) is
// owned by the durable Postgres store, NOT the filesystem. `.pipeline/runs/<id>/`
// holds only the on-disk observability artifacts the runtime reporter writes
// (runtime-events.jsonl, nodes/<id>/stdout.jsonl). The docs must describe that
// reality — not the removed file-store layout (manifest.json/status.json/etc.).
const RUN_DIRECTORY_REQUIREMENTS: Requirement[] = [
  {
    label: "run directory root",
    pattern: /\.pipeline\/runs\/<runId>\//u,
  },
  { label: "runtime events stream", pattern: /runtime-events\.jsonl/u },
  { label: "nodes directory", pattern: /nodes\//u },
  { label: "per-node stdout artifact", pattern: /stdout\.jsonl/u },
  {
    label: "run-control state owned by the durable Postgres store",
    pattern:
      /(?:durable|Postgres|db\.url)[\s\S]{0,200}(?:manifest|status|run-control state)|run-control state[\s\S]{0,160}(?:Postgres|durable|database|db\.url)/iu,
  },
  {
    label: "sanitized export command",
    pattern: /moka export[^\n]*--sanitize|moka export --sanitize[^\n]*/u,
  },
  {
    label: "sanitized export omits sensitive run artifacts",
    pattern: /(?:saniti[sz]ed|--sanitize)[\s\S]{0,360}(?:prompt|session|body|secret|token|credential)/iu,
  },
];

const SUBMIT_PRIMARY_COMMAND_PATTERN = /`moka submit "<task>"`\s+\n\s*(?:Generates|Submits|Creates|Uses)\b/iu;

const projectFile = (relativePath: string): URL => new URL(`../${relativePath}`, import.meta.url);

const readProjectFile = (relativePath: string): string => readFileSync(projectFile(relativePath), "utf-8");

const readOptionalProjectFile = (relativePath: string): string => {
  const file = projectFile(relativePath);
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
};

const markdownSection = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(heading);
  if (start === -1) {
    throw new Error(`Missing markdown section: ${heading}`);
  }
  const nextSection = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, nextSection === -1 ? undefined : nextSection);
};

const commandSurfaceSection = (): string => markdownSection(readProjectFile("README.md"), "## Command Surface");

const operatorGuideSection = (heading: string): string =>
  markdownSection(readProjectFile("docs/operator-guide.md"), heading);

const runbookDocs = (): string => RUNBOOK_DOCS.map(readOptionalProjectFile).join("\n\n");

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const escapedRegExp = (source: string): string => source.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const documentedCommandPattern = (command: string): RegExp => {
  const escapedCommand = escapedRegExp(command);
  return new RegExp(`(?:\`${escapedCommand}(?:\\s|\`)|^${escapedCommand}(?:\\s|$))`, "mu");
};

const missingRequirements = (text: string, requirements: readonly Requirement[]): string[] =>
  requirements.filter((requirement) => !requirement.pattern.test(text)).map((requirement) => requirement.label);

describe("README command surface", () => {
  it("makes moka run primary without duplicate submit/run examples", () => {
    const section = commandSurfaceSection();
    const primaryRunExample = 'moka run "Implement PIPE-123 user-facing behavior"';

    expect(section.indexOf('`moka run "<task>"`')).toBeGreaterThanOrEqual(0);
    expect(section.indexOf('`moka run "<task>"`')).toBeLessThan(section.indexOf("moka submit"));
    expect(countOccurrences(section, "Implement PIPE-123 user-facing behavior")).toBe(1);
    expect(section).toContain(primaryRunExample);
    expect(section).not.toContain('moka submit "Implement PIPE-123 user-facing behavior"');
  });

  it.each(["moka quick", "moka execute", "moka inspect", "moka submit"])(
    "documents %s as a compatibility alias or preset",
    (alias) => {
      const section = commandSurfaceSection();
      const aliasContext = new RegExp(
        [
          `(alias|preset|compatibility)[\\s\\S]{0,180}${escapedRegExp(alias)}`,
          `${escapedRegExp(alias)}[\\s\\S]{0,180}(alias|preset|compatibility)`,
        ].join("|"),
        "iu",
      );

      expect(section).toMatch(aliasContext);
    },
  );

  it("lists the canonical run and run-control commands", () => {
    const section = commandSurfaceSection();

    const missingCommands = CANONICAL_COMMANDS.filter((command) => !documentedCommandPattern(command).test(section));

    expect(missingCommands).toEqual([]);
  });

  it("explains target, effort, and read/write mode flags with examples", () => {
    const docs = runbookDocs();

    expect(missingRequirements(docs, FLAG_DOCUMENTATION_REQUIREMENTS)).toEqual([]);
  });

  it("explains the run directory layout and sanitized export", () => {
    const docs = runbookDocs();

    expect(missingRequirements(docs, RUN_DIRECTORY_REQUIREMENTS)).toEqual([]);
  });

  it("keeps remote submission canonical via moka run and submit compatibility-only", () => {
    const cheatSheet = operatorGuideSection("## Command Cheat Sheet");
    const canonicalRemoteIndex = cheatSheet.indexOf("moka run --target remote");
    const submitIndex = cheatSheet.indexOf("moka submit");
    const submitCompatibilityContext = new RegExp(
      [
        `(compatibility|alias)[\\s\\S]{0,240}${escapedRegExp("moka submit")}`,
        `${escapedRegExp("moka submit")}[\\s\\S]{0,240}(compatibility|alias)`,
      ].join("|"),
      "iu",
    );

    expect(canonicalRemoteIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThanOrEqual(0);
    expect(canonicalRemoteIndex).toBeLessThan(submitIndex);
    expect(cheatSheet).toMatch(submitCompatibilityContext);
    expect(cheatSheet).not.toMatch(SUBMIT_PRIMARY_COMMAND_PATTERN);
  });

  it("documents moka ticket commands and mutation boundaries", () => {
    const section = commandSurfaceSection();
    const guide = operatorGuideSection("## Command Cheat Sheet");
    const docs = `${section}\n\n${guide}`;

    for (const command of MOKA_TICKET_COMMANDS) {
      expect(docs).toContain(command);
    }
    expect(docs).toMatch(MOKA_TICKET_RELATIONSHIP_PATTERN);
    expect(docs).toMatch(MOKA_TICKET_READ_ONLY_BOUNDARY_PATTERN);
    expect(docs).toMatch(MOKA_TICKET_START_DRY_RUN_BOUNDARY_PATTERN);
    expect(docs).toMatch(MOKA_TICKET_MUTATION_BOUNDARY_PATTERN);
    expect(docs).toMatch(BACKLOG_CLI_MARKDOWN_BOUNDARY_PATTERN);
  });
});
