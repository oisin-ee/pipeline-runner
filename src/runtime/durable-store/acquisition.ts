import { Effect } from "effect";
import type { Scope } from "effect";

import { requireMokaDbUrl } from "../../moka-global-config";
import type { DurableRunStore } from "./durable-store";
import { migratePostgresSubstrate } from "./postgres/migrate-substrate";
import { postgresDurableRunStore } from "./postgres/postgres-store";

export const resolveDurableStore = (
  dbUrl?: string,
  runId?: string
): Effect.Effect<DurableRunStore, unknown, Scope.Scope> =>
  requireMokaDbUrl(dbUrl).pipe(
    Effect.flatMap((requiredDbUrl) =>
      Effect.tryPromise(async () => {
        await migratePostgresSubstrate(requiredDbUrl);
      }).pipe(
        Effect.flatMap(() =>
          Effect.acquireRelease(
            Effect.tryPromise(
              async () => await postgresDurableRunStore(requiredDbUrl, runId)
            ),
            (store) =>
              Effect.promise(async () => {
                await store.close();
              })
          )
        )
      )
    )
  );
