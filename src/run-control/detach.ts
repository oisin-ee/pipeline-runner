// fallow-ignore-file unused-export complexity
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

export interface StartDetachedRunControllerInput {
  entrypoint?: string;
  runId: string;
  schedule?: string;
  task: string;
  workflow?: string;
  workspaceRoot: string;
}

export interface DetachedRunControllerLaunch {
  argv: string[];
  pid: number;
  startedAt: string;
}

export function startDetachedRunController(
  input: StartDetachedRunControllerInput
): Promise<DetachedRunControllerLaunch> {
  return Effect.runPromise(startDetachedRunControllerEffect(input));
}

export function startDetachedRunControllerEffect(
  input: StartDetachedRunControllerInput
): Effect.Effect<DetachedRunControllerLaunch, unknown> {
  return Effect.gen(function* () {
    const command = process.execPath;
    const args = yield* controllerArgsEffect(input);
    const child = yield* Effect.sync(() =>
      spawn(command, args, {
        cwd: input.workspaceRoot,
        detached: true,
        env: {
          ...process.env,
          PIPELINE_TARGET_PATH: input.workspaceRoot,
        },
        stdio: "ignore",
      })
    );

    if (!child.pid) {
      return yield* Effect.fail(
        new Error("Detached run controller did not expose a process id.")
      );
    }

    yield* waitForControllerSpawnEffect(child);
    yield* Effect.sync(() => child.unref());

    return {
      argv: [command, ...args],
      pid: child.pid,
      startedAt: new Date().toISOString(),
    };
  });
}

function controllerArgsEffect(
  input: StartDetachedRunControllerInput
): Effect.Effect<string[], unknown> {
  return Effect.gen(function* () {
    const entrypoint = yield* cliEntrypointPathEffect();
    return [
      entrypoint,
      "run-controller",
      "--run-id",
      input.runId,
      ...optionalOption("--schedule", input.schedule),
      ...optionalOption("--entrypoint", input.entrypoint),
      ...optionalOption("--workflow", input.workflow),
      "--",
      input.task,
    ];
  });
}

function optionalOption(name: string, value: string | undefined): string[] {
  return value ? [name, value] : [];
}

function cliEntrypointPathEffect(): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const envEntrypoint = process.env.MOKA_CLI_ENTRYPOINT;
    if (envEntrypoint) {
      return envEntrypoint;
    }

    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const compiledEntrypoint = join(moduleDir, "..", "index.js");
    if (yield* pathExistsEffect(compiledEntrypoint)) {
      return compiledEntrypoint;
    }

    const sourceEntrypoint = join(moduleDir, "..", "index.ts");
    if (yield* pathExistsEffect(sourceEntrypoint)) {
      return sourceEntrypoint;
    }

    return process.argv[1] ?? compiledEntrypoint;
  });
}

function pathExistsEffect(path: string): Effect.Effect<boolean, unknown> {
  return Effect.sync(() => existsSync(path));
}

function waitForControllerSpawnEffect(
  child: ReturnType<typeof spawn>
): Effect.Effect<void, unknown> {
  return Effect.async<void, unknown>((resume) => {
    const onSpawn = (): void => resume(Effect.void);
    const onError = (error: unknown): void => resume(Effect.fail(error));
    child.once("spawn", onSpawn);
    child.once("error", onError);

    return Effect.sync(() => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    });
  });
}
