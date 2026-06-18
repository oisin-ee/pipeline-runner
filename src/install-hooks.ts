import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { execa } from "execa";
import {
  DEFAULT_HARNESS_SCOPE,
  type HarnessScope,
  resolveHarnessTarget,
} from "./install-commands/shared";

const DEFAULT_HOOK_INSTALL_SOURCE = "oisin-ee/agent-hooks";

const HOOK_HOSTS = ["claude-code", "codex", "opencode"] as const;
const MANIFEST_FILE = ".moka-agent-hooks.json";

type HookHost = (typeof HOOK_HOSTS)[number];

const HOST_TARGET_ROOT: Record<HookHost, string> = {
  "claude-code": ".claude",
  codex: ".codex",
  opencode: ".opencode",
};

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
  cwd?: string;
  dryRun?: boolean;
  force?: boolean;
  scope?: HarnessScope;
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
  const parent = await mkdtemp(join(tmpdir(), "moka-agent-hooks-"));
  const source = join(parent, "agent-hooks");
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
      const hostRoot = join(source, host);
      const files = await listFiles(hostRoot);
      return files.map((file): SourceHookFile => {
        const relativePath = relative(hostRoot, file).replaceAll("\\", "/");
        const content = readFileSync(file);
        return {
          content,
          hash: hashContent(content),
          host,
          path: `${HOST_TARGET_ROOT[host]}/${relativePath}`,
        };
      });
    })
  );
  return byHost.flat().sort((a, b) => a.path.localeCompare(b.path));
}

function manifestPath(
  scope: HarnessScope,
  cwd: string,
  host: HookHost
): string {
  return resolveHarnessTarget(
    scope,
    cwd,
    `${HOST_TARGET_ROOT[host]}/${MANIFEST_FILE}`
  );
}

function emptyManifest(): HookManifest {
  return { files: {}, repository: DEFAULT_HOOK_INSTALL_SOURCE, version: 1 };
}

function readManifest(
  scope: HarnessScope,
  cwd: string,
  host: HookHost
): HookManifest {
  const path = manifestPath(scope, cwd, host);
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
    return { files, repository: DEFAULT_HOOK_INSTALL_SOURCE, version: 1 };
  }
  for (const [path, entry] of Object.entries(manifestFiles)) {
    if (isRecord(entry) && typeof entry.hash === "string") {
      files[path] = { hash: entry.hash };
    }
  }
  return { files, repository: DEFAULT_HOOK_INSTALL_SOURCE, version: 1 };
}

function targetPath(scope: HarnessScope, cwd: string, path: string): string {
  return resolveHarnessTarget(scope, cwd, path);
}

function actionForFile(
  file: SourceHookFile,
  scope: HarnessScope,
  cwd: string,
  force: boolean,
  manifests: Map<HookHost, HookManifest>
): HookInstallAction {
  const target = targetPath(scope, cwd, file.path);
  if (!existsSync(target)) {
    return "create";
  }
  const currentHash = hashContent(readFileSync(target));
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
  scope: HarnessScope,
  cwd: string,
  force: boolean,
  manifests: Map<HookHost, HookManifest>
): PlannedHookFile[] {
  return files.map((file) => ({
    ...file,
    action: actionForFile(file, scope, cwd, force, manifests),
  }));
}

function planObsoleteFiles(
  desiredPaths: Set<string>,
  scope: HarnessScope,
  cwd: string,
  force: boolean,
  manifests: Map<HookHost, HookManifest>
): PlannedObsoleteHookFile[] {
  const obsolete: PlannedObsoleteHookFile[] = [];
  for (const [host, manifest] of manifests) {
    for (const [path, entry] of Object.entries(manifest.files)) {
      if (desiredPaths.has(path)) {
        continue;
      }
      const target = targetPath(scope, cwd, path);
      if (!existsSync(target)) {
        continue;
      }
      const currentHash = hashContent(readFileSync(target));
      obsolete.push({
        action: force || currentHash === entry.hash ? "delete" : "conflict",
        host,
        path,
      });
    }
  }
  return obsolete.sort((a, b) => a.path.localeCompare(b.path));
}

async function writePlannedFile(
  file: PlannedHookFile,
  scope: HarnessScope,
  cwd: string
): Promise<void> {
  if (file.action === "conflict" || file.action === "unchanged") {
    return;
  }
  const target = targetPath(scope, cwd, file.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.content);
}

function itemFor(file: PlannedHookFile): HookInstallPlanItem {
  return { action: file.action, host: file.host, path: file.path };
}

function itemForObsolete(file: PlannedObsoleteHookFile): HookInstallPlanItem {
  return { action: file.action, host: file.host, path: file.path };
}

async function removeObsoleteFile(
  file: PlannedObsoleteHookFile,
  scope: HarnessScope,
  cwd: string
): Promise<void> {
  if (file.action !== "delete") {
    return;
  }
  await rm(targetPath(scope, cwd, file.path), { force: true });
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

async function writeManifests(
  files: PlannedHookFile[],
  scope: HarnessScope,
  cwd: string
): Promise<void> {
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
      const path = manifestPath(scope, cwd, host);
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
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? DEFAULT_HARNESS_SCOPE;
  return withHookSource(async (source) => {
    const files = await sourceHookFiles(source);
    const manifests = new Map(
      HOOK_HOSTS.map((host) => [host, readManifest(scope, cwd, host)] as const)
    );
    const planned = planFiles(
      files,
      scope,
      cwd,
      Boolean(options.force),
      manifests
    );
    const obsolete = planObsoleteFiles(
      new Set(files.map((file) => file.path)),
      scope,
      cwd,
      Boolean(options.force),
      manifests
    );
    const items = [...planned.map(itemFor), ...obsolete.map(itemForObsolete)];
    assertCheckCurrent(items, Boolean(options.check));
    assertNoConflicts(items, Boolean(options.dryRun));
    if (!(options.check || options.dryRun)) {
      for (const file of planned) {
        await writePlannedFile(file, scope, cwd);
      }
      for (const file of obsolete) {
        await removeObsoleteFile(file, scope, cwd);
      }
      await writeManifests(planned, scope, cwd);
    }
    return { items, source: DEFAULT_HOOK_INSTALL_SOURCE };
  });
}

export function formatInstallHooksResult(result: InstallHooksResult): string {
  return result.items
    .map((item) => `${item.action} ${item.host}: ${item.path}`)
    .join("\n");
}
