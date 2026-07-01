import { Effect, type Scope } from "effect";
import { requireMokaDbUrl } from "../../moka-global-config";
import type { DurableRunStore } from "./durable-store";
import { migratePostgresSubstrate } from "./postgres/migrate-substrate";
import { postgresDurableRunStore } from "./postgres/postgres-store";

export function resolveDurableStore(
  dbUrl: string | undefined,
  runId?: string
): Effect.Effect<DurableRunStore, unknown, Scope.Scope> {
  return requireMokaDbUrl(dbUrl).pipe(
    Effect.flatMap((requiredDbUrl) =>
      Effect.tryPromise(() => migratePostgresSubstrate(requiredDbUrl)).pipe(
        Effect.flatMap(() =>
          Effect.acquireRelease(
            Effect.tryPromise(() =>
              postgresDurableRunStore(requiredDbUrl, runId)
            ),
            (store) => Effect.promise(() => store.close())
          )
        )
      )
    )
  );
}
