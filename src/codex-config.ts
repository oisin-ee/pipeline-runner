import { ensureTrailingNewline } from "./json-config-merge";

const PIPELINE_GATEWAY_SECTION_HEADERS = [
  "[mcp_servers.pipeline-gateway]",
  "[mcp_servers.pipeline-gateway.env_http_headers]",
];

const CODEX_FEATURES_SECTION_HEADER = "[features]";
const CODEX_HOOKS_FEATURE = "hooks";

export function mergeCodexConfig(
  currentText: string | undefined,
  projection: string
): string {
  const current = currentText ?? "";
  const currentWithHooks = enableCodexHooksFeature(
    removePipelineGatewaySections(current).trimEnd()
  );
  return ensureTrailingNewline(
    [currentWithHooks.trimEnd(), projection.trimEnd()]
      .filter(Boolean)
      .join("\n\n")
  );
}

function removePipelineGatewaySections(content: string): string {
  return PIPELINE_GATEWAY_SECTION_HEADERS.reduce(
    (nextContent, header) => removeTomlSection(nextContent, header),
    content
  );
}

function removeTomlSection(content: string, header: string): string {
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
}

function enableCodexHooksFeature(content: string): string {
  return setTomlFeature(content, CODEX_HOOKS_FEATURE, "true");
}

function setTomlFeature(content: string, key: string, value: string): string {
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
  let replaced = false;
  const mergedFeatureLines = featureLines.flatMap((line) => {
    if (!tomlKeyPattern(key).test(line)) {
      return [line];
    }
    if (replaced) {
      return [];
    }
    replaced = true;
    return [`${key} = ${value}`];
  });

  if (!replaced) {
    mergedFeatureLines.push(`${key} = ${value}`);
  }

  return [...beforeSection, ...mergedFeatureLines, ...afterSection].join("\n");
}

function nextTomlSectionIndex(lines: string[], startIndex: number): number {
  const nextIndex = lines.findIndex(
    (line, index) => index >= startIndex && isTomlSectionHeader(line)
  );
  return nextIndex === -1 ? lines.length : nextIndex;
}

function isTomlSectionHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function tomlKeyPattern(key: string): RegExp {
  return new RegExp(`^\\s*${key}\\s*=`);
}
