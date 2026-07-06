import secureJsonParse from "secure-json-parse";

import { isNumberValue, isStringValue, isUnknownRecord, stringRecordValue } from "./schema-boundary";

export const parseJson = (value: string, label = "JSON"): unknown => {
  try {
    const parsed: unknown = secureJsonParse(value);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label}: ${message}`, { cause: error });
  }
};

export const parseJsonResult = (value: string, label = "JSON"): { error?: string; value?: unknown } => {
  try {
    return { value: parseJson(value, label) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export const isRecord = (value: unknown): value is Record<string, unknown> => isUnknownRecord(value);

export { isNumberValue, isStringValue };

export const recordKeys = (value: Record<string, unknown>): string[] => Reflect.ownKeys(value).filter(isStringValue);

export const stringRecord = (value: unknown): Record<string, string> => stringRecordValue(value);

export const parseJsonRecord = (value: unknown, label = "JSON object"): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (!isStringValue(value)) {
    return {};
  }
  const parsed = parseJsonResult(value, label);
  return isRecord(parsed.value) ? parsed.value : {};
};
