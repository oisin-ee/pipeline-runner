import { z } from "zod";

/**
 * NodeHandoff (PIPE-83.1) — the curated, typed envelope a node hands to its
 * dependents in place of its raw transcript. PIPE-83.5 makes renderAgentPrompt
 * consume these instead of re-hydrating every upstream node's full output text;
 * PIPE-83.10 persists them durably as the unit of cross-node state.
 *
 * Produced by DERIVING from a node's raw output via a cheap finalizer (see
 * agent-node), with a synthesized minimal fallback when no structured handoff
 * is available so existing consumers keep working unchanged.
 */
const MARKDOWN_JSON_FENCE_RE =
  /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i;
const SUMMARY_FALLBACK_MAX_CHARS = 600;

const handoffArtifactSchema = z.object({
  lineRange: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .optional(),
  path: z.string().min(1),
});

const nodeHandoffSchema = z.object({
  artifacts: z.array(handoffArtifactSchema).default([]),
  decisions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  summary: z.string(),
  testNames: z.array(z.string()).default([]),
});

export type NodeHandoff = z.infer<typeof nodeHandoffSchema>;

/**
 * Parse a candidate handoff JSON string (tolerant of a Markdown ```json fence).
 * Returns null when the text is not JSON or does not satisfy the schema, so the
 * caller can fall back rather than throw.
 */
export function parseHandoff(raw: string): NodeHandoff | null {
  const fenced = MARKDOWN_JSON_FENCE_RE.exec(raw.trim());
  const source = fenced?.[1].trim() ?? raw.trim();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  const result = nodeHandoffSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Minimal handoff synthesized from a node's raw output text. Used when no
 * structured handoff is derived, preserving the pre-PIPE-83 behaviour (the
 * summary stands in for the raw text downstream consumers used to receive).
 */
export function synthesizeMinimalHandoff(outputText: string): NodeHandoff {
  return {
    artifacts: [],
    decisions: [],
    openQuestions: [],
    summary: outputText.trim().slice(0, SUMMARY_FALLBACK_MAX_CHARS),
    testNames: [],
  };
}

/** Prompt for the cheap finalizer that derives a handoff from raw node output. */
export function handoffFinalizerPrompt(rawOutput: string): string {
  return [
    "You are a handoff summarizer for a pipeline node.",
    "Read the agent output below and return ONLY a JSON object describing what a",
    "downstream node needs to continue — no Markdown fences, no prose outside JSON.",
    "",
    "Fields:",
    '- "summary": string — concise description of what this node accomplished.',
    '- "decisions": string[] — explicit choices made (libraries, APIs, approaches).',
    '- "artifacts": {"path": string, "lineRange"?: [number, number]}[] — files touched.',
    '- "testNames": string[] — tests added or changed.',
    '- "openQuestions": string[] — unresolved items the next node should know.',
    "Use empty arrays where nothing applies. Preserve facts; do not invent.",
    "",
    "Agent output:",
    rawOutput,
  ].join("\n");
}
