import { Effect, Exit, Fiber } from "effect";

/**
 * Race a source effect against a policy effect while letting the caller return
 * the policy result immediately when it wins. The source runs in a detached
 * fiber; if the policy wins, source cleanup is interrupted from an outer
 * finalizer so the interruption cannot replace the policy failure cause.
 */
export function raceDetached<A, E, R, A2, E2, R2>(
  source: Effect.Effect<A, E, R>,
  policy: Effect.Effect<A2, E2, R2>
): Effect.Effect<A | A2, E | E2, R | R2> {
  let sourceFiber: Fiber.Fiber<A, E> | undefined;
  let sourceWon = false;
  return Effect.gen(function* () {
    sourceFiber = yield* Effect.forkDetach(source, { startImmediately: true });
    const sourceResult = Fiber.await(sourceFiber).pipe(
      Effect.flatMap((exit) =>
        Effect.sync(() => {
          sourceWon = true;
        }).pipe(Effect.andThen(replayExit(exit)))
      )
    );
    return yield* Effect.raceFirst(sourceResult, policy);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        !sourceWon && sourceFiber
          ? interruptInBackground(sourceFiber)
          : Effect.void
      )
    )
  );
}

function replayExit<A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> {
  return Exit.isSuccess(exit)
    ? Effect.succeed(exit.value)
    : Effect.failCause(exit.cause);
}

function interruptInBackground<A, E>(
  fiber: Fiber.Fiber<A, E>
): Effect.Effect<void> {
  return Effect.forkDetach(Fiber.interrupt(fiber), {
    startImmediately: true,
  }).pipe(Effect.asVoid);
}
