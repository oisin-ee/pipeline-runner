import { Effect } from "effect";

const LOGICAL_SEGMENT_PATTERN = /^(?!\.{1,2}$)(?!.*[\\/]).+$/u;

export const parseLogicalSegment = (label: string, value: string): string => {
  if (!LOGICAL_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${label} must be a non-empty logical identifier.`);
  }

  return value;
};

export const logicalSegmentEffect = (label: string, value: string): Effect.Effect<string, unknown> =>
  Effect.try({
    catch: (error) => error,
    try: () => parseLogicalSegment(label, value),
  });
