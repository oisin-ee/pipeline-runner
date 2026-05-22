/**
 * Pipeline phase → profile resolver.
 *
 * Reads `.pipeline/config.toml` (or built-in default) and the parent ticket's
 * frontmatter to decide which `@oisin-ee/profile-<name>` to dispatch per phase
 * in --strict mode.
 *
 * Used only by the strict adapter. Soft mode (default `pipe` CLI) does not
 * invoke this; the orchestrator profile's rules handle phase dispatch
 * directly via native subagent invocation.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { parse as parseTOML } from "smol-toml";

import type { AgentRole } from "./runner.js";

export type PipelinePhase = AgentRole;

export interface PhaseSpec {
  candidates: string[];
  default?: string;
}

export interface PipelineConfig {
  phases: Record<PipelinePhase, PhaseSpec>;
}

/**
 * Built-in default config used when the consuming project has no
 * `.pipeline/config.toml`. Mirrors the schema documented in the integration
 * plan. RED + GREEN intentionally have no `default` — a multi-candidate
 * domain phase MUST be resolved from ticket frontmatter or it errors.
 */
export const BUILT_IN_CONFIG: PipelineConfig = {
  phases: {
    researcher: {
      candidates: ["researcher"],
      default: "researcher",
    },
    "test-writer": {
      candidates: ["frontend", "backend"],
    },
    "code-writer": {
      candidates: ["frontend", "backend"],
    },
    verifier: {
      candidates: ["verifier"],
      default: "verifier",
    },
  },
};

/**
 * Maps the runner's `AgentRole` to the pipeline.toml frontmatter key.
 * Runner roles use long verbs ("test-writer"); ticket frontmatter uses the
 * short phase name ("red", "green") that's more natural for humans to write.
 */
const ROLE_TO_TICKET_KEY: Record<AgentRole, string> = {
  researcher: "research",
  "test-writer": "red",
  "code-writer": "green",
  verifier: "verify",
};

interface TicketResult {
  description: string;
  ticketId: string | null;
}

const TICKET_RE = /^([A-Z]+-\d+)\b\s*(.*)$/s;

/**
 * Extract a Backlog.md ticket id (e.g. "PIPE-42") from the start of a free-form
 * description string. Returns the id and the remaining description.
 */
export function parseTicketAndDescription(input: string): TicketResult {
  const m = input.match(TICKET_RE);
  if (m) {
    return {
      ticketId: m[1] ?? null,
      description: (m[2] ?? "").trim() || (m[1] ?? ""),
    };
  }
  return { ticketId: null, description: input };
}

/**
 * Load `.pipeline/config.toml` from a worktree, falling back to `BUILT_IN_CONFIG`.
 * Schema is lenient: any phase listed in BUILT_IN_CONFIG that's missing from
 * the user file inherits the built-in for that phase.
 */
export function loadPipelineConfig(worktreePath: string): PipelineConfig {
  const path = join(worktreePath, ".pipeline", "config.toml");
  if (!existsSync(path)) {
    return BUILT_IN_CONFIG;
  }

  let raw: unknown;
  try {
    raw = parseTOML(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }

  const userPhases =
    (raw as { phases?: Record<string, PhaseSpec> }).phases ?? {};
  const merged: Record<PipelinePhase, PhaseSpec> = {
    ...BUILT_IN_CONFIG.phases,
  };
  for (const role of Object.keys(BUILT_IN_CONFIG.phases) as PipelinePhase[]) {
    const ticketKey = ROLE_TO_TICKET_KEY[role];
    const fromUser = userPhases[ticketKey] ?? userPhases[role];
    if (fromUser) {
      merged[role] = fromUser;
    }
  }
  return { phases: merged };
}

/**
 * Read a parent Backlog.md ticket's `pipeline.<phase>` frontmatter override.
 *
 * Pipeline frontmatter shape:
 * ```
 * ---
 * id: PIPE-42
 * pipeline:
 *   red: backend
 *   green: backend
 * ---
 * ```
 *
 * Returns the override string for the given role (mapped through ROLE_TO_TICKET_KEY)
 * or null when there is no ticket id, the file doesn't exist, or the field is unset.
 */
export function readTicketOverride(
  role: AgentRole,
  ticketId: string | null,
  worktreePath: string
): string | null {
  if (!ticketId) {
    return null;
  }
  // Backlog.md tasks are stored as `backlog/tasks/<pipe-N> - <title>.md` —
  // the file *starts* with the slug. We match by prefix on a sorted scan.
  const tasksDir = join(worktreePath, "backlog", "tasks");
  if (!existsSync(tasksDir)) {
    return null;
  }

  // Find a file whose name starts with the ticket id's lowercase slug followed
  // by a space-dash. Backlog.md normalizes ids to lowercase in the filename
  // (e.g. PIPE-42 → "pipe-42 - …").
  const slug = ticketId.toLowerCase();
  const candidates = readdirSync(tasksDir).filter(
    (name) => name.toLowerCase().startsWith(`${slug} `) && name.endsWith(".md")
  );
  if (candidates.length === 0) {
    return null;
  }
  const file = join(tasksDir, candidates[0] as string);

  const parsed = matter(readFileSync(file, "utf8"));
  const ticketKey = ROLE_TO_TICKET_KEY[role];
  const pipeline = (parsed.data as { pipeline?: Record<string, string> })
    .pipeline;
  if (!pipeline) {
    return null;
  }
  const val = pipeline[ticketKey];
  return typeof val === "string" ? val : null;
}

/**
 * Resolve which profile name dispatches the given phase for this ticket.
 *
 * Order:
 *   1. Ticket frontmatter override (`pipeline.<phase>` in `backlog/tasks/<id>.md`).
 *   2. Config default (`.pipeline/config.toml` or built-in).
 *   3. Throw with a clear message naming the candidates the user needs to pick from.
 *
 * The returned string is also the npm package name suffix
 * (`@oisin-ee/profile-<returned>`) and the bin name on PATH.
 */
export function resolveProfileForPhase(
  role: AgentRole,
  ticketId: string | null,
  worktreePath: string
): string {
  const config = loadPipelineConfig(worktreePath);
  const phase = config.phases[role];
  if (!phase) {
    throw new Error(`no candidates configured for phase '${role}'`);
  }

  const override = readTicketOverride(role, ticketId, worktreePath);
  if (override) {
    if (!phase.candidates.includes(override)) {
      throw new Error(
        `ticket '${ticketId}' requests profile '${override}' for phase '${role}', ` +
          `but candidates are [${phase.candidates.join(", ")}]`
      );
    }
    return override;
  }

  if (phase.default) {
    return phase.default;
  }

  throw new Error(
    `phase '${role}' has no default in .pipeline/config.toml; ticket ` +
      `${ticketId ?? "(none detected)"} did not declare a 'pipeline.${ROLE_TO_TICKET_KEY[role]}' override. ` +
      `Choose one of: [${phase.candidates.join(", ")}].`
  );
}
