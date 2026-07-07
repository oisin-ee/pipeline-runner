// fallow-ignore-file unused-export complexity
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Effect, Option } from "effect";

const CONTROLLER_SPAWNED = Symbol("controller-spawned");

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

const optionalOption = (name: string, value: Option.Option<string>): string[] =>
  Option.match(value, {
    onNone: () => [],
    onSome: (definedValue) => [name, definedValue],
  });

const pathExistsEffect = (path: string): Effect.Effect<boolean, unknown> =>
  Effect.sync(() => existsSync(path));

const cliEntrypointPathEffect = (): Effect.Effect<string, unknown> =>
  Effect.gen(function* effectBody() {
    const envEntrypoint = process.env.MOKA_CLI_ENTRYPOINT;
    if (envEntrypoint !== undefined && envEntrypoint.length > 0) {
      return envEntrypoint;
    }

    const moduleDir = import.meta.dirname;
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

const controllerArgsEffect = (
  input: StartDetachedRunControllerInput
): Effect.Effect<string[], unknown> =>
  Effect.gen(function* effectBody() {
    const entrypoint = yield* cliEntrypointPathEffect();
    return [
      entrypoint,
      "run-controller",
      "--run-id",
      input.runId,
      ...optionalOption("--schedule", Option.fromNullishOr(input.schedule)),
      ...optionalOption("--entrypoint", Option.fromNullishOr(input.entrypoint)),
      ...optionalOption("--workflow", Option.fromNullishOr(input.workflow)),
      "--",
      input.task,
    ];
  });

const waitForControllerSpawnEffect = (
  child: ReturnType<typeof spawn>
): Effect.Effect<typeof CONTROLLER_SPAWNED, unknown> =>
  Effect.callback<typeof CONTROLLER_SPAWNED, unknown>((resume) => {
    const onSpawn = (): void => {
      resume(Effect.succeed(CONTROLLER_SPAWNED));
    };
    const onError = (error: unknown): void => {
      resume(Effect.fail(error));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);

    return Effect.sync(() => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    });
  });

export const startDetachedRunControllerEffect = (
  input: StartDetachedRunControllerInput
): Effect.Effect<DetachedRunControllerLaunch, unknown> =>
  Effect.gen(function* effectBody() {
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

    if (child.pid === undefined || child.pid === 0) {
      return yield* Effect.fail(
        new Error("Detached run controller did not expose a process id.")
      );
    }

    yield* waitForControllerSpawnEffect(child);
    yield* Effect.sync(() => {
      child.unref();
    });

    return {
      argv: [command, ...args],
      pid: child.pid,
      startedAt: new Date().toISOString(),
    };
  });

export const startDetachedRunController = async (
  input: StartDetachedRunControllerInput
): Promise<DetachedRunControllerLaunch> =>
  await Effect.runPromise(startDetachedRunControllerEffect(input));
