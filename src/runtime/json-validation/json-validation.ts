import { join } from "node:path";
import Ajv, { type AnySchema, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { Effect } from "effect";
import {
  isRecord,
  parseJsonRecord,
  parseJson as parseSafeJson,
} from "../../safe-json";
import {
  standardOutputSchemaJson,
  standardOutputSchemaNameFromPath,
} from "../../standard-output-schemas";
import type { JsonSchemaValidationResult } from "../contracts";
import {
  FileSystemService,
  FileSystemServiceLive,
  runFileSystemSync,
} from "../services/file-system-service";

const LINE_RE = /\r?\n/;
const MARKDOWN_JSON_FENCE_RE =
  /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i;
const jsonSchemaValidator = addFormats(
  new Ajv({ allErrors: true, strict: false })
);
const jsonSchemaValidatorCache = new Map<
  string,
  {
    source: string;
    validate: ReturnType<typeof jsonSchemaValidator.compile>;
  }
>();

export function parseRuntimeOutput(
  format: string,
  output: string
): { error?: string; output: unknown } {
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
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "failed to parse output",
      output,
    };
  }
}

export function validateJsonSchemaSource(
  source: string,
  schemaPath: string,
  worktreePath: string
): JsonSchemaValidationResult {
  return runFileSystemSync(
    validateJsonSchemaSourceEffect(source, schemaPath, worktreePath),
    FileSystemServiceLive
  );
}

function validateJsonSchemaSourceEffect(
  source: string,
  schemaPath: string,
  worktreePath: string
): Effect.Effect<JsonSchemaValidationResult, never, FileSystemService> {
  return Effect.catch(
    Effect.gen(function* () {
      const schemaSource = yield* readJsonSchemaSourceEffect(
        schemaPath,
        worktreePath
      );
      return yield* Effect.try({
        try: () => validateJsonSchemaValue(source, schemaPath, schemaSource),
        catch: (error) => error,
      });
    }),
    (error) => Effect.succeed(jsonSchemaValidationFailure(error))
  );
}

function validateJsonSchemaValue(
  source: string,
  schemaPath: string,
  schemaSource: string
): JsonSchemaValidationResult {
  const value = parseSafeJson(
    normalizeJsonSource(source),
    "JSON schema gate value"
  );
  const validate = compiledJsonSchemaValidator(schemaPath, schemaSource);
  const errors = validate(value)
    ? []
    : formatJsonSchemaErrors(validate.errors ?? []);
  return jsonSchemaValidationSuccess(schemaPath, errors);
}

function jsonSchemaValidationSuccess(
  schemaPath: string,
  errors: string[]
): JsonSchemaValidationResult {
  return {
    evidence: jsonSchemaValidationEvidence(schemaPath, errors),
    passed: errors.length === 0,
    reason: errors.length === 0 ? undefined : "JSON schema validation failed",
  };
}

function jsonSchemaValidationEvidence(
  schemaPath: string,
  errors: string[]
): string[] {
  return errors.length === 0
    ? [`JSON schema passed: ${schemaPath}`]
    : errors.map((error) => `schema: ${error}`);
}

export function normalizeJsonSource(source: string): string {
  const trimmed = source.trim();
  const fenced = MARKDOWN_JSON_FENCE_RE.exec(trimmed);
  return fenced?.[1].trim() ?? trimmed;
}

export function readJsonSchemaSource(
  schemaPath: string,
  worktreePath: string
): string {
  return runFileSystemSync(
    readJsonSchemaSourceEffect(schemaPath, worktreePath),
    FileSystemServiceLive
  );
}

function readJsonSchemaSourceEffect(
  schemaPath: string,
  worktreePath: string
): Effect.Effect<string, unknown, FileSystemService> {
  const standardName = standardOutputSchemaNameFromPath(schemaPath);
  if (standardName) {
    return Effect.succeed(standardOutputSchemaJson(standardName));
  }
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    return yield* fileSystem.readText(join(worktreePath, schemaPath));
  });
}

function compiledJsonSchemaValidator(
  schemaPath: string,
  schemaSource: string
): ReturnType<typeof jsonSchemaValidator.compile> {
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
}

function isJsonSchema(value: unknown): value is AnySchema {
  return typeof value === "boolean" || isRecord(value);
}

export function readOptionalFile(path: string): string | null {
  return runFileSystemSync(readOptionalFileEffect(path), FileSystemServiceLive);
}

function readOptionalFileEffect(
  path: string
): Effect.Effect<string | null, unknown, FileSystemService> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const exists = yield* fileSystem.exists(path);
    return exists ? yield* fileSystem.readText(path) : null;
  });
}

function jsonSchemaValidationFailure(
  error: unknown
): JsonSchemaValidationResult {
  return {
    evidence: [error instanceof Error ? error.message : String(error)],
    passed: false,
    reason: "JSON schema validation failed",
  };
}

function formatJsonSchemaErrors(errors: ErrorObject[]): string[] {
  return errors.map((error) => {
    const path = error.instancePath || "$";
    return `${path} ${error.message ?? "failed validation"}`.trim();
  });
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  return parseJsonRecord(value, "runtime JSON object");
}
