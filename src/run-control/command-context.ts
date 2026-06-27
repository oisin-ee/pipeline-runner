import { Effect } from "effect";
import type { RunControlStore } from "./run-control-store";
import { withRunControlStoreScoped } from "./run-control-store";

export function withRunControlStore<A>(
  use: (
    store: RunControlStore,
    workspaceRoot: string
  ) => Effect.Effect<A, unknown>
): Effect.Effect<A, unknown> {
  const root = workspaceRoot();
  return withRunControlStoreScoped(root, (store) => use(store, root));
}

export function workspaceRoot(): string {
  return process.env.PIPELINE_TARGET_PATH ?? process.cwd();
}

export function logEffect(message: string): Effect.Effect<void> {
  return Effect.sync(() => console.log(message));
}
