import { parseJson } from "./safe-json";

const LINE_RE = /\r?\n/;

export function jsonLineValues(
  text: string,
  extract: (value: unknown) => string | undefined
): string[] {
  const values: string[] = [];
  for (const line of text.split(LINE_RE)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const extracted = extract(parseJson(trimmed, "runner JSON event"));
      if (extracted) {
        values.push(extracted);
      }
    } catch {
      // Non-JSON lines are valid for non-event runner output.
    }
  }
  return values;
}
