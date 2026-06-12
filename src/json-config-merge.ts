import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";

// Shared helpers for merging a generated JSON projection into an existing
// user-owned config file (`.opencode/opencode.json`, `.claude/settings.json`)
// without clobbering keys the user already set. Edits are applied via
// jsonc-parser so existing formatting and comments survive.

const JSON_FORMAT_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
};

export type JsonRecordParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { errors: ParseError[]; ok: false };

export function parseJsonRecord(currentText: string): JsonRecordParseResult {
  const errors: ParseError[] = [];
  const value = parse(currentText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isRecord(value)) {
    return { errors, ok: false };
  }
  return { ok: true, value };
}

export function setIfMissing(
  content: string,
  parsed: Record<string, unknown>,
  path: (number | string)[],
  value: unknown
): string {
  if (value === undefined || hasPath(parsed, path)) {
    return content;
  }
  return applyJsonEdit(content, path, value);
}

function hasPath(value: unknown, path: (number | string)[]): boolean {
  let cursor = value;
  for (const segment of path) {
    if (!(isRecord(cursor) && segment in cursor)) {
      return false;
    }
    cursor = cursor[segment];
  }
  return true;
}

export function applyJsonEdit(
  content: string,
  path: (number | string)[],
  value: unknown
): string {
  const edits = modify(content, path, value, {
    formattingOptions: JSON_FORMAT_OPTIONS,
  });
  return applyEdits(content, edits);
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
