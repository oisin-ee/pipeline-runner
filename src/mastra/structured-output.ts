import { createRequire } from "node:module";
import { JSONPath } from "jsonpath-plus";
import type { z } from "zod";

const LINE_RE = /\r?\n/;
type JsonPathInput = string | number | boolean | object | unknown[] | null;
const require = createRequire(import.meta.url);
const extractJson = require("extract-json-from-string") as (
  value: string
) => unknown[];

export function jsonRecords(output: string): unknown[] {
  try {
    return [JSON.parse(output)];
  } catch {
    return output
      .split(LINE_RE)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
}

export function evidenceItems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .filter((item): item is string => Boolean(item?.trim()));
  }
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }
  if (value && typeof value === "object") {
    return [JSON.stringify(value)];
  }
  return [];
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringValues(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => stringValues(item));
  }
  return [];
}

function extractedJsonValues(records: unknown[]): unknown[] {
  return records.flatMap((record) =>
    stringValues(record).flatMap((value) => {
      try {
        return extractJson(value);
      } catch {
        return [];
      }
    })
  );
}

export function findLastStructuredOutput<T>(
  output: string,
  schema: z.ZodType<T>,
  path: string
): T | null {
  const records = jsonRecords(output);
  const recordsAndExtracted = [...records, ...extractedJsonValues(records)];
  const candidates = recordsAndExtracted.flatMap((record) => {
    const matches = JSONPath({
      json: record as JsonPathInput,
      path,
      resultType: "value",
    }) as unknown[];
    return [record, ...matches];
  });
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = schema.safeParse(candidates[i]);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return null;
}
