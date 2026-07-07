import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  mutableArray,
  nonNegativeInteger,
  parseResultWithSchema,
  requiredString,
  stringArray,
  withDefault,
  struct,
} from "../schema-boundary";

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
  /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/iu;
const SUMMARY_FALLBACK_MAX_CHARS = 600;

const handoffArtifactSchema = struct({
  lineRange: Schema.optional(
    Schema.mutable(Schema.Tuple([nonNegativeInteger, nonNegativeInteger]))
  ),
  path: requiredString,
});

const nodeHandoffSchema = struct({
  artifacts: withDefault(mutableArray(handoffArtifactSchema), []),
  decisions: withDefault(stringArray, []),
  openQuestions: withDefault(stringArray, []),
  summary: Schema.String,
  testNames: withDefault(stringArray, []),
});

export type NodeHandoff = typeof nodeHandoffSchema.Type;

/**
 * Parse a candidate handoff JSON string (tolerant of a Markdown ```json fence).
 * Returns null when the text is not JSON or does not satisfy the schema, so the
 * caller can fall back rather than throw.
 */
export const parseHandoff = (raw: string): Option.Option<NodeHandoff> => {
  const fenced = MARKDOWN_JSON_FENCE_RE.exec(raw.trim());
  const source = fenced?.[1].trim() ?? raw.trim();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return Option.none();
  }
  const result = parseResultWithSchema(nodeHandoffSchema, value);
  return result.ok ? Option.some(result.value) : Option.none();
};

/**
 * Minimal handoff synthesized from a node's raw output text. Used when no
 * structured handoff is derived, preserving the pre-PIPE-83 behaviour (the
 * summary stands in for the raw text downstream consumers used to receive).
 */
export const synthesizeMinimalHandoff = (outputText: string): NodeHandoff => ({
  artifacts: [],
  decisions: [],
  openQuestions: [],
  summary: outputText.trim().slice(0, SUMMARY_FALLBACK_MAX_CHARS),
  testNames: [],
});

/**
 * Render a handoff into the compact text a dependent node receives (PIPE-83.5):
 * the curated summary + non-empty sections, in place of the full raw transcript.
 */
export const renderHandoff = (nodeId: string, handoff: NodeHandoff): string => {
  const sections: [string, string[]][] = [
    ["Decisions:", handoff.decisions],
    [
      "Artifacts:",
      handoff.artifacts.map((a) =>
        a.lineRange ? `${a.path}:${a.lineRange[0]}-${a.lineRange[1]}` : a.path
      ),
    ],
    ["Tests:", handoff.testNames],
    ["Open questions:", handoff.openQuestions],
  ];
  const lines = [`## ${nodeId}`, handoff.summary];
  for (const [heading, items] of sections) {
    if (items.length > 0) {
      lines.push(heading, ...items.map((item) => `- ${item}`));
    }
  }
  return lines.join("\n");
};

/** Prompt for the cheap finalizer that derives a handoff from raw node output. */
export const handoffFinalizerPrompt = (rawOutput: string): string =>
  [
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
