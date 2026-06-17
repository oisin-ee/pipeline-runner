import { describe, expect, it } from "vitest";
import { acquireRunStateLock, withRunStateLock } from "./run-state-lock";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("run-state lock", () => {
  it("blocks a second critical section until the first releases, preserving order", async () => {
    const order: string[] = [];

    const release = await acquireRunStateLock();
    let secondRan = false;
    const second = withRunStateLock(() => {
      secondRan = true;
      order.push("second");
      return Promise.resolve();
    });

    // While the first holder keeps the lock, the second section cannot run.
    await tick();
    expect(secondRan).toBe(false);
    order.push("while-held");

    release();
    await second;
    expect(order).toEqual(["while-held", "second"]);
  });

  it("releases the lock even when the critical section throws", async () => {
    await expect(
      withRunStateLock(() => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");

    let recovered = false;
    await withRunStateLock(() => {
      recovered = true;
      return Promise.resolve();
    });
    expect(recovered).toBe(true);
  });
});
