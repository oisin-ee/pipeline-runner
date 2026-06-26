import { Effect, Schedule, Semaphore } from "effect";
import { describe, expect, it } from "vitest";

/**
 * PIPE-83.8: de-risking PoC for the chosen runtime substrate (Effect, per the
 * PIPE-83.8 spike). Proves Effect delivers moka's two load-bearing
 * scheduler primitives in-process:
 *   1. per-category fan-out caps -> Effect.Semaphore (one per category)
 *   2. retry/backoff with jitter -> Schedule.exponential |> jittered
 * Durable crash-resume (@effect/workflow / @effect/cluster) is alpha and is
 * intentionally OUT of this PoC; the full rebuild + durability lands in
 * PIPE-83.10 behind a swappable WorkflowEngine seam.
 *
 * A5: the test bodies ARE Effects. They are run explicitly so the file stays
 * compatible with the repo Vitest runner and does not hang when executed by
 * Bun's runner directly.
 */
describe("Effect substrate PoC (PIPE-83.8)", () => {
  it("enforces a per-category concurrency cap with a Semaphore", () =>
    runEffect(
      Effect.gen(function* () {
        // token_budget.fan_out_width.by_category.green = 2
        const greenCap = yield* Semaphore.make(2);
        let active = 0;
        let maxActive = 0;
        const candidate = greenCap.withPermits(1)(
          Effect.gen(function* () {
            active += 1;
            maxActive = Math.max(maxActive, active);
            yield* Effect.sleep("5 millis");
            active -= 1;
          })
        );

        yield* Effect.all(
          [candidate, candidate, candidate, candidate, candidate],
          {
            concurrency: "unbounded",
          }
        );
        expect(maxActive).toBeLessThanOrEqual(2);
      })
    ));

  it("retries a transient failure with exponential jittered backoff", () =>
    runEffect(
      Effect.gen(function* () {
        let attempts = 0;
        const flaky = Effect.suspend(() => {
          attempts += 1;
          return attempts < 3
            ? Effect.fail("transient" as const)
            : Effect.succeed(attempts);
        });
        const policy = Schedule.both(
          Schedule.exponential("1 millis"),
          Schedule.recurs(5)
        ).pipe(Schedule.jittered);

        const result = yield* Effect.retry(flaky, policy);
        expect(result).toBe(3);
      })
    ));

  it("propagates a typed error channel and recovers it", () =>
    runEffect(
      Effect.gen(function* () {
        const failing = Effect.fail({ _tag: "OverBudget" as const });
        const recovered = yield* failing.pipe(
          Effect.catch((error) => Effect.succeed(error._tag))
        );
        expect(recovered).toBe("OverBudget");
      })
    ));
});

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}
