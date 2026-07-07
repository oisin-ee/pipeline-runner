export type SerializedWrite = () => Promise<void> | void;

export interface SerializedWriteQueue {
  enqueue(write: SerializedWrite): void;
  flush(): Promise<void>;
}

interface WriteFailure {
  error: unknown;
  sequence: number;
}

const runWrite = async (write: SerializedWrite): Promise<void> => {
  await write();
};

/**
 * A tiny in-process FIFO for write-through persistence. It keeps scheduling
 * writes after a failure; flush reports the first failure from the drained
 * sequence range while leaving caller-specific error policy to the caller.
 */
export const createSerializedWriteQueue = (): SerializedWriteQueue => {
  let nextSequence = 0;
  let tail: Promise<void> = Promise.resolve();
  const failures: WriteFailure[] = [];

  const removeFailuresThrough = (sequence: number): void => {
    for (let index = failures.length - 1; index >= 0; index -= 1) {
      if ((failures[index]?.sequence ?? Number.POSITIVE_INFINITY) <= sequence) {
        failures.splice(index, 1);
      }
    }
  };

  const runQueuedWrite = async (
    previousTail: Promise<void>,
    write: SerializedWrite,
    sequence: number
  ): Promise<void> => {
    await previousTail;
    const [result] = await Promise.allSettled([runWrite(write)]);
    if (result.status === "rejected") {
      failures.push({ error: result.reason, sequence });
    }
  };

  return {
    enqueue(write) {
      const sequence = nextSequence;
      nextSequence += 1;
      tail = runQueuedWrite(tail, write, sequence);
    },

    async flush() {
      const drainThroughSequence = nextSequence - 1;
      const drain = tail;
      await drain;

      const failure = failures.find(
        (entry) => entry.sequence <= drainThroughSequence
      );
      removeFailuresThrough(drainThroughSequence);
      if (failure) {
        throw failure.error;
      }
    },
  };
};
