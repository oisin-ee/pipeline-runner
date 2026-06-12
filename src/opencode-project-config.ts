import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";

export interface OpenCodeProjectConfigProjection {
  $schema?: string;
  lsp?: unknown;
  mcp?: Record<string, unknown>;
  plugin?: unknown[];
  provider?: Record<string, OpenCodeProviderProjection>;
}

export interface OpenCodeProviderProjection {
  models?: Record<string, unknown>;
}

export type OpenCodeProjectConfigMergeResult =
  | { content: string; ok: true }
  | { errors: ParseError[]; ok: false };

const JSON_FORMAT_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
};

export function mergeOpenCodeProjectConfig(
  currentText: string | undefined,
  projection: OpenCodeProjectConfigProjection
): OpenCodeProjectConfigMergeResult {
  if (currentText === undefined) {
    return { content: formatJson(projection), ok: true };
  }

  const parsed = parseOpenCodeProjectConfig(currentText);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    content: ensureTrailingNewline(
      applyOpenCodeProjection(currentText, parsed.value, projection)
    ),
    ok: true,
  };
}

function parseOpenCodeProjectConfig(
  currentText: string
):
  | { ok: true; value: Record<string, unknown> }
  | { errors: ParseError[]; ok: false } {
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

function applyOpenCodeProjection(
  currentText: string,
  parsed: Record<string, unknown>,
  projection: OpenCodeProjectConfigProjection
): string {
  return applyProviderProjection(
    applyPluginProjection(
      applyMcpProjection(
        setIfMissing(
          setIfMissing(currentText, parsed, ["$schema"], projection.$schema),
          parsed,
          ["lsp"],
          projection.lsp
        ),
        parsed,
        projection
      ),
      parsed,
      projection
    ),
    parsed,
    projection
  );
}

function applyProviderProjection(
  content: string,
  parsed: Record<string, unknown>,
  projection: OpenCodeProjectConfigProjection
): string {
  return Object.entries(projection.provider ?? {}).reduce(
    (providerContent, [providerId, provider]) =>
      Object.entries(provider.models ?? {}).reduce(
        (modelContent, [modelId, model]) =>
          setIfMissing(
            modelContent,
            parsed,
            ["provider", providerId, "models", modelId],
            model
          ),
        providerContent
      ),
    content
  );
}

function applyMcpProjection(
  content: string,
  parsed: Record<string, unknown>,
  projection: OpenCodeProjectConfigProjection
): string {
  return Object.entries(projection.mcp ?? {}).reduce(
    (nextContent, [name, server]) =>
      setIfMissing(nextContent, parsed, ["mcp", name], server),
    content
  );
}

function applyPluginProjection(
  content: string,
  parsed: Record<string, unknown>,
  projection: OpenCodeProjectConfigProjection
): string {
  const plugins = mergePluginEntries(parsed.plugin, projection.plugin ?? []);
  return plugins.length > 0
    ? applyJsonEdit(content, ["plugin"], plugins)
    : content;
}

function setIfMissing(
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

function mergePluginEntries(
  existing: unknown,
  projected: unknown[]
): unknown[] {
  const projectedByKey = new Map(
    projected.map((plugin) => [pluginKey(plugin), plugin])
  );
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const plugin of Array.isArray(existing) ? existing : []) {
    const key = pluginKey(plugin);
    merged.push(projectedByKey.get(key) ?? plugin);
    seen.add(key);
  }
  for (const plugin of projected) {
    const key = pluginKey(plugin);
    if (seen.has(key)) {
      continue;
    }
    merged.push(plugin);
    seen.add(key);
  }
  return merged;
}

function pluginKey(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string"
      ? pluginName(value[0])
      : JSON.stringify(value);
  }
  return typeof value === "string" ? pluginName(value) : JSON.stringify(value);
}

function pluginName(specifier: string): string {
  const versionSeparator = specifier.indexOf("@", 1);
  return versionSeparator === -1
    ? specifier
    : specifier.slice(0, versionSeparator);
}

function applyJsonEdit(
  content: string,
  path: (number | string)[],
  value: unknown
): string {
  const edits = modify(content, path, value, {
    formattingOptions: JSON_FORMAT_OPTIONS,
  });
  return applyEdits(content, edits);
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
