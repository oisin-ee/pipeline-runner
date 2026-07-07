import * as Arr from "effect/Array";
import type { ParseError } from "jsonc-parser";

import {
  applyJsonEdit,
  ensureTrailingNewline,
  formatJson,
  isRecord,
  parseJsonRecord,
  setIfMissing,
} from "./json-config-merge";

export interface ClaudeSettingsProjection {
  mcpServers?: Record<string, unknown>;
  permissions?: { allow?: string[] };
}

export type ClaudeSettingsMergeResult =
  | { content: string; ok: true }
  | { errors: ParseError[]; ok: false };

const applyMcpServersProjection = (
  content: string,
  parsed: Record<string, unknown>,
  projection: ClaudeSettingsProjection
): string =>
  Arr.reduce(
    Object.entries(projection.mcpServers ?? {}),
    content,
    (nextContent, [name, server]) =>
      setIfMissing(nextContent, parsed, ["mcpServers", name], server)
  );

const projectedAllowList = (projection: ClaudeSettingsProjection): string[] =>
  projection.permissions?.allow ?? [];

const unionPreservingOrder = (
  existing: string[],
  extra: string[]
): string[] => {
  const merged = [...existing];
  for (const entry of extra) {
    if (!merged.includes(entry)) {
      merged.push(entry);
    }
  }
  return merged;
};

const sameOrderedList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const permissionAllowList = (parsed: Record<string, unknown>): string[] => {
  const { permissions } = parsed;
  if (!isRecord(permissions)) {
    return [];
  }
  const { allow } = permissions;
  return Array.isArray(allow)
    ? allow.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const applyPermissionsAllow = (
  content: string,
  parsed: Record<string, unknown>,
  projection: ClaudeSettingsProjection
): string => {
  const existing = permissionAllowList(parsed);
  const merged = unionPreservingOrder(existing, projectedAllowList(projection));
  return sameOrderedList(existing, merged)
    ? content
    : applyJsonEdit(content, ["permissions", "allow"], merged);
};

const applyClaudeProjection = (
  currentText: string,
  parsed: Record<string, unknown>,
  projection: ClaudeSettingsProjection
): string =>
  applyPermissionsAllow(
    applyMcpServersProjection(currentText, parsed, projection),
    parsed,
    projection
  );

// Merge the generated Claude settings projection into an existing
// `.claude/settings.json` without clobbering user-owned keys. Mirrors
// mergeOpenCodeProjectConfig: pipeline keys are injected when missing and the
// `permissions.allow` list is unioned, while every other user key is preserved.
export const mergeClaudeSettings = (
  currentText: string,
  projection: ClaudeSettingsProjection
): ClaudeSettingsMergeResult => {
  if (currentText === "") {
    return { content: formatJson(projection), ok: true };
  }

  const parsed = parseJsonRecord(currentText);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    content: ensureTrailingNewline(
      applyClaudeProjection(currentText, parsed.value, projection)
    ),
    ok: true,
  };
};
