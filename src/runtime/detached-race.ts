import { Effect, Exit, Fiber, Option } from "effect";

const replayExit = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(exit)
    ? Effect.succeed(exit.value)
    : Effect.failCause(exit.cause);

const interruptInBackground = <A, E>(
  fiber: Fiber.Fiber<A, E>
): Effect.Effect<void> =>
  Effect.forkDetach(Fiber.interrupt(fiber), {
    startImmediately: true,
  }).pipe(Effect.asVoid);

/**
 * Race a source effect against a policy effect while letting the caller return
 * the policy result immediately when it wins. The source runs in a detached
 * fiber; if the policy wins, source cleanup is interrupted from an outer
 * finalizer so the interruption cannot replace the policy failure cause.
 */
export const raceDetached = <A, E, R, A2, E2, R2>(
  source: Effect.Effect<A, E, R>,
  policy: Effect.Effect<A2, E2, R2>
): Effect.Effect<A | A2, E | E2, R | R2> => {
  let sourceFiber: Option.Option<Fiber.Fiber<A, E>> = Option.none();
  let sourceWon = false;
  return Effect.gen(function* effectBody() {
    const startedFiber = yield* Effect.forkDetach(source, {
      startImmediately: true,
    });
    sourceFiber = Option.some(startedFiber);
    const sourceResult = Fiber.await(startedFiber).pipe(
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
        !sourceWon && Option.isSome(sourceFiber)
          ? interruptInBackground(sourceFiber.value)
          : Effect.void
      )
    )
  );
};
