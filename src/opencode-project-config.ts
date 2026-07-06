import type { ParseError } from "jsonc-parser";

import { applyJsonEdit, ensureTrailingNewline, formatJson, parseJsonRecord, setIfMissing } from "./json-config-merge";

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

export type OpenCodeProjectConfigMergeResult = { content: string; ok: true } | { errors: ParseError[]; ok: false };

const applyProviderProjection = (
  content: string,
  parsed: Record<string, unknown>,
  projection: OpenCodeProjectConfigProjection,
): string =>
  Object.entries(projection.provider ?? {}).reduce(
    (providerContent, [providerId, provider]) =>
      Object.entries(provider.models ?? {}).reduce(
        (modelContent, [modelId, model]) =>
          setIfMissing(modelContent, parsed, ["provider", providerId, "models", modelId], model),
        providerContent,
      ),
    content,
  );

const applyMcpProjection = (
  content: string,
  parsed: Record<string, unknown>,
  projection: OpenCodeProjectConfigProjection,
): string =>
  Object.entries(projection.mcp ?? {}).reduce(
    (nextContent, [name, server]) => setIfMissing(nextContent, parsed, ["mcp", name], server),
    content,
  );

const pluginName = (specifier: string): string => {
  const versionSeparator = specifier.indexOf("@", 1);
  return versionSeparator === -1 ? specifier : specifier.slice(0, versionSeparator);
};

const pluginKey = (value: unknown): string => {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? pluginName(value[0]) : JSON.stringify(value);
  }
  return typeof value === "string" ? pluginName(value) : JSON.stringify(value);
};

const mergePluginEntries = (existing: unknown, projected: unknown[]): unknown[] => {
  const projectedByKey = new Map(projected.map((plugin) => [pluginKey(plugin), plugin]));
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
};

const applyPluginProjection = (
  content: string,
  parsed: Record<string, unknown>,
  projection: OpenCodeProjectConfigProjection,
): string => {
  const plugins = mergePluginEntries(parsed.plugin, projection.plugin ?? []);
  return plugins.length > 0 ? applyJsonEdit(content, ["plugin"], plugins) : content;
};

const applyOpenCodeProjection = (
  currentText: string,
  parsed: Record<string, unknown>,
  projection: OpenCodeProjectConfigProjection,
): string =>
  applyProviderProjection(
    applyPluginProjection(
      applyMcpProjection(
        setIfMissing(
          setIfMissing(currentText, parsed, ["$schema"], projection.$schema),
          parsed,
          ["lsp"],
          projection.lsp,
        ),
        parsed,
        projection,
      ),
      parsed,
      projection,
    ),
    parsed,
    projection,
  );

export const mergeOpenCodeProjectConfig = (
  currentText = "",
  projection: OpenCodeProjectConfigProjection,
): OpenCodeProjectConfigMergeResult => {
  if (currentText === "") {
    return { content: formatJson(projection), ok: true };
  }

  const parsed = parseJsonRecord(currentText);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    content: ensureTrailingNewline(applyOpenCodeProjection(currentText, parsed.value, projection)),
    ok: true,
  };
};
