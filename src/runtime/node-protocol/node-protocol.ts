import { z } from "zod";

import type { AcceptanceCriterion, RuntimeNodeResult } from "../contracts";

/**
 * Node-execution protocol (PIPE-91.2, orchestrator-design decision #1) — the
 * executor-agnostic contract between moka and whatever runs a node: the
 * production spawn plug AND the debug human plug speak the same protocol. The
 * debug plug crosses a process/serialization boundary, so both shapes are zod
 * schemas that round-trip JSON. The schemas are the single source of truth; the
 * exported types are derived with {@link z.infer}, never hand-written.
 *
 * Resolves the design's named open risk ("node-execution protocol shape
 * unspecified") and is the shared contract `moka next node` (PIPE-91.6) and
 * submit-result (PIPE-91.7) build on.
 */

/**
 * One acceptance criterion as carried IN the envelope. Read-only to the
 * executing agent (decision #7 — criteria + their adjudicating tests are owned
 * by the schedule/planner, never writable by the node's agent; anti
 * reward-hacking). `.readonly()` freezes the parsed value at runtime AND infers
 * `readonly` fields. The `z.ZodType<Readonly<AcceptanceCriterion>>` annotation
 * pins the shape to {@link AcceptanceCriterion} in contracts.ts: a contract
 * change that this schema does not track fails typecheck here instead of
 * drifting silently. (Annotation, not `satisfies`/`as` — no type-system escape.)
 */
const acceptanceCriterionSchema: z.ZodType<Readonly<AcceptanceCriterion>> = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
  })
  .strict()
  .readonly();

/**
 * One upstream dependency's produced output, keyed by its `nodeId`. The
 * executor folds these into the node's context; `output` mirrors
 * {@link RuntimeNodeResult.output} (the terminal node output text).
 */
const upstreamOutputSchema = z
  .object({
    nodeId: z.string().min(1),
    output: z.string(),
  })
  .strict();

/**
 * Emitted by `moka next node`: everything one node needs to execute, made
 * explicit and serializable. `prompt` is the node's instruction; `criteria` are
 * the read-only acceptance criteria; `upstreamOutputs` are the dependency
 * outputs the executor folds in. `.strict()` rejects unknown keys so a malformed
 * envelope fails loudly rather than silently dropping data.
 */
export const nextNodeEnvelopeSchema = z
  .object({
    criteria: z.array(acceptanceCriterionSchema).readonly(),
    nodeId: z.string().min(1),
    prompt: z.string(),
    runId: z.string().min(1),
    upstreamOutputs: z.array(upstreamOutputSchema),
  })
  .strict();

export type NextNodeEnvelope = z.infer<typeof nextNodeEnvelopeSchema>;

/**
 * The terminal output of a node, validated against {@link RuntimeNodeResult}.
 * contracts.ts owns the TS type (no zod schema there, and PIPE-91.2's write
 * boundary forbids editing it); the `z.ZodType<RuntimeNodeResult>` annotation
 * keeps this schema in lockstep with that type at typecheck time without
 * touching contracts.ts.
 */
const runtimeNodeResultSchema: z.ZodType<RuntimeNodeResult> = z
  .object({
    attempts: z.number().int().nonnegative(),
    evidence: z.array(z.string()),
    exitCode: z.number().int(),
    nodeId: z.string().min(1),
    output: z.string(),
    status: z.enum(["failed", "passed"]),
  })
  .strict();

/**
 * The input accepted by submit-result (PIPE-91.7): a {@link RuntimeNodeResult}
 * keyed by `(runId, nodeId)`. The refinement enforces the keying — the carried
 * result must be for the same node the envelope addressed — so a mismatched
 * submission is rejected with a structured error rather than corrupting run
 * state.
 */
export const submitResultSchema = z
  .object({
    nodeId: z.string().min(1),
    result: runtimeNodeResultSchema,
    runId: z.string().min(1),
  })
  .strict()
  .refine((value) => value.result.nodeId === value.nodeId, {
    message: "result.nodeId must match the submitted nodeId",
    path: ["result", "nodeId"],
  });

export type SubmitResult = z.infer<typeof submitResultSchema>;

/**
 * Parse + validate a {@link NextNodeEnvelope} (e.g. JSON received over the debug
 * plug). Throws a structured {@link z.ZodError} on malformed input — never
 * swallows it.
 */
export const parseNextNodeEnvelope = (value: unknown): NextNodeEnvelope =>
  nextNodeEnvelopeSchema.parse(value);

/**
 * Parse + validate a {@link SubmitResult}. Throws a structured
 * {@link z.ZodError} on malformed input or a `(runId, nodeId)` key mismatch.
 */
export const parseSubmitResult = (value: unknown): SubmitResult =>
  submitResultSchema.parse(value);
