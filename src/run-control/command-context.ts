import { Effect } from "effect";

import type { RunControlStore } from "./run-control-store";
import { withRunControlStoreScoped } from "./run-control-store";

export const workspaceRoot = (): string => process.env.PIPELINE_TARGET_PATH ?? process.cwd();

export const withRunControlStore = <A>(
  use: (store: RunControlStore, workspaceRoot: string) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> => {
  const root = workspaceRoot();
  return withRunControlStoreScoped(root, (store) => use(store, root));
};

export const logEffect = (message: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${message}\n`);
  });
