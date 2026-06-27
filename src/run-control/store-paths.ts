import { join, relative, sep } from "node:path";
import { Effect } from "effect";
import { parseLogicalSegment } from "./logical-segment";
import type { ReadRunInput, RunControlStatusPaths } from "./store-types";

export const RUNS_DIRECTORY = ".pipeline/runs";
const MANIFEST_FILE = "manifest.json";
const STATUS_FILE = "status.json";
const EVENTS_FILE = "events.jsonl";
const NODES_DIRECTORY = "nodes";

export function runControlStatusPaths(
  input: ReadRunInput
): RunControlStatusPaths {
  return runStatusPaths(parseLogicalSegment("runId", input.runId));
}

export function runPaths(workspaceRoot: string, runId: string) {
  const runsRoot = join(workspaceRoot, RUNS_DIRECTORY);
  const runRoot = join(runsRoot, runId);

  return {
    events: join(runRoot, EVENTS_FILE),
    manifest: join(runRoot, MANIFEST_FILE),
    nodesRoot: join(runRoot, NODES_DIRECTORY),
    runRoot,
    runsRoot,
    status: join(runRoot, STATUS_FILE),
  };
}

export function nonEmptyStringEffect(
  label: string,
  value: string
): Effect.Effect<string, unknown> {
  return Effect.try({
    catch: (error) => error,
    try: () => parseNonEmptyString(label, value),
  });
}

export function normalizeWorkspaceRelative(
  workspaceRoot: string,
  path: string
): string {
  return relative(workspaceRoot, path).split(sep).join("/");
}

function runStatusPaths(runId: string): RunControlStatusPaths {
  const runRoot = `${RUNS_DIRECTORY}/${runId}`;
  return {
    events: `${runRoot}/${EVENTS_FILE}`,
    manifest: `${runRoot}/${MANIFEST_FILE}`,
    status: `${runRoot}/${STATUS_FILE}`,
  };
}

function parseNonEmptyString(label: string, value: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}
