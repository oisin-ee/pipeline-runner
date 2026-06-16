import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { CommandExecutionContext } from "../command-executor";
import type { NodeAttemptResult } from "../contracts";
import { CommandExecutor } from "./command-executor-service";

/**
 * A5: lock the Effect dependency-injection seam. A consumer resolves the
 * CommandExecutor Tag from whichever Layer is provided — here a stub Layer that
 * returns a canned result instead of spawning a real process — proving services
 * are swappable via `Effect.provide` rather than `vi.mock`.
 */
const stubResult: NodeAttemptResult = {
  evidence: ["stub command"],
  exitCode: 0,
  output: "ok",
};

const CommandExecutorStub = Layer.succeed(CommandExecutor, {
  execute: () => Effect.succeed(stubResult),
});

describe("CommandExecutor service (Layer injection)", () => {
  it.effect(
    "resolves execute from the provided Layer, not a real process",
    () =>
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const result = yield* executor.execute(
          ["noop"],
          {} as CommandExecutionContext
        );
        expect(result.exitCode).toBe(0);
        expect(result.output).toBe("ok");
        expect(result.evidence).toEqual(["stub command"]);
      }).pipe(Effect.provide(CommandExecutorStub))
  );
});
