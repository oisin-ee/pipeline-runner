import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type AnySchema, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { parseJson as parseSafeJson } from "../../safe-json";
import {
  standardOutputSchemaJson,
  standardOutputSchemaNameFromPath,
} from "../../standard-output-schemas";
import type { JsonSchemaValidationResult } from "../contracts";

const LINE_RE = /\r?\n/;
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
    return { output: parseSafeJson(output, "runtime JSON output") };
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
  try {
    const schemaSource = readJsonSchemaSource(schemaPath, worktreePath);
    const value = parseSafeJson(source, "JSON schema gate value");
    const validate = compiledJsonSchemaValidator(schemaPath, schemaSource);
    const errors = validate(value)
      ? []
      : formatJsonSchemaErrors(validate.errors ?? []);
    return {
      evidence:
        errors.length === 0
          ? [`JSON schema passed: ${schemaPath}`]
          : errors.map((error) => `schema: ${error}`),
      passed: errors.length === 0,
      reason: errors.length === 0 ? undefined : "JSON schema validation failed",
    };
  } catch (err) {
    return {
      evidence: [err instanceof Error ? err.message : String(err)],
      passed: false,
      reason: "JSON schema validation failed",
    };
  }
}

export function readJsonSchemaSource(
  schemaPath: string,
  worktreePath: string
): string {
  const standardName = standardOutputSchemaNameFromPath(schemaPath);
  if (standardName) {
    return standardOutputSchemaJson(standardName);
  }
  return readFileSync(join(worktreePath, schemaPath), "utf8");
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
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8");
}

function formatJsonSchemaErrors(errors: ErrorObject[]): string[] {
  return errors.map((error) => {
    const path = error.instancePath || "$";
    return `${path} ${error.message ?? "failed validation"}`.trim();
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = parseSafeJson(value, "runtime JSON object");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
