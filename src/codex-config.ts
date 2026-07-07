import * as Arr from "effect/Array";

import { ensureTrailingNewline } from "./json-config-merge";

const PIPELINE_GATEWAY_SECTION_HEADERS = [
  "[mcp_servers.pipeline-gateway]",
  "[mcp_servers.pipeline-gateway.env_http_headers]",
];

const CODEX_FEATURES_SECTION_HEADER = "[features]";
const CODEX_HOOKS_FEATURE = "hooks";

const removeTomlSection = (content: string, header: string): string => {
  const lines = content.split("\n");
  const kept: string[] = [];
  let removing = false;
  for (const line of lines) {
    if (line.trim() === header) {
      removing = true;
      continue;
    }
    if (removing && line.startsWith("[") && line.trimEnd().endsWith("]")) {
      removing = false;
    }
    if (!removing) {
      kept.push(line);
    }
  }
  return kept.join("\n");
};

const removePipelineGatewaySections = (content: string): string =>
  Arr.reduce(PIPELINE_GATEWAY_SECTION_HEADERS, content, (nextContent, header) =>
    removeTomlSection(nextContent, header)
  );

const isTomlSectionHeader = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]");
};

const nextTomlSectionIndex = (lines: string[], startIndex: number): number => {
  const nextIndex = lines.findIndex(
    (line, index) => index >= startIndex && isTomlSectionHeader(line)
  );
  return nextIndex === -1 ? lines.length : nextIndex;
};

const tomlKeyPattern = (key: string): RegExp =>
  new RegExp(`^\\s*${key}\\s*=`, "u");

const setTomlFeature = (
  content: string,
  key: string,
  value: string
): string => {
  const lines = content.split("\n");
  const sectionStart = lines.findIndex(
    (line) => line.trim() === CODEX_FEATURES_SECTION_HEADER
  );

  if (sectionStart === -1) {
    return [
      content.trimEnd(),
      CODEX_FEATURES_SECTION_HEADER,
      `${key} = ${value}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const sectionEnd = nextTomlSectionIndex(lines, sectionStart + 1);
  const beforeSection = lines.slice(0, sectionStart + 1);
  const featureLines = lines.slice(sectionStart + 1, sectionEnd);
  const afterSection = lines.slice(sectionEnd);
  const keyPattern = tomlKeyPattern(key);
  const firstKeyLineIndex = featureLines.findIndex((line) =>
    keyPattern.test(line)
  );
  const mergedFeatureLines = featureLines.flatMap((line, index) => {
    if (!keyPattern.test(line)) {
      return [line];
    }
    if (index !== firstKeyLineIndex) {
      return [];
    }
    return [`${key} = ${value}`];
  });

  if (firstKeyLineIndex === -1) {
    mergedFeatureLines.push(`${key} = ${value}`);
  }

  return [...beforeSection, ...mergedFeatureLines, ...afterSection].join("\n");
};

const enableCodexHooksFeature = (content: string): string =>
  setTomlFeature(content, CODEX_HOOKS_FEATURE, "true");

export const mergeCodexConfig = (
  currentText: string,
  projection: string
): string => {
  const currentWithHooks = enableCodexHooksFeature(
    removePipelineGatewaySections(currentText).trimEnd()
  );
  return ensureTrailingNewline(
    [currentWithHooks.trimEnd(), projection.trimEnd()]
      .filter(Boolean)
      .join("\n\n")
  );
};
