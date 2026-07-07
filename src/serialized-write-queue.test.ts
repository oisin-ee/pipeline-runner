import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { createSerializedWriteQueue } from "./serialized-write-queue";

class TestPromiseError extends Schema.TaggedErrorClass<TestPromiseError>()(
  "TestPromiseError",
  { cause: Schema.Unknown }
) {}

const RELEASED = "released";

const testPromise = <A>(
  promise: Promise<A>
): Effect.Effect<A, TestPromiseError> =>
  Effect.tryPromise({
    catch: (cause) => new TestPromiseError({ cause }),
    try: async () => {
      const result = await promise;
      return result;
    },
  });

const tick = testPromise(Promise.resolve(RELEASED));

const deferred = () => Promise.withResolvers<typeof RELEASED>();

describe("serialized write queue", () => {
  it.effect("runs enqueued writes in FIFO order", () =>
    Effect.gen(function* testBody() {
      const queue = createSerializedWriteQueue();
      const firstWrite = deferred();
      const order: string[] = [];

      queue.enqueue(async () => {
        order.push("first:start");
        await firstWrite.promise;
        order.push("first:end");
      });
      queue.enqueue(() => {
        order.push("second");
      });

      yield* tick;
      expect(order).toEqual(["first:start"]);

      firstWrite.resolve(RELEASED);
      yield* testPromise(queue.flush());

      expect(order).toEqual(["first:start", "first:end", "second"]);
    })
  );

  it.effect("waits for pending writes during flush", () =>
    Effect.gen(function* testBody() {
      const queue = createSerializedWriteQueue();
      const write = deferred();
      let flushed = false;

      queue.enqueue(async () => {
        await write.promise;
      });
      const flush = async (): Promise<void> => {
        await queue.flush();
        flushed = true;
      };
      const flushFiber = yield* Effect.forkScoped(testPromise(flush()));

      yield* tick;
      expect(flushed).toBe(false);

      write.resolve(RELEASED);
      yield* Fiber.join(flushFiber);

      expect(flushed).toBe(true);
    })
  );

  it.effect("continues accepting writes after a failed write", () =>
    Effect.gen(function* testBody() {
      const queue = createSerializedWriteQueue();
      const failure = new Error("write failed");
      const failedWrite = deferred();
      const order: string[] = [];

      queue.enqueue(async () => {
        order.push("first");
        await failedWrite.promise;
      });
      failedWrite.reject(failure);
      queue.enqueue(() => {
        order.push("second");
      });

      yield* testPromise(expect(queue.flush()).rejects.toBe(failure));
      expect(order).toEqual(["first", "second"]);

      queue.enqueue(() => {
        order.push("third");
      });

      yield* testPromise(expect(queue.flush()).resolves.toBeUndefined());
      expect(order).toEqual(["first", "second", "third"]);
    })
  );
});
