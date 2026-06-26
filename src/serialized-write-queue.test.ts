import { describe, expect, it } from "vitest";
import { createSerializedWriteQueue } from "./serialized-write-queue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {
    // replaced synchronously below
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("serialized write queue", () => {
  it("runs enqueued writes in FIFO order", async () => {
    const queue = createSerializedWriteQueue();
    const firstWrite = deferred();
    const order: string[] = [];

    queue.enqueue(async () => {
      order.push("first:start");
      await firstWrite.promise;
      order.push("first:end");
    });
    queue.enqueue(async () => {
      order.push("second");
    });

    await tick();
    expect(order).toEqual(["first:start"]);

    firstWrite.resolve();
    await queue.flush();

    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("waits for pending writes during flush", async () => {
    const queue = createSerializedWriteQueue();
    const write = deferred();
    let flushed = false;

    queue.enqueue(async () => {
      await write.promise;
    });
    const flush = queue.flush().then(() => {
      flushed = true;
    });

    await tick();
    expect(flushed).toBe(false);

    write.resolve();
    await flush;

    expect(flushed).toBe(true);
  });

  it("continues accepting writes after a failed write", async () => {
    const queue = createSerializedWriteQueue();
    const failure = new Error("write failed");
    const order: string[] = [];

    queue.enqueue(async () => {
      order.push("first");
      throw failure;
    });
    queue.enqueue(async () => {
      order.push("second");
    });

    await expect(queue.flush()).rejects.toBe(failure);
    expect(order).toEqual(["first", "second"]);

    queue.enqueue(async () => {
      order.push("third");
    });

    await expect(queue.flush()).resolves.toBeUndefined();
    expect(order).toEqual(["first", "second", "third"]);
  });
});
