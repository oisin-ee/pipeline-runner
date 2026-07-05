import secureJsonParse from "secure-json-parse";

export const parseJson = (value: string, label = "JSON"): unknown => {
  try {
    return secureJsonParse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label}: ${message}`, { cause: error });
  }
};

export const parseJsonResult = (
  value: string,
  label = "JSON"
): { error?: string; value?: unknown } => {
  try {
    return { value: parseJson(value, label) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseJsonRecord = (
  value: unknown,
  label = "JSON object"
): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  const parsed = parseJsonResult(value, label);
  return isRecord(parsed.value) ? parsed.value : {};
};
