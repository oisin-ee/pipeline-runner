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

const mergeClaudeUserConfigWith = (
  projection: ClaudeUserConfigProjection,
  project: (
    currentText: string,
    parsed: Record<string, unknown>,
    projection: ClaudeUserConfigProjection
  ) => string,
  currentText = ""
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
      project(currentText, parsed.value, projection)
    ),
    ok: true,
  };
};

export const mergeClaudeUserConfig = (
  projection: ClaudeUserConfigProjection,
  currentText = ""
): ClaudeUserConfigMergeResult =>
  mergeClaudeUserConfigWith(
    projection,
    (text, parsed, value) =>
      Object.entries(value.mcpServers ?? {}).reduce(
        (nextContent, [name, server]) =>
          setIfMissing(nextContent, parsed, ["mcpServers", name], server),
        text
      ),
    currentText
  );

export const replaceClaudeUserMcpServers = (
  projection: ClaudeUserConfigProjection,
  currentText = ""
): ClaudeUserConfigMergeResult =>
  mergeClaudeUserConfigWith(
    projection,
    (text, _parsed, value) =>
      applyJsonEdit(text, ["mcpServers"], value.mcpServers ?? {}),
    currentText
  );
