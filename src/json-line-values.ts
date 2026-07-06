import type { Option } from "effect/Option";
import { isOption, isSome, none, some } from "effect/Option";

import { parseJson } from "./safe-json";

const LINE_RE = /\r?\n/u;

type JsonLineExtractor = (value: unknown) => unknown;

const extractedStringOption = (value: unknown): Option<string> => {
  if (isOption(value)) {
    if (isSome(value)) {
      return extractedStringOption(value.value);
    }
    return none();
  }
  if (value === undefined) {
    return none();
  }
  if (typeof value !== "string") {
    throw new TypeError("jsonLineValues extractor must return string, undefined, or Option<string>");
  }
  if (value.length === 0) {
    return none();
  }
  return some(value);
};

export const jsonLineValues = (text: string, extract: JsonLineExtractor): string[] => {
  const values: string[] = [];
  for (const line of text.split(LINE_RE)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const extracted = extractedStringOption(extract(parseJson(trimmed, "runner JSON event")));
      if (isSome(extracted)) {
        values.push(extracted.value);
      }
    } catch {
      // Non-JSON lines are valid for non-event runner output.
    }
  }
  return values;
};
