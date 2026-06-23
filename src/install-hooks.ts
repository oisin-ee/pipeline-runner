import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { execa } from "execa";
import { AGENT_ASSET_SOURCE, AGENT_HOOKS_DIR } from "./agent-assets";
import { resolveHarnessTarget } from "./install-commands/shared";
import {
  applyJsonEdit,
  ensureTrailingNewline,
  parseJsonRecord,
} from "./json-config-merge";

const DEFAULT_HOOK_INSTALL_SOURCE = AGENT_ASSET_SOURCE;

const HOOK_HOSTS = ["claude-code", "codex", "opencode"] as const;
const MANIFEST_FILE = ".moka-agent-hooks.json";

type HookHost = (typeof HOOK_HOSTS)[number];

const HOST_TARGET_ROOT: Record<HookHost, string> = {
  "claude-code": ".claude",
  codex: ".codex",
  opencode: ".opencode",
};

const NON_HOOK_OWNED_TARGETS = new Set([".opencode/opencode.json"]);

export type HookInstallAction =
  | "conflict"
  | "create"
  | "delete"
  | "unchanged"
  | "update";

export interface HookInstallPlanItem {
  action: HookInstallAction;
  host: HookHost;
  path: string;
}

export interface InstallHooksOptions {
  check?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export interface InstallHooksResult {
  items: HookInstallPlanItem[];
  source: typeof DEFAULT_HOOK_INSTALL_SOURCE;
}

interface SourceHookFile {
  content: Buffer;
  hash: string;
  host: HookHost;
  path: string;
}

interface ManifestEntry {
  hash: string;
}

interface HookManifest {
  files: Record<string, ManifestEntry>;
  repository: typeof DEFAULT_HOOK_INSTALL_SOURCE;
  version: 1;
}

interface PlannedHookFile extends SourceHookFile {
  action: HookInstallAction;
}

interface PlannedObsoleteHookFile {
  action: Extract<HookInstallAction, "conflict" | "delete">;
  host: HookHost;
  path: string;
}

function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// Host config files that hold more than hooks (Claude's settings.json also carries
// mcpServers, permissions, theme, …). For these we MERGE our managed key into the
// existing file instead of overwriting the whole file, and base drift detection on
// that key's subtree rather than the full bytes — so installing hooks never clobbers
// the user's other settings. Codex's hooks.json and the opencode plugins are
// dedicated hook files, so they stay raw whole-file copies.
const MERGE_MANAGED: Record<string, string[]> = {
  ".claude/settings.json": ["hooks"],
};

function mergeKeyFor(path: string): string[] | undefined {
  return MERGE_MANAGED[path];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

// Order-insensitive (for object keys) hash of a JSON subtree, so an unchanged set of
// hooks hashes the same regardless of key ordering in the file.
function hashJson(value: unknown): string {
  return hashContent(Buffer.from(JSON.stringify(canonicalize(value) ?? null)));
}

function managedSubtree(text: string, keyPath: string[]): unknown {
  const parsed = parseJsonRecord(text);
  if (!parsed.ok) {
    return;
  }
  let cursor: unknown = parsed.value;
  for (const key of keyPath) {
    if (!isRecord(cursor)) {
      return;
    }
    cursor = cursor[key];
  }
  return cursor;
}

// The identity of an installed target: the managed subtree for merge-managed files,
// the full file bytes otherwise. Drift/unchanged/conflict all compare this.
function targetIdentityHash(path: string, content: Buffer): string {
  const mergeKey = mergeKeyFor(path);
  return mergeKey
    ? hashJson(managedSubtree(content.toString("utf8"), mergeKey))
    : hashContent(content);
}

async function cloneHookRepository(targetDir: string): Promise<void> {
  await execa(
    "gh",
    [
      "repo",
      "clone",
      DEFAULT_HOOK_INSTALL_SOURCE,
      targetDir,
      "--",
      "--depth=1",
    ],
    { stdio: "inherit" }
  );
}

async function withHookSource<T>(
  useSource: (source: string) => Promise<T>
): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "moka-agent-"));
  const source = join(parent, "agent");
  try {
    await cloneHookRepository(source);
    return await useSource(source);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}

async function listFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }
  if (statSync(root).isFile()) {
    return [root];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
  );
  return nested.flat();
}

async function sourceHookFiles(source: string): Promise<SourceHookFile[]> {
  const byHost = await Promise.all(
    HOOK_HOSTS.map(async (host) => {
      const hostRoot = join(source, AGENT_HOOKS_DIR, host);
      const files = await listFiles(hostRoot);
      return files.flatMap((file): SourceHookFile[] => {
        const relativePath = relative(hostRoot, file).replaceAll("\\", "/");
        const content = readFileSync(file);
        const path = `${HOST_TARGET_ROOT[host]}/${relativePath}`;
        return isHookOwnedTarget(path)
          ? [
              {
                content,
                hash: targetIdentityHash(path, content),
                host,
                path,
              },
            ]
          : [];
      });
    })
  );
  return byHost.flat().sort((a, b) => a.path.localeCompare(b.path));
}

function manifestPath(host: HookHost): string {
  return resolveHarnessTarget(`${HOST_TARGET_ROOT[host]}/${MANIFEST_FILE}`);
}

function emptyManifest(): HookManifest {
  return { files: {}, repository: DEFAULT_HOOK_INSTALL_SOURCE, version: 1 };
}

function isHookOwnedTarget(path: string): boolean {
  return !NON_HOOK_OWNED_TARGETS.has(path);
}

function readManifest(host: HookHost): HookManifest {
  const path = manifestPath(host);
  if (!existsSync(path)) {
    return emptyManifest();
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return normalizeManifest(parsed);
  } catch {
    return emptyManifest();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeManifest(value: unknown): HookManifest {
  const files: Record<string, ManifestEntry> = {};
  const manifestFiles = isRecord(value) ? value.files : undefined;
  if (!isRecord(manifestFiles)) {
    return emptyManifest();
  }
  for (const [path, entry] of Object.entries(manifestFiles)) {
    if (isRecord(entry) && typeof entry.hash === "string") {
      files[path] = { hash: entry.hash };
    }
  }
  return { files, repository: DEFAULT_HOOK_INSTALL_SOURCE, version: 1 };
}

function targetPath(path: string): string {
  return resolveHarnessTarget(path);
}

function actionForFile(
  file: SourceHookFile,
  force: boolean,
  manifests: Map<HookHost, HookManifest>
): HookInstallAction {
  const target = targetPath(file.path);
  if (!existsSync(target)) {
    return "create";
  }
  const currentHash = targetIdentityHash(file.path, readFileSync(target));
  if (currentHash === file.hash) {
    return "unchanged";
  }
  if (force) {
    return "update";
  }
  const previous = manifests.get(file.host)?.files[file.path];
  return previous?.hash === currentHash ? "update" : "conflict";
}

function planFiles(
  files: SourceHookFile[],
  force: boolean,
  manifests: Map<HookHost, HookManifest>
): PlannedHookFile[] {
  return files.map((file) => ({
    ...file,
    action: actionForFile(file, force, manifests),
  }));
}

function planObsoleteFiles(
  desiredPaths: Set<string>,
  force: boolean,
  manifests: Map<HookHost, HookManifest>
): PlannedObsoleteHookFile[] {
  const obsolete: PlannedObsoleteHookFile[] = [];
  for (const [host, manifest] of manifests) {
    for (const [path, entry] of Object.entries(manifest.files)) {
      const planned = planObsoleteFile(host, path, entry, force, desiredPaths);
      if (planned) {
        obsolete.push(planned);
      }
    }
  }
  return obsolete.sort((a, b) => a.path.localeCompare(b.path));
}

function planObsoleteFile(
  host: HookHost,
  path: string,
  entry: ManifestEntry,
  force: boolean,
  desiredPaths: Set<string>
): PlannedObsoleteHookFile | undefined {
  if (desiredPaths.has(path) || !isHookOwnedTarget(path)) {
    return;
  }
  const target = targetPath(path);
  if (!existsSync(target)) {
    return;
  }
  const currentHash = hashContent(readFileSync(target));
  return {
    action: force || currentHash === entry.hash ? "delete" : "conflict",
    host,
    path,
  };
}

async function writePlannedFile(file: PlannedHookFile): Promise<void> {
  if (file.action === "conflict" || file.action === "unchanged") {
    return;
  }
  const target = targetPath(file.path);
  await mkdir(dirname(target), { recursive: true });
  const mergeKey = mergeKeyFor(file.path);
  if (mergeKey && existsSync(target)) {
    // Merge our managed key into the user's existing file, preserving every other
    // key (mcpServers, permissions, theme, …) and the file's formatting.
    const currentText = readFileSync(target, "utf8");
    const desired = managedSubtree(file.content.toString("utf8"), mergeKey);
    await writeFile(
      target,
      ensureTrailingNewline(applyJsonEdit(currentText, mergeKey, desired))
    );
    return;
  }
  await writeFile(target, file.content);
}

function itemFor(file: PlannedHookFile): HookInstallPlanItem {
  return { action: file.action, host: file.host, path: file.path };
}

function itemForObsolete(file: PlannedObsoleteHookFile): HookInstallPlanItem {
  return { action: file.action, host: file.host, path: file.path };
}

async function removeObsoleteFile(
  file: PlannedObsoleteHookFile
): Promise<void> {
  if (file.action !== "delete") {
    return;
  }
  await rm(targetPath(file.path), { force: true });
}

function assertNoConflicts(
  items: HookInstallPlanItem[],
  dryRun: boolean
): void {
  if (dryRun) {
    return;
  }
  const conflicts = items.filter((item) => item.action === "conflict");
  if (conflicts.length === 0) {
    return;
  }
  throw new Error(
    [
      "Refusing to overwrite manually edited hook files.",
      ...conflicts.map((item) => `- ${item.path}`),
      "Re-run with --force to overwrite them.",
    ].join("\n")
  );
}

function assertCheckCurrent(
  items: HookInstallPlanItem[],
  check: boolean
): void {
  if (!check) {
    return;
  }
  const changed = items.filter((item) => item.action !== "unchanged");
  if (changed.length === 0) {
    return;
  }
  throw new Error(
    [
      "Installed hook files are not up to date.",
      ...changed.map((item) => `- ${item.path}: ${item.action}`),
    ].join("\n")
  );
}

async function writeManifests(files: PlannedHookFile[]): Promise<void> {
  const byHost = new Map<HookHost, HookManifest>();
  for (const host of HOOK_HOSTS) {
    byHost.set(host, emptyManifest());
  }
  for (const file of files) {
    const manifest = byHost.get(file.host);
    if (manifest) {
      manifest.files[file.path] = { hash: file.hash };
    }
  }
  await Promise.all(
    [...byHost.entries()].map(async ([host, manifest]) => {
      const path = manifestPath(host);
      if (Object.keys(manifest.files).length === 0) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    })
  );
}

export function installHooks(
  options: InstallHooksOptions = {}
): Promise<InstallHooksResult> {
  return withHookSource(async (source) => {
    const files = await sourceHookFiles(source);
    const manifests = new Map(
      HOOK_HOSTS.map((host) => [host, readManifest(host)] as const)
    );
    const planned = planFiles(files, Boolean(options.force), manifests);
    const obsolete = planObsoleteFiles(
      new Set(files.map((file) => file.path)),
      Boolean(options.force),
      manifests
    );
    const items = [...planned.map(itemFor), ...obsolete.map(itemForObsolete)];
    assertCheckCurrent(items, Boolean(options.check));
    assertNoConflicts(items, Boolean(options.dryRun));
    if (!(options.check || options.dryRun)) {
      for (const file of planned) {
        await writePlannedFile(file);
      }
      for (const file of obsolete) {
        await removeObsoleteFile(file);
      }
      await writeManifests(planned);
    }
    return { items, source: DEFAULT_HOOK_INSTALL_SOURCE };
  });
}
