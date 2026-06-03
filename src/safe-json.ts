import secureJsonParse from "secure-json-parse";

export function parseJson(value: string, label = "JSON"): unknown {
  try {
    return secureJsonParse(value) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${label}: ${message}`);
  }
}

export function parseJsonObject(
  value: string,
  label = "JSON"
): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (isRecord(parsed)) {
    return parsed;
  }
  throw new Error(`Failed to parse ${label}: expected object`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
