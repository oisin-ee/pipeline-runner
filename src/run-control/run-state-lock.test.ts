import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { acquireRunStateLock, withRunStateLock } from "./run-state-lock";

class RunStateLockTestError extends Schema.TaggedErrorClass<RunStateLockTestError>()(
  "RunStateLockTestError",
  {
    message: Schema.String,
  }
) {
  constructor() {
    super({ message: "boom" });
  }
}

const tick = Effect.sleep(Duration.millis(0));

describe("run-state lock", () => {
  it.effect(
    "blocks a second critical section until the first releases, preserving order",
    () =>
      Effect.gen(function* effectBody() {
        const order: string[] = [];

        const release = yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () => await acquireRunStateLock(),
        });
        let secondRan = false;
        const second = withRunStateLock(async () => {
          secondRan = true;
          order.push("second");
          await Promise.resolve();
        });

        // While the first holder keeps the lock, the second section cannot run.
        yield* tick;
        expect(secondRan).toBe(false);
        order.push("while-held");

        release();
        yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () => {
            await second;
          },
        });
        expect(order).toEqual(["while-held", "second"]);
      })
  );

  it.effect("releases the lock even when the critical section throws", () =>
    Effect.gen(function* effectBody() {
      yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await expect(
            withRunStateLock(
              async () => await Promise.reject(new RunStateLockTestError())
            )
          ).rejects.toThrow("boom");
        },
      });

      let recovered = false;
      yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await withRunStateLock(async () => {
            recovered = true;
            await Promise.resolve();
          });
        },
      });
      expect(recovered).toBe(true);
    })
  );
});
