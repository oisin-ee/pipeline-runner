import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FileSystem, layerNoop } from "effect/FileSystem";
import type { OpenFlag } from "effect/FileSystem";
import { mergeAll } from "effect/Layer";
import { Path, layer } from "effect/Path";
import type { PlatformError, SystemErrorTag } from "effect/PlatformError";
import { systemError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { Scope } from "effect/Scope";
import matter from "gray-matter";

import { parsePipelineConfigParts } from "../src/config.ts";
import { opencodeAdapter } from "../src/install-commands/opencode.ts";
import type { RunnerLaunchPlan } from "../src/runner";
import { createRunnerLaunchPlan } from "../src/runner";
import { runLaunchPlan } from "../src/runner/subprocess";
import { createProtectedPathGuard } from "../src/runtime/protected-paths/protected-paths.ts";
import { RepoIoServiceLive } from "../src/runtime/services/repo-io-service.ts";
import {
  isStringValue,
  isUnknownRecord,
  parseWithSchema,
  struct,
} from "../src/schema-boundary.ts";
import { loadBacklogTaskStoreEffect } from "../src/tickets/backlog-task-store.ts";

const VIOLATION_RE = /Protected-path violation/u;
const AC_FILE = "backlog/tasks/PIPE-1.md";
const TEST_FILE = "tests/foo.test.ts";
const PROTECTED: readonly string[] = ["backlog/tasks/**", "tests/**"];
const AC_CONTENT = [
  "---",
  "id: PIPE-1",
  "title: Sample",
  "status: To Do",
  "---",
  "## Acceptance Criteria",
  "<!-- AC:BEGIN -->",
  "- [ ] #1 The widget renders",
  "<!-- AC:END -->",
  "",
].join("\n");
const TEST_CONTENT = 'it("adjudicates", () => expect(1).toBe(1));\n';

const permissionEntry = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.String),
]);
const agentPermissionSchema = struct({
  permission: Schema.Record(Schema.String, permissionEntry),
});

type ProtectedFixturePath = typeof AC_FILE | typeof TEST_FILE;

interface TamperCase {
  readonly name: string;
  readonly script: string;
  readonly target: ProtectedFixturePath;
}

type LaunchResult = Awaited<ReturnType<typeof runLaunchPlan>>;

const nodeErrorCode = (cause: unknown): string =>
  isUnknownRecord(cause) && isStringValue(cause.code) ? cause.code : "";

const NODE_ERROR_TAGS: Record<string, SystemErrorTag> = {
  EACCES: "PermissionDenied",
  EINVAL: "InvalidData",
  ENOENT: "NotFound",
  EPERM: "PermissionDenied",
};

const nodeSystemErrorTag = (cause: unknown): SystemErrorTag =>
  NODE_ERROR_TAGS[nodeErrorCode(cause)] ?? "Unknown";

const nodePlatformError = (
  method: string,
  path: string,
  cause: unknown
): PlatformError =>
  systemError({
    _tag: nodeSystemErrorTag(cause),
    cause,
    method,
    module: "FileSystem",
    pathOrDescriptor: path,
  });

const nodeFileSystemEffect = <A>(
  method: string,
  path: string,
  run: () => Promise<A>
): Effect.Effect<A, PlatformError> =>
  Effect.tryPromise({
    catch: (cause) => nodePlatformError(method, path, cause),
    try: run,
  });

const makeDirectory = (
  path: string,
  options?: { readonly mode?: number; readonly recursive?: boolean }
): Effect.Effect<void, PlatformError> =>
  nodeFileSystemEffect("makeDirectory", path, async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path, options);
  });

const makeTempDirectory = (options?: {
  readonly directory?: string;
  readonly prefix?: string;
}): Effect.Effect<string, PlatformError> =>
  nodeFileSystemEffect(
    "makeTempDirectory",
    options?.directory ?? "",
    async () => {
      const fs = await import("node:fs/promises");
      const nodePath = await import("node:path");
      return await fs.mkdtemp(
        nodePath.join(options?.directory ?? "/tmp", options?.prefix ?? "tmp-")
      );
    }
  );

const remove = (
  path: string,
  options?: { readonly force?: boolean; readonly recursive?: boolean }
): Effect.Effect<void, PlatformError> =>
  nodeFileSystemEffect("remove", path, async () => {
    const fs = await import("node:fs/promises");
    await fs.rm(path, options);
  });

const writeFileString = (
  path: string,
  data: string,
  options?: { readonly flag?: OpenFlag; readonly mode?: number }
): Effect.Effect<void, PlatformError> =>
  nodeFileSystemEffect("writeFileString", path, async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, data, {
      encoding: "utf-8",
      flag: options?.flag,
      mode: options?.mode,
    });
  });

const readFileString = (path: string): Effect.Effect<string, PlatformError> =>
  nodeFileSystemEffect("readFileString", path, async () => {
    const fs = await import("node:fs/promises");
    return await fs.readFile(path, "utf-8");
  });

const readLink = (path: string): Effect.Effect<string, PlatformError> =>
  nodeFileSystemEffect("readLink", path, async () => {
    const fs = await import("node:fs/promises");
    return await fs.readlink(path);
  });

const exists = (path: string): Effect.Effect<boolean, PlatformError> =>
  nodeFileSystemEffect("exists", path, async () => {
    const fs = await import("node:fs/promises");
    return await fs.access(path).then(
      () => true,
      (error: unknown) => {
        if (nodeErrorCode(error) === "ENOENT") {
          return false;
        }
        throw error;
      }
    );
  });

const makeTempDirectoryScoped = (options?: {
  readonly directory?: string;
  readonly prefix?: string;
}): Effect.Effect<string, PlatformError, Scope> =>
  Effect.acquireRelease(makeTempDirectory(options), (path) =>
    Effect.orDie(remove(path, { force: true, recursive: true }))
  );

const testFileSystemLayer = layerNoop({
  exists,
  makeDirectory,
  makeTempDirectory,
  makeTempDirectoryScoped,
  readFileString,
  readLink,
  remove,
  writeFileString,
});

const protectedPathFixtureLayer = mergeAll(testFileSystemLayer, layer);

const shellPlan = (
  cwd: string,
  script: string,
  protectedPaths?: readonly string[]
): RunnerLaunchPlan => ({
  args: ["-c", script],
  command: "bash",
  cwd,
  env: {},
  nodeId: "node",
  outputFormat: "text",
  ...(protectedPaths ? { protectedPaths } : {}),
  runnerId: "shell",
  type: "command",
});

const runShellEffect = (
  cwd: string,
  script: string,
  protectedPaths?: readonly string[]
): Effect.Effect<LaunchResult, unknown> =>
  Effect.tryPromise({
    catch: (error: unknown) => error,
    try: async () =>
      await runLaunchPlan(shellPlan(cwd, script, protectedPaths)),
  });

const makeWorktreeEffect = (): Effect.Effect<
  string,
  PlatformError,
  FileSystem | Path | Scope
> =>
  Effect.gen(function* makeWorktreeProgram() {
    const fileSystem = yield* FileSystem;
    const path = yield* Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moka-protected-",
    });
    yield* fileSystem.makeDirectory(path.join(root, "backlog", "tasks"), {
      recursive: true,
    });
    yield* fileSystem.makeDirectory(path.join(root, "tests"), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(path.join(root, AC_FILE), AC_CONTENT);
    yield* fileSystem.writeFileString(path.join(root, TEST_FILE), TEST_CONTENT);
    return root;
  });

const writeTextEffect = (
  root: string,
  rel: string,
  content: string
): Effect.Effect<void, PlatformError, FileSystem | Path> =>
  Effect.gen(function* writeTextProgram() {
    const fileSystem = yield* FileSystem;
    const path = yield* Path;
    yield* fileSystem.writeFileString(path.join(root, rel), content);
  });

const removePathEffect = (
  root: string,
  rel: string
): Effect.Effect<void, PlatformError, FileSystem | Path> =>
  Effect.gen(function* removePathProgram() {
    const fileSystem = yield* FileSystem;
    const path = yield* Path;
    yield* fileSystem.remove(path.join(root, rel), { force: true });
  });

const readEffect = (
  root: string,
  rel: string
): Effect.Effect<string, PlatformError, FileSystem | Path> =>
  Effect.gen(function* readProgram() {
    const fileSystem = yield* FileSystem;
    const path = yield* Path;
    return yield* fileSystem.readFileString(path.join(root, rel));
  });

const existsEffect = (
  root: string,
  rel: string
): Effect.Effect<boolean, PlatformError, FileSystem | Path> =>
  Effect.gen(function* existsProgram() {
    const fileSystem = yield* FileSystem;
    const path = yield* Path;
    return yield* fileSystem.exists(path.join(root, rel));
  });

const isNonSymlinkReadLinkError = (error: PlatformError): boolean =>
  error.reason._tag === "InvalidData" || error.reason._tag === "NotFound";

const isSymbolicLinkEffect = (
  root: string,
  rel: string
): Effect.Effect<boolean, PlatformError, FileSystem | Path> =>
  Effect.gen(function* isSymbolicLinkProgram() {
    const fileSystem = yield* FileSystem;
    const path = yield* Path;
    return yield* fileSystem.readLink(path.join(root, rel)).pipe(
      Effect.as(true),
      Effect.catchIf(isNonSymlinkReadLinkError, () => Effect.succeed(false))
    );
  });

const ORIGINAL: Record<ProtectedFixturePath, string> = {
  [AC_FILE]: AC_CONTENT,
  [TEST_FILE]: TEST_CONTENT,
};

// Run a tampering script in a fresh guarded worktree and return the outcome for
// the caller to assert on.
describe("protected-path guard module", () => {
  it.layer(protectedPathFixtureLayer)((test) => {
    test.effect("detects and reverts a modified protected file", () =>
      Effect.gen(function* modifiedProtectedFile() {
        const root = yield* makeWorktreeEffect();
        const guard = createProtectedPathGuard(root, PROTECTED);
        yield* writeTextEffect(root, AC_FILE, "tampered criteria");

        const violations = guard.verifyAndRestore();

        expect(violations).toEqual([{ kind: "modified", path: AC_FILE }]);
        expect(yield* readEffect(root, AC_FILE)).toBe(AC_CONTENT);
      })
    );

    test.effect("detects and recreates a deleted protected file", () =>
      Effect.gen(function* deletedProtectedFile() {
        const root = yield* makeWorktreeEffect();
        const guard = createProtectedPathGuard(root, PROTECTED);
        yield* removePathEffect(root, TEST_FILE);

        const violations = guard.verifyAndRestore();

        expect(violations).toEqual([{ kind: "deleted", path: TEST_FILE }]);
        expect(yield* readEffect(root, TEST_FILE)).toBe(TEST_CONTENT);
      })
    );

    test.effect("is a no-op when no protected patterns are configured", () =>
      Effect.gen(function* unprotectedFile() {
        const root = yield* makeWorktreeEffect();
        const guard = createProtectedPathGuard(root);
        yield* writeTextEffect(root, AC_FILE, "freely edited");

        expect(guard.verifyAndRestore()).toEqual([]);
        expect(yield* readEffect(root, AC_FILE)).toBe("freely edited");
      })
    );
  });
});

const tamperCases: readonly TamperCase[] = [
  {
    name: "AC#1: write to the ticket criteria file",
    script: `printf 'H' > ${AC_FILE}`,
    target: AC_FILE,
  },
  {
    name: "AC#2: overwrite of an adjudicating test",
    script: `printf 'x' > ${TEST_FILE}`,
    target: TEST_FILE,
  },
  {
    name: "AC#2: deletion of an adjudicating test",
    script: `rm -f ${TEST_FILE}`,
    target: TEST_FILE,
  },
  {
    name: "AC#2/AC#7: bash >> append to a test",
    script: `printf 'evil' >> ${TEST_FILE}`,
    target: TEST_FILE,
  },
  {
    name: "AC#7: path-traversal write",
    script: `mkdir -p src/sub && cd src/sub && printf 'HACK' > ../../${TEST_FILE}`,
    target: TEST_FILE,
  },
  {
    name: "AC#7: symlink write-through",
    script: `ln -s "$PWD/${TEST_FILE}" evil-link && printf 'HACK' > evil-link`,
    target: TEST_FILE,
  },
];

describe("runLaunchPlan — CLI/runner transport enforcement", () => {
  it.layer(protectedPathFixtureLayer)((test) => {
    test.effect.each(tamperCases)(
      "rejects $name — file unchanged, node failed",
      ({ script, target }) =>
        Effect.gen(function* rejectedTamper() {
          const root = yield* makeWorktreeEffect();
          const result = yield* runShellEffect(root, script, PROTECTED);

          expect(yield* readEffect(root, target)).toBe(ORIGINAL[target]);
          expect(result.stderr).toMatch(VIOLATION_RE);
          expect(result.exitCode).not.toBe(0);
        })
    );

    test.effect(
      "AC#7: reverts a symlink substituted for the protected path itself",
      () =>
        Effect.gen(function* symlinkSubstitution() {
          const script = `rm -f ${TEST_FILE} && ln -s /etc/hosts ${TEST_FILE}`;
          const root = yield* makeWorktreeEffect();
          yield* runShellEffect(root, script, PROTECTED);

          expect(yield* readEffect(root, TEST_FILE)).toBe(TEST_CONTENT);
          expect(yield* isSymbolicLinkEffect(root, TEST_FILE)).toBe(false);
        })
    );

    test.effect(
      "AC#5: removing the protected entry re-enables the write (live, not inert)",
      () =>
        Effect.gen(function* unguardedWrite() {
          const guarded = yield* makeWorktreeEffect();
          yield* runShellEffect(
            guarded,
            `printf 'HACKED' > ${AC_FILE}`,
            PROTECTED
          );
          expect(yield* readEffect(guarded, AC_FILE)).toBe(AC_CONTENT);

          const unguarded = yield* makeWorktreeEffect();
          const result = yield* runShellEffect(
            unguarded,
            `printf 'HACKED' > ${AC_FILE}`,
            []
          );
          expect(yield* readEffect(unguarded, AC_FILE)).toBe("HACKED");
          expect(result.exitCode).toBe(0);
          expect(result.stderr).not.toMatch(VIOLATION_RE);
        })
    );
  });
});

const loadAcceptanceStore = (root: string) =>
  Effect.provide(loadBacklogTaskStoreEffect(root), RepoIoServiceLive);

const protectedConfig = () =>
  parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - { id: run, kind: agent, profile: code-writer }
`,
    profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: []
  code-writer:
    runner: opencode
    instructions: { inline: Write code }
    tools: [read, edit, write, bash]
    filesystem:
      mode: workspace-write
      protected: ["backlog/tasks/**", "tests/**"]
`,
    runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    model: openai/gpt-5.5
    capabilities:
      native_subagents: true
      output_formats: [text, json]
      tools: [read, edit, write, bash]
      filesystem: [read-only, workspace-write]
`,
  });

describe("filesystem.protected wiring", () => {
  it("AC#5: createRunnerLaunchPlan copies filesystem.protected onto the plan", () => {
    const plan = createRunnerLaunchPlan(protectedConfig(), {
      nodeId: "run",
      profileId: "code-writer",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });

    expect(plan.protectedPaths).toEqual(["backlog/tasks/**", "tests/**"]);
  });

  it("AC#3: opencode permission map emits per-path deny for edit and write", () => {
    const definitions = opencodeAdapter.definitions(protectedConfig(), "/repo");
    const agent = definitions.find(
      (def) => def.path === ".opencode/agents/code-writer.md"
    );
    expect(agent).toBeDefined();
    const { permission } = parseWithSchema(
      agentPermissionSchema,
      matter(agent?.content ?? "").data
    );

    const expected = {
      "*": "allow",
      "backlog/tasks/**": "deny",
      "tests/**": "deny",
    };
    expect(permission.edit).toEqual(expected);
    expect(permission.write).toEqual(expected);
  });
});

describe("gate/planner read access retained (AC#6)", () => {
  it.layer(protectedPathFixtureLayer)((test) => {
    test.effect(
      "the acceptance store still reads criteria with protection configured",
      () =>
        Effect.gen(function* readProtectedCriteria() {
          const root = yield* makeWorktreeEffect();
          const store = yield* loadAcceptanceStore(root);
          const criteriaFileExists = yield* existsEffect(root, AC_FILE);

          expect(criteriaFileExists).toBe(true);
          expect(store.tasksById.get("PIPE-1")?.acceptanceCriteria).toEqual([
            "The widget renders",
          ]);
        })
    );
  });
});
