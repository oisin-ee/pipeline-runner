import type { ParseError } from "jsonc-parser";
import {
  applyJsonEdit,
  ensureTrailingNewline,
  formatJson,
  parseJsonRecord,
  setIfMissing,
} from "./json-config-merge";

export interface ClaudeUserConfigProjection {
  mcpServers?: Record<string, unknown>;
}

export type ClaudeUserConfigMergeResult =
  | { content: string; ok: true }
  | { errors: ParseError[]; ok: false };

export function mergeClaudeUserConfig(
  currentText: string | undefined,
  projection: ClaudeUserConfigProjection
): ClaudeUserConfigMergeResult {
  if (currentText === undefined) {
    return { content: formatJson(projection), ok: true };
  }

  const parsed = parseJsonRecord(currentText);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    content: ensureTrailingNewline(
      Object.entries(projection.mcpServers ?? {}).reduce(
        (nextContent, [name, server]) =>
          setIfMissing(nextContent, parsed.value, ["mcpServers", name], server),
        currentText
      )
    ),
    ok: true,
  };
}

export function replaceClaudeUserMcpServers(
  currentText: string | undefined,
  projection: ClaudeUserConfigProjection
): ClaudeUserConfigMergeResult {
  if (currentText === undefined) {
    return { content: formatJson(projection), ok: true };
  }

  const parsed = parseJsonRecord(currentText);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    content: ensureTrailingNewline(
      applyJsonEdit(currentText, ["mcpServers"], projection.mcpServers ?? {})
    ),
    ok: true,
  };
}
