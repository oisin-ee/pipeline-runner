import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

import {
  effectSchemaDocumentDraft07,
  mutableArray,
  nonEmptyMutableArray,
  positiveInteger,
  requiredString,
  stringArray,
  struct,
} from "./schema-boundary";
import { ticketPlanSchema } from "./tickets/ticket-plan";

const VERDICT_SCHEMA = Schema.Literals(["PASS", "FAIL"]);
const STRING_ARRAY_SCHEMA = stringArray;

const CHANGE_SCHEMA = struct({
  files: nonEmptyMutableArray(requiredString),
  summary: requiredString,
  why: requiredString,
});

const STANDARD_OUTPUT_SCHEMAS = {
  acceptance: struct({
    acceptance: mutableArray(
      struct({
        evidence: STRING_ARRAY_SCHEMA,
        id: Schema.String,
        verdict: VERDICT_SCHEMA,
        violations: Schema.optional(STRING_ARRAY_SCHEMA),
      }),
    ),
    evidence: STRING_ARRAY_SCHEMA,
    verdict: VERDICT_SCHEMA,
    violations: Schema.optional(STRING_ARRAY_SCHEMA),
  }),
  implementation: struct({
    changes: nonEmptyMutableArray(CHANGE_SCHEMA),
    followups: Schema.optional(STRING_ARRAY_SCHEMA),
    lessons: Schema.optional(STRING_ARRAY_SCHEMA),
    risks: Schema.optional(STRING_ARRAY_SCHEMA),
    summary: Schema.optional(Schema.String),
    verification: STRING_ARRAY_SCHEMA,
  }),
  learn: struct({
    evidence: STRING_ARRAY_SCHEMA,
    qdrant: struct({
      attempted: Schema.Boolean,
      succeeded: Schema.Boolean,
    }),
  }),
  research: struct({
    ac: STRING_ARRAY_SCHEMA,
    files: Schema.optional(STRING_ARRAY_SCHEMA),
    findings: STRING_ARRAY_SCHEMA,
    risks: Schema.optional(STRING_ARRAY_SCHEMA),
    target: Schema.optional(Schema.String),
  }),
  review: struct({
    findings: mutableArray(
      struct({
        file: Schema.optional(Schema.String),
        line: Schema.optional(positiveInteger),
        message: Schema.String,
        rule: Schema.optional(Schema.String),
        severity: Schema.Literals(["info", "warn", "error", "critical"]),
      }),
    ),
    summary: Schema.optional(Schema.String),
    verdict: VERDICT_SCHEMA,
  }),
  "ticket-plan": ticketPlanSchema,
  verify: struct({
    evidence: STRING_ARRAY_SCHEMA,
    verdict: VERDICT_SCHEMA,
    violations: Schema.optional(STRING_ARRAY_SCHEMA),
  }),
};

const standardOutputSchemaNames = R.keys(STANDARD_OUTPUT_SCHEMAS).toSorted();
export type StandardOutputSchemaName = (typeof standardOutputSchemaNames)[number];
const NO_STANDARD_OUTPUT_SCHEMA = null;
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const standardOutputSchemaJson = (name: StandardOutputSchemaName): string => {
  const schema = STANDARD_OUTPUT_SCHEMAS[name];
  return encodeUnknownJson(effectSchemaDocumentDraft07(schema));
};

const standardOutputSchemaPath = (name: StandardOutputSchemaName): string => `.pipeline/schemas/${name}.schema.json`;

export const standardOutputSchemaNameFromPath = (
  schemaPath: string,
): StandardOutputSchemaName | typeof NO_STANDARD_OUTPUT_SCHEMA => {
  const normalized = schemaPath.replaceAll("\\", "/");
  return Option.getOrElse(
    Arr.findFirst(standardOutputSchemaNames, (name) => normalized === standardOutputSchemaPath(name)),
    () => NO_STANDARD_OUTPUT_SCHEMA,
  );
};
