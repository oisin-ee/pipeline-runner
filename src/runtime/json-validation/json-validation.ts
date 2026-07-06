import { join } from "node:path";

import Ajv from "ajv";
import type { AnySchema, ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { Effect, Option } from "effect";

import { isRecord, parseJsonRecord, parseJson as parseSafeJson } from "../../safe-json";
import { standardOutputSchemaJson, standardOutputSchemaNameFromPath } from "../../standard-output-schemas";
import type { JsonSchemaValidationResult } from "../contracts";
import { FileSystemService, FileSystemServiceLive, runFileSystemSync } from "../services/file-system-service";

const LINE_RE = /\r?\n/u;
const MARKDOWN_JSON_FENCE_RE = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/iu;
const jsonSchemaValidator = addFormats(new Ajv({ allErrors: true, strict: false }));
const jsonSchemaValidatorCache = new Map<
  string,
  {
    source: string;
    validate: ReturnType<typeof jsonSchemaValidator.compile>;
  }
>();

const jsonSchemaValidationEvidence = (schemaPath: string, errors: string[]): string[] =>
  errors.length === 0 ? [`JSON schema passed: ${schemaPath}`] : errors.map((error) => `schema: ${error}`);

const jsonSchemaValidationSuccess = (schemaPath: string, errors: string[]): JsonSchemaValidationResult => ({
  evidence: jsonSchemaValidationEvidence(schemaPath, errors),
  passed: errors.length === 0,
  reason: errors.length === 0 ? undefined : "JSON schema validation failed",
});

export const normalizeJsonSource = (source: string): string => {
  const trimmed = source.trim();
  const fenced = MARKDOWN_JSON_FENCE_RE.exec(trimmed);
  return fenced?.[1].trim() ?? trimmed;
};

export const parseRuntimeOutput = (format: string, output: string): { error?: string; output: unknown } => {
  if (!(format === "json" || format === "json_schema" || format === "jsonl")) {
    return { output };
  }
  try {
    if (format === "jsonl") {
      return {
        output: output
          .split(LINE_RE)
          .filter((line) => line.trim().length > 0)
          .map((line) => parseSafeJson(line, "runtime JSONL line")),
      };
    }
    return {
      output: parseSafeJson(normalizeJsonSource(output), "runtime JSON output"),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "failed to parse output",
      output,
    };
  }
};

const readJsonSchemaSourceEffect = (
  schemaPath: string,
  worktreePath: string,
): Effect.Effect<string, unknown, FileSystemService> => {
  const standardName = standardOutputSchemaNameFromPath(schemaPath);
  if (standardName) {
    return Effect.succeed(standardOutputSchemaJson(standardName));
  }
  return Effect.gen(function* effectBody() {
    const fileSystem = yield* FileSystemService;
    return yield* fileSystem.readText(join(worktreePath, schemaPath));
  });
};

export const readJsonSchemaSource = (schemaPath: string, worktreePath: string): string =>
  runFileSystemSync(readJsonSchemaSourceEffect(schemaPath, worktreePath), FileSystemServiceLive);

const isJsonSchema = (value: unknown): value is AnySchema => typeof value === "boolean" || isRecord(value);

const compiledJsonSchemaValidator = (
  schemaPath: string,
  schemaSource: string,
): ReturnType<typeof jsonSchemaValidator.compile> => {
  const cached = jsonSchemaValidatorCache.get(schemaPath);
  if (cached?.source === schemaSource) {
    return cached.validate;
  }
  const schema = parseSafeJson(schemaSource, `JSON schema ${schemaPath}`);
  if (!isJsonSchema(schema)) {
    throw new Error(`JSON schema ${schemaPath} must be an object or boolean`);
  }
  const validate = jsonSchemaValidator.compile(schema);
  jsonSchemaValidatorCache.set(schemaPath, { source: schemaSource, validate });
  return validate;
};

const readOptionalFileEffect = (path: string): Effect.Effect<Option.Option<string>, unknown, FileSystemService> =>
  Effect.gen(function* effectBody() {
    const fileSystem = yield* FileSystemService;
    const exists = yield* fileSystem.exists(path);
    return exists ? Option.some(yield* fileSystem.readText(path)) : Option.none();
  });

export const readOptionalFile = (path: string): Option.Option<string> =>
  runFileSystemSync(readOptionalFileEffect(path), FileSystemServiceLive);

const jsonSchemaValidationFailure = (error: unknown): JsonSchemaValidationResult => ({
  evidence: [error instanceof Error ? error.message : String(error)],
  passed: false,
  reason: "JSON schema validation failed",
});

const formatJsonSchemaErrors = (errors: ErrorObject[]): string[] =>
  errors.map((error) => {
    const path = error.instancePath || "$";
    return `${path} ${error.message ?? "failed validation"}`.trim();
  });

const validateJsonSchemaValue = (
  source: string,
  schemaPath: string,
  schemaSource: string,
): JsonSchemaValidationResult => {
  const value = parseSafeJson(normalizeJsonSource(source), "JSON schema gate value");
  const validate = compiledJsonSchemaValidator(schemaPath, schemaSource);
  const errors = validate(value) === true ? [] : formatJsonSchemaErrors(validate.errors ?? []);
  return jsonSchemaValidationSuccess(schemaPath, errors);
};

const validateJsonSchemaSourceEffect = (
  source: string,
  schemaPath: string,
  worktreePath: string,
): Effect.Effect<JsonSchemaValidationResult, never, FileSystemService> =>
  Effect.catch(
    Effect.gen(function* effectBody() {
      const schemaSource = yield* readJsonSchemaSourceEffect(schemaPath, worktreePath);
      return yield* Effect.try({
        catch: (error) => error,
        try: () => validateJsonSchemaValue(source, schemaPath, schemaSource),
      });
    }),
    (error) => Effect.succeed(jsonSchemaValidationFailure(error)),
  );

export const validateJsonSchemaSource = (
  source: string,
  schemaPath: string,
  worktreePath: string,
): JsonSchemaValidationResult =>
  runFileSystemSync(validateJsonSchemaSourceEffect(source, schemaPath, worktreePath), FileSystemServiceLive);

export const parseJsonObject = (value?: unknown): Record<string, unknown> =>
  parseJsonRecord(value, "runtime JSON object");
