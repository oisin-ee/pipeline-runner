import { Effect, type Scope } from "effect";
import { type DurableRunStore, inMemoryDurableRunStore } from "./durable-store";
import { postgresDurableRunStore } from "./postgres/postgres-store";

export function resolveDurableStore(
  dbUrl: string | undefined,
  runId?: string
): Effect.Effect<DurableRunStore, unknown, Scope.Scope> {
  if (dbUrl === undefined) {
    return Effect.succeed(inMemoryDurableRunStore());
  }
  return Effect.acquireRelease(
    Effect.tryPromise(() => postgresDurableRunStore(dbUrl, runId)),
    (store) => Effect.promise(() => store.close())
  );
}
