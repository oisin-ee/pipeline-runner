import { Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { raceDetached } from "./detached-race";

describe("raceDetached", () => {
  it("preserves the timeout failure when interrupting a source with a hanging finalizer", async () => {
    const source = Effect.never.pipe(Effect.ensuring(Effect.never));
    const timeout = Effect.sleep(Duration.millis(20)).pipe(Effect.andThen(Effect.fail(new Error("timeout won"))));
    const started = Date.now();

    await expect(Effect.runPromise(raceDetached(source, timeout))).rejects.toThrow("timeout won");

    expect(Date.now() - started).toBeLessThan(500);
  });
});
