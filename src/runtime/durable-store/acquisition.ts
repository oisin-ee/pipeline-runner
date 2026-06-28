import { Effect, type Scope } from "effect";
import {
  type MokaDbUrlRequiredError,
  requireMokaDbUrl,
} from "../../moka-global-config";
import type { DurableRunStore } from "./durable-store";
import { postgresDurableRunStore } from "./postgres/postgres-store";

export function resolveDurableStore(
  dbUrl: string | undefined,
  runId?: string
): Effect.Effect<
  DurableRunStore,
  unknown | MokaDbUrlRequiredError,
  Scope.Scope
> {
  return requireMokaDbUrl(dbUrl).pipe(
    Effect.flatMap((requiredDbUrl) =>
      Effect.acquireRelease(
        Effect.tryPromise(() => postgresDurableRunStore(requiredDbUrl, runId)),
        (store) => Effect.promise(() => store.close())
      )
    )
  );
}
