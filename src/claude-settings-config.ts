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

// Merge the generated Claude settings projection into an existing
// `.claude/settings.json` without clobbering user-owned keys. Mirrors
// mergeOpenCodeProjectConfig: pipeline keys are injected when missing and the
// `permissions.allow` list is unioned, while every other user key is preserved.
export function mergeClaudeSettings(
  currentText: string | undefined,
  projection: ClaudeSettingsProjection
): ClaudeSettingsMergeResult {
  if (currentText === undefined) {
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
}

function applyClaudeProjection(
  currentText: string,
  parsed: Record<string, unknown>,
  projection: ClaudeSettingsProjection
): string {
  return applyPermissionsAllow(
    applyMcpServersProjection(currentText, parsed, projection),
    parsed,
    projection
  );
}

function applyMcpServersProjection(
  content: string,
  parsed: Record<string, unknown>,
  projection: ClaudeSettingsProjection
): string {
  return Object.entries(projection.mcpServers ?? {}).reduce(
    (nextContent, [name, server]) =>
      setIfMissing(nextContent, parsed, ["mcpServers", name], server),
    content
  );
}

function applyPermissionsAllow(
  content: string,
  parsed: Record<string, unknown>,
  projection: ClaudeSettingsProjection
): string {
  const existing = permissionAllowList(parsed);
  const merged = unionPreservingOrder(existing, projectedAllowList(projection));
  return sameOrderedList(existing, merged)
    ? content
    : applyJsonEdit(content, ["permissions", "allow"], merged);
}

function projectedAllowList(projection: ClaudeSettingsProjection): string[] {
  return projection.permissions?.allow ?? [];
}

function unionPreservingOrder(existing: string[], extra: string[]): string[] {
  const merged = [...existing];
  for (const entry of extra) {
    if (!merged.includes(entry)) {
      merged.push(entry);
    }
  }
  return merged;
}

function sameOrderedList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function permissionAllowList(parsed: Record<string, unknown>): string[] {
  const permissions = parsed.permissions;
  if (!isRecord(permissions)) {
    return [];
  }
  const allow = permissions.allow;
  return Array.isArray(allow)
    ? allow.filter((entry): entry is string => typeof entry === "string")
    : [];
}
