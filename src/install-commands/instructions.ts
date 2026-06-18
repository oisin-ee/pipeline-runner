import { readFileSync } from "node:fs";
import { resolvePackageAssetPath } from "../package-assets";
import {
  type CommandDefinition,
  GENERATED_MARKER,
  type HarnessHost,
  INSTRUCTIONS_END,
  INSTRUCTIONS_START,
  OWNER_MARKER_PREFIX,
} from "./shared";

/**
 * The canonical global agent instruction body, package-owned so every machine,
 * k8s job, and host renders the same behavior. Shipped in `defaults/` (see
 * package.json `files`).
 */
const INSTRUCTION_BODY: string = readFileSync(
  resolvePackageAssetPath("defaults/instructions/global.md"),
  "utf8"
).trimEnd();

/**
 * The global instruction memory file each host reads, and the repo-relative
 * path that `resolveHarnessTarget` rebases onto its per-machine config dir.
 * Distinct from the bare `AGENTS.md` project guidance file, so these coexist
 * with (and never trip) the PROJECT_ONLY AGENTS.md handling.
 */
const INSTRUCTION_TARGETS: { host: HarnessHost; path: string }[] = [
  { host: "claude-code", path: ".claude/CLAUDE.md" },
  { host: "codex", path: ".codex/AGENTS.md" },
  { host: "gemini", path: ".gemini/GEMINI.md" },
];

/** Repo-relative paths of every generated instruction file (global scope). */
export const INSTRUCTION_PATHS: readonly string[] = INSTRUCTION_TARGETS.map(
  (target) => target.path
);

function instructionContent(host: HarnessHost): string {
  return `${[
    INSTRUCTIONS_START,
    GENERATED_MARKER,
    `${OWNER_MARKER_PREFIX}host=${host} -->`,
    "",
    INSTRUCTION_BODY,
    "",
    INSTRUCTIONS_END,
  ].join("\n")}\n`;
}

/**
 * Per-host global instruction definitions. Each is upserted as a marker block
 * so any user-authored content outside the markers in the target file is
 * preserved. Emitted in global scope only (see GLOBAL_ONLY_PATHS).
 */
export function globalInstructionDefinitions(): CommandDefinition[] {
  return INSTRUCTION_TARGETS.map(({ host, path }) => ({
    block: { end: INSTRUCTIONS_END, start: INSTRUCTIONS_START },
    content: instructionContent(host),
    host,
    invocation: "(global instructions)",
    path,
  }));
}
