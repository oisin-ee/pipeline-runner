import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type MokaNodeStatus,
  type MokaRunEvent,
  type MokaRunManifest,
  type MokaRunStatus,
  parseMokaNodeStatus,
  parseMokaRunEvent,
  parseMokaRunManifest,
  parseMokaRunStatus,
  parseRunEffort,
  parseRunMode,
  parseRunTarget,
  type RunEffort,
  type RunMode,
  type RunTarget,
} from "./contracts";

interface StoreContext {
  workspaceRoot: string;
}

export interface CreateRunInput extends StoreContext {
  effort: RunEffort;
  mode: RunMode;
  nodeIds: string[];
  runId: string;
  target: RunTarget;
}

export interface ReadRunInput extends StoreContext {
  runId: string;
}

export interface RecordEventInput extends StoreContext {
  event: MokaRunEvent;
  runId: string;
}

export interface UpdateRunStatusInput extends StoreContext {
  at: string;
  runId: string;
  status: MokaRunStatus;
}

export interface UpdateNodeStatusInput extends StoreContext {
  at: string;
  nodeId: string;
  runId: string;
  status: MokaNodeStatus;
}

export interface WriteNodeArtifactInput extends StoreContext {
  content: string;
  contentType?: string;
  name: string;
  nodeId: string;
  runId: string;
}

export interface NodeArtifactReference {
  path: string;
}

interface RunStatusFile {
  nodes: Record<string, MokaNodeStatus>;
  status: MokaRunStatus;
}

const RUNS_DIRECTORY = ".pipeline/runs";
const MANIFEST_FILE = "manifest.json";
const STATUS_FILE = "status.json";
const EVENTS_FILE = "events.jsonl";
const NODES_DIRECTORY = "nodes";

export async function createRun(
  input: CreateRunInput
): Promise<MokaRunManifest> {
  const runId = parseLogicalSegment("runId", input.runId);
  const nodeIds = input.nodeIds.map((nodeId) =>
    parseLogicalSegment("nodeId", nodeId)
  );
  const nodes = Object.fromEntries(
    nodeIds.map((nodeId) => [nodeId, "queued" as const])
  );
  const manifest: MokaRunManifest = parseMokaRunManifest({
    effort: parseRunEffort(input.effort),
    events: [],
    mode: parseRunMode(input.mode),
    nodes,
    runId,
    status: "queued",
    target: parseRunTarget(input.target),
  });
  const paths = runPaths(input.workspaceRoot, runId);

  await mkdir(paths.runsRoot, { recursive: true });
  await mkdir(paths.runRoot, { recursive: true });
  await mkdir(paths.nodesRoot, { recursive: true });

  await Promise.all(
    nodeIds.map((nodeId) =>
      mkdir(join(paths.nodesRoot, nodeId), { recursive: true })
    )
  );
  await Promise.all([
    writeJson(paths.manifest, manifest),
    writeJson(paths.status, statusFromManifest(manifest)),
    writeFile(paths.events, "", "utf8"),
  ]);

  return manifest;
}

export async function recordEvent(input: RecordEventInput): Promise<void> {
  const runId = parseLogicalSegment("runId", input.runId);
  const event = parseMokaRunEvent(input.event);
  const paths = runPaths(input.workspaceRoot, runId);

  await ensureRunExists(paths.manifest, runId);
  await appendFile(paths.events, `${JSON.stringify(event)}\n`, "utf8");
  const run = await readRun({ runId, workspaceRoot: input.workspaceRoot });

  if (!run) {
    throw new Error(`Run ${runId} does not exist.`);
  }

  await writeJson(paths.status, statusFromManifest(run));
}

export async function updateRunStatus(
  input: UpdateRunStatusInput
): Promise<void> {
  await recordEvent({
    event: {
      at: input.at,
      status: parseMokaRunStatus(input.status),
      type: "run.status",
    },
    runId: input.runId,
    workspaceRoot: input.workspaceRoot,
  });
}

export async function updateNodeStatus(
  input: UpdateNodeStatusInput
): Promise<void> {
  await recordEvent({
    event: {
      at: input.at,
      nodeId: parseLogicalSegment("nodeId", input.nodeId),
      status: parseMokaNodeStatus(input.status),
      type: "node.status",
    },
    runId: input.runId,
    workspaceRoot: input.workspaceRoot,
  });
}

export async function writeNodeArtifact(
  input: WriteNodeArtifactInput
): Promise<NodeArtifactReference> {
  const runId = parseLogicalSegment("runId", input.runId);
  const nodeId = parseLogicalSegment("nodeId", input.nodeId);
  const name = parseLogicalSegment("artifact name", input.name);
  const paths = runPaths(input.workspaceRoot, runId);
  const nodeRoot = join(paths.nodesRoot, nodeId);

  await ensureRunExists(paths.manifest, runId);
  await mkdir(nodeRoot, { recursive: true });
  const artifactPath = join(nodeRoot, name);
  await writeFile(artifactPath, input.content, "utf8");

  return {
    path: normalizeWorkspaceRelative(input.workspaceRoot, artifactPath),
  };
}

export async function readRun(
  input: ReadRunInput
): Promise<MokaRunManifest | undefined> {
  const runId = parseLogicalSegment("runId", input.runId);
  const paths = runPaths(input.workspaceRoot, runId);
  const manifestJson = await readOptionalFile(paths.manifest);

  if (manifestJson === undefined) {
    return;
  }

  const manifest = parseMokaRunManifest(JSON.parse(manifestJson));
  const events = await readEvents(paths.events);

  return replayEvents(manifest, events);
}

export async function listRuns(
  input: StoreContext
): Promise<MokaRunManifest[]> {
  const runsRoot = join(input.workspaceRoot, RUNS_DIRECTORY);
  const entries = await readRunDirectoryEntries(runsRoot);
  const runs = await Promise.all(
    entries.map((entry) =>
      readRun({ runId: entry.name, workspaceRoot: input.workspaceRoot })
    )
  );

  return runs.filter((run): run is MokaRunManifest => run !== undefined);
}

function runPaths(workspaceRoot: string, runId: string) {
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

function replayEvents(
  manifest: MokaRunManifest,
  events: MokaRunEvent[]
): MokaRunManifest {
  const rebuilt: MokaRunManifest = {
    ...manifest,
    events,
    nodes: { ...manifest.nodes },
  };

  for (const event of events) {
    if (event.type === "run.status") {
      rebuilt.status = event.status;
      continue;
    }

    rebuilt.nodes[event.nodeId] = event.status;
  }

  return parseMokaRunManifest(rebuilt);
}

async function readEvents(eventsPath: string): Promise<MokaRunEvent[]> {
  const eventLog = await readOptionalFile(eventsPath);

  if (eventLog === undefined) {
    return [];
  }

  return eventLog
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseMokaRunEvent(JSON.parse(line)));
}

async function readRunDirectoryEntries(runsRoot: string) {
  try {
    const entries = await readdir(runsRoot, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }

    throw error;
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }

    throw error;
  }
}

async function ensureRunExists(
  manifestPath: string,
  runId: string
): Promise<void> {
  try {
    await stat(manifestPath);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`Run ${runId} does not exist.`);
    }

    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function statusFromManifest(manifest: MokaRunManifest): RunStatusFile {
  return {
    nodes: manifest.nodes,
    status: manifest.status,
  };
}

function parseLogicalSegment(label: string, value: string): string {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${label} must be a non-empty logical identifier.`);
  }

  return value;
}

function normalizeWorkspaceRelative(
  workspaceRoot: string,
  path: string
): string {
  return relative(workspaceRoot, path).split(sep).join("/");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
