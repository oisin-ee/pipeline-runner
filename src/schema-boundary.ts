import type { Effect } from "effect/Effect";
import { succeed } from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import { isSuccess } from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import { makeFormatterStandardSchemaV1 } from "effect/SchemaIssue";

export type EffectParseOptions = SchemaAST.ParseOptions;

type JsonSchemaObject = JsonSchema.JsonSchema;

const { Struct: makeStruct } = Schema;
const propertyKey = Schema.Union([Schema.Number, Schema.String, Schema.Symbol]);
const keyedIssuePathSegmentSchema = makeStruct({ key: Schema.Unknown });

export const struct = <const Fields extends Schema.Struct.Fields>(fields: Fields): Schema.Struct<Fields> =>
  makeStruct(fields);

export function booleanValue(): typeof Schema.Boolean {
  return Schema.Boolean;
}

export function numberValue(): typeof Schema.Number {
  return Schema.Number;
}

export function stringValue(): typeof Schema.String {
  return Schema.String;
}

export function taggedErrorClass<Self = never>(identifier?: string) {
  return Schema.TaggedErrorClass<Self>(identifier);
}

export function isObjectValue(value: unknown): value is object {
  return Schema.is(Schema.ObjectKeyword)(value);
}

export function literalSchema<L extends SchemaAST.LiteralValue>(value: L): Schema.Literal<L> {
  return Schema.Literal(value);
}

export function literalsSchema<const L extends readonly SchemaAST.LiteralValue[]>(values: L): Schema.Literals<L> {
  return Schema.Literals(values);
}

export function optionalSchema<S extends Schema.Constraint>(schema: S): Schema.optional<S> {
  return Schema.optional(schema);
}

export const requiredString = Schema.NonEmptyString;
export type requiredString = typeof requiredString.Type;

export const trimmedRequiredString = Schema.Trim.check(Schema.isNonEmpty());
export type trimmedRequiredString = typeof trimmedRequiredString.Type;

export const stringArray = Schema.mutable(Schema.Array(Schema.String));
export type stringArray = typeof stringArray.Type;

export const unknownRecord = Schema.Record(Schema.String, Schema.Unknown);
export type unknownRecord = typeof unknownRecord.Type;

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Schema.is(unknownRecord)(value);
}

export function isNumberValue(value: unknown): value is number {
  return Schema.is(numberValue())(value);
}

export function isStringValue(value: unknown): value is string {
  return Schema.is(stringValue())(value);
}

export const stringRecord = Schema.Record(Schema.String, Schema.String);
export type stringRecord = typeof stringRecord.Type;

export function stringRecordValue(value: unknown): stringRecord {
  const parsed = parseResultWithSchema(stringRecord, value);
  return parsed.ok ? parsed.value : {};
}

export const mutableArray = <S extends Schema.Constraint>(schema: S) => Schema.mutable(Schema.Array(schema));

export const nonEmptyMutableArray = <S extends Schema.Constraint>(schema: S) =>
  mutableArray(schema).check(Schema.isNonEmpty());

export const integer = Schema.Number.check(Schema.isInt());
export type integer = typeof integer.Type;

export const positiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
export type positiveInteger = typeof positiveInteger.Type;

export const nonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export type nonNegativeInteger = typeof nonNegativeInteger.Type;

export const positiveNumber = Schema.Number.check(Schema.isGreaterThan(0));
export type positiveNumber = typeof positiveNumber.Type;

export const regexString = (pattern: RegExp) => Schema.String.check(Schema.isPattern(pattern));

export const literalEnum = <const T extends readonly SchemaAST.LiteralValue[]>(values: T): Schema.Literals<T> =>
  Schema.Literals(values);

export const withDefault = <S extends Schema.Constraint>(
  schema: S,
  value: S["Encoded"],
): Schema.withDecodingDefault<S, never> => Schema.withDecodingDefault(succeed(value))(schema);

export const urlString = Schema.String.check(
  Schema.makeFilter<string>((value) => URL.canParse(value) || "must be a valid URL", {
    description: "String must parse as a URL.",
    identifier: "UrlString",
    jsonSchema: { format: "uri" },
    title: "URL string",
  }),
);
export type urlString = typeof urlString.Type;

export interface EffectSchemaIssue {
  message: string;
  path: readonly PropertyKey[];
  sourceMessage?: string;
}

export type EffectSchemaParseResult<T> =
  | { ok: true; value: T }
  | { error: Error; issues: readonly EffectSchemaIssue[]; ok: false };

const schemaIssueFormatter = makeFormatterStandardSchemaV1();

const isPropertyKey: (value: unknown) => value is PropertyKey = Schema.is(propertyKey);

const issuePathKey = (segment: unknown): PropertyKey => {
  if (isPropertyKey(segment)) {
    return segment;
  }
  if (Schema.is(keyedIssuePathSegmentSchema)(segment)) {
    const key = segment.key;
    if (isPropertyKey(key)) {
      return key;
    }
  }
  return String(segment);
};

const issuePath = (path: readonly unknown[] = []): readonly PropertyKey[] => path.map(issuePathKey);

const lastIssuePathSegmentText = (path: readonly PropertyKey[]): string => String(path.at(-1) ?? "");

const expectedArrayMessage = (message: string): string =>
  message.startsWith("Expected array, got ") ? "Invalid input: expected array, received string" : message;

const expectedValueMessage = (message: string): string => {
  if (!message.startsWith("Expected ")) {
    return message;
  }
  if (message.includes("length of at least")) {
    return message;
  }
  if (message.startsWith("Expected {") && message.includes('"kind"')) {
    return "Invalid discriminator value";
  }
  if (message.startsWith('Expected "')) {
    return `Invalid option: ${message}`;
  }
  return "Invalid input";
};

const expectedMessage = (message: string): string => expectedValueMessage(expectedArrayMessage(message));

const publicIssueMessage = (issue: EffectSchemaIssue): string => {
  if (issue.message.startsWith("Unexpected key with value")) {
    return `Unrecognized key: "${lastIssuePathSegmentText(issue.path)}"`;
  }
  if (issue.message === "Missing key") {
    return "Invalid input";
  }
  return expectedMessage(issue.message);
};

class EffectSchemaParseError extends Schema.TaggedErrorClass<EffectSchemaParseError>()("EffectSchemaParseError", {
  message: Schema.String,
}) {}

const schemaErrorIssues = (error: Error): readonly EffectSchemaIssue[] => {
  if (!Schema.isSchemaError(error)) {
    return [
      {
        message: error.message,
        path: [],
      },
    ];
  }

  return schemaIssueFormatter(error.issue).issues.map((issue) => {
    const publicIssue = {
      message: issue.message,
      path: issuePath(issue.path),
      sourceMessage: issue.message,
    };
    return {
      ...publicIssue,
      message: publicIssueMessage(publicIssue),
    };
  });
};

export const formatSchemaIssueList = (issues: readonly EffectSchemaIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

const withJsonSchemaMeta = (document: JsonSchema.Document<"draft-07">): JsonSchemaObject => ({
  $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
  ...document.schema,
  definitions: document.definitions,
});

const parseOptionsWithAllErrors = (options?: EffectParseOptions): EffectParseOptions => ({ errors: "all", ...options });

export const parseWithSchema = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  options?: EffectParseOptions,
): S["Type"] => Schema.decodeUnknownSync(schema, parseOptionsWithAllErrors(options))(input);

export const parseStrictWithSchema = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  options?: EffectParseOptions,
): S["Type"] => parseWithSchema(schema, input, { ...options, onExcessProperty: "error" });

export const parseJsonWithSchema = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string,
  options?: EffectParseOptions,
): S["Type"] => parseWithSchema(Schema.fromJsonString(schema), source, options);

export const parseResultWithSchema = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  options?: EffectParseOptions,
): EffectSchemaParseResult<S["Type"]> => {
  const result = Schema.decodeUnknownResult(schema, parseOptionsWithAllErrors(options))(input);
  if (isSuccess(result)) {
    return { ok: true, value: result.success };
  }
  const issues = schemaErrorIssues(result.failure);
  const message = formatSchemaIssueList(issues);

  return {
    error: new EffectSchemaParseError({ message }),
    issues,
    ok: false,
  };
};

export const decodeWithSchema = <S extends Schema.Constraint>(
  schema: S,
  input: unknown,
  options?: EffectParseOptions,
): Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]> => Schema.decodeUnknownEffect(schema, options)(input);

const effectSchemaDocument = (
  schema: Schema.Constraint,
  options?: Schema.ToJsonSchemaOptions,
): JsonSchema.Document<"draft-2020-12"> => Schema.toJsonSchemaDocument(schema, options);

export const effectSchemaDocumentDraft07 = (
  schema: Schema.Constraint,
  options?: Schema.ToJsonSchemaOptions,
): JsonSchemaObject => withJsonSchemaMeta(JsonSchema.toDocumentDraft07(effectSchemaDocument(schema, options)));
