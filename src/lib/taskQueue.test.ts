import { describe, expect, it, vi } from "vitest";
import { TaskQueue } from "./taskQueue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("TaskQueue", () => {
  it("runs no more than the configured number of tasks", async () => {
    const queue = new TaskQueue(2);
    const releases = [deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let maximumActive = 0;
    const started: number[] = [];

    const tasks = releases.map((release, index) => queue.run(async () => {
      started.push(index);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await release.promise;
      active -= 1;
    }));

    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    releases[0].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases[1].resolve();
    releases[2].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[3].resolve();
    await Promise.all(tasks);
    expect(maximumActive).toBe(2);
  });

  it("removes an aborted waiting task without starting it", async () => {
    const queue = new TaskQueue(1);
    const release = deferred();
    const first = queue.run(() => release.promise);
    const controller = new AbortController();
    let started = false;
    const waiting = queue.run(async () => { started = true; }, controller.signal);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    await first;
    expect(started).toBe(false);
  });
});
