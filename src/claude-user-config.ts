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

export const mergeClaudeUserConfig = (
  currentText = "",
  projection: ClaudeUserConfigProjection
): ClaudeUserConfigMergeResult => {
  if (currentText === "") {
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
};

export const replaceClaudeUserMcpServers = (
  currentText = "",
  projection: ClaudeUserConfigProjection
): ClaudeUserConfigMergeResult => {
  if (currentText === "") {
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
};
