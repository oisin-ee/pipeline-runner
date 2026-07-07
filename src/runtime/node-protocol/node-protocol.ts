import * as Schema from "effect/Schema";

import {
  integer,
  mutableArray,
  nonNegativeInteger,
  parseStrictWithSchema,
  requiredString,
  struct,
} from "../../schema-boundary";
import type { AcceptanceCriterion, RuntimeNodeResult } from "../contracts";

const acceptanceCriterionSchema = struct({
  id: requiredString,
  text: requiredString,
});

const upstreamOutputSchema = struct({
  nodeId: requiredString,
  output: Schema.String,
});

export const nextNodeEnvelopeSchema = struct({
  criteria: Schema.Array(acceptanceCriterionSchema),
  nodeId: requiredString,
  prompt: Schema.String,
  runId: requiredString,
  upstreamOutputs: Schema.Array(upstreamOutputSchema),
});

export type NextNodeEnvelope = typeof nextNodeEnvelopeSchema.Type;

const runtimeNodeResultSchema = struct({
  attempts: nonNegativeInteger,
  evidence: mutableArray(Schema.String),
  exitCode: integer,
  nodeId: requiredString,
  output: Schema.String,
  status: Schema.Literals(["failed", "passed"]),
});

const submitResultBaseSchema = struct({
  nodeId: requiredString,
  result: runtimeNodeResultSchema,
  runId: requiredString,
});

export const submitResultSchema = submitResultBaseSchema.check(
  Schema.makeFilter(
    (value) =>
      value.result.nodeId === value.nodeId
        ? true
        : {
            issue: "result.nodeId must match the submitted nodeId",
            path: ["result", "nodeId"],
          },
    {
      description:
        "Submitted runtime result must belong to the submitted node.",
      identifier: "SubmitResultNodeIdConsistency",
      title: "Submit result node id consistency",
    }
  )
);

export type SubmitResult = typeof submitResultSchema.Type;

const nextNodeEnvelopeTypeGuard: { readonly Type: NextNodeEnvelope } =
  nextNodeEnvelopeSchema;
const submitResultTypeGuard: { readonly Type: SubmitResult } =
  submitResultSchema;
const acceptanceCriterionTypeGuard: {
  readonly Type: Readonly<AcceptanceCriterion>;
} = acceptanceCriterionSchema;
const runtimeNodeResultTypeGuard: { readonly Type: RuntimeNodeResult } =
  runtimeNodeResultSchema;

void nextNodeEnvelopeTypeGuard;
void submitResultTypeGuard;
void acceptanceCriterionTypeGuard;
void runtimeNodeResultTypeGuard;

const freezeNextNodeEnvelope = (envelope: NextNodeEnvelope): NextNodeEnvelope =>
  Object.freeze({
    ...envelope,
    criteria: Object.freeze(
      envelope.criteria.map((criterion) => Object.freeze({ ...criterion }))
    ),
    upstreamOutputs: Object.freeze(
      envelope.upstreamOutputs.map((output) => Object.freeze({ ...output }))
    ),
  });

export const parseNextNodeEnvelope = (value: unknown): NextNodeEnvelope =>
  freezeNextNodeEnvelope(parseStrictWithSchema(nextNodeEnvelopeSchema, value));

export const parseSubmitResult = (value: unknown): SubmitResult =>
  parseStrictWithSchema(submitResultSchema, value);
