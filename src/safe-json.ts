import secureJsonParse from "secure-json-parse";

export function parseJson(value: string, label = "JSON"): unknown {
  try {
    return secureJsonParse(value) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${label}: ${message}`);
  }
}

export function parseJsonResult(
  value: string,
  label = "JSON"
): { error?: string; value?: unknown } {
  try {
    return { value: parseJson(value, label) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseJsonRecord(
  value: unknown,
  label = "JSON object"
): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  const parsed = parseJsonResult(value, label);
  return isRecord(parsed.value) ? parsed.value : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
