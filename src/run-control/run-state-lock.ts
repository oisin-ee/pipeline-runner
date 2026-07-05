/**
 * Process-wide serialization for critical sections that read, write, or
 * temporarily relocate the `.pipeline/runs` run-state directory.
 *
 * The mechanical-check builtins (`lint`, `fallow`) hide `.pipeline/runs` for the
 * duration of their command so those tools do not scan supervisor run-state
 * (see builtins.ts `hidePipelineRunsDirectory`). Under the parallel
 * mechanical-checks fan-out that hide window overlapped the run-control
 * reporter's persistence of sibling node-status events, which then observed a
 * momentarily-missing run directory and failed the whole run with
 * "Run <id> does not exist". This lock makes the hide window and run-state
 * persistence mutually exclusive without serializing any unrelated parallel
 * work: only the run-state critical sections contend for it.
 *
 * PIPE-92.1: intentionally not replaced by the serialized write queue. This is
 * a lock with manual acquire/release for critical sections that can span
 * filesystem rename/restore boundaries; it is not a FIFO write/flush queue.
 */
let chain: Promise<void> = Promise.resolve();

/**
 * Acquire the lock, resolving with a release function once every previously
 * queued holder has released. Callers MUST invoke the returned release exactly
 * once (use `withRunStateLock` unless you must span non-promise boundaries, as
 * the builtin hide/restore does).
 */
export const acquireRunStateLock = async (): Promise<() => void> => {
  const previous = chain;
  let release: () => void = () => {
    // replaced synchronously below
  };
  chain = new Promise<void>((resolve) => {
    release = resolve;
  });
  return await previous.then(() => release);
};

/** Run `fn` while holding the run-state lock, releasing on success or failure. */
export const withRunStateLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const release = await acquireRunStateLock();
  try {
    return await fn();
  } finally {
    release();
  }
};
