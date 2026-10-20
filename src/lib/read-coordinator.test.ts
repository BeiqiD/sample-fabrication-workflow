import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadCoordinator, ReadTimeoutError, startVisibleReadPolling } from "./read-coordinator";
function deferred<T = void>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("bounded read rounds", () => {
  it("aborts siblings on partial failure and keeps the slot while an ignored cancellation is unsettled", async () => {
    const parent = new AbortController(), reads = createReadCoordinator(), hung = deferred();
    let signal!: AbortSignal, errors = 0;
    const first = reads.run(parent.signal, async round => {
      signal = round.signal;
      try { await round.all([Promise.reject(new Error("list unavailable")), hung.promise]); }
      catch { errors++; }
    });
    await flush();
    expect(signal.aborted).toBe(true); expect(parent.signal.aborted).toBe(false); expect(errors).toBe(1);
    const replacement = vi.fn(async () => {});
    const joined = reads.run(parent.signal, replacement);
    await flush(); expect(replacement).not.toHaveBeenCalled();
    hung.resolve(); await first; await joined;
    await reads.run(parent.signal, replacement); expect(replacement).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent refreshes into one fresh follow-up using the latest requested read", async () => {
    const reads = createReadCoordinator(), parent = new AbortController(), held = deferred();
    const first = reads.run(parent.signal, async () => held.promise), old = vi.fn(async () => {}), latest = vi.fn(async () => {});
    const second = reads.run(parent.signal, old, { fresh: true }), third = reads.run(parent.signal, latest, { fresh: true });
    expect(second).toBe(third); held.resolve(); await first; await second;
    expect(old).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledTimes(1);
  });
  it("reports a deadline without replacing a request that ignores abort", async () => {
    vi.useFakeTimers(); const reads = createReadCoordinator(25), parent = new AbortController(), held = deferred(), timeout = vi.fn();
    let signal!: AbortSignal;
    const first = reads.run(parent.signal, async round => { signal = round.signal; await held.promise; }, { onTimeout: timeout });
    await vi.advanceTimersByTimeAsync(25);
    expect(signal.aborted).toBe(true); expect(signal.reason).toBeInstanceOf(ReadTimeoutError); expect(timeout).toHaveBeenCalledTimes(1);
    const replacement = vi.fn(async () => {}); void reads.run(parent.signal, replacement); await flush();
    expect(replacement).not.toHaveBeenCalled(); expect(parent.signal.aborted).toBe(false);
    held.resolve(); await first;
  });
  it("parent cancellation aborts reads and prevents a queued read from starting after unmount", async () => {
    const reads = createReadCoordinator(), parent = new AbortController(), held = deferred(); let signal!: AbortSignal;
    const first = reads.run(parent.signal, async round => { signal = round.signal; await held.promise; });
    const later = vi.fn(async () => {}), queued = reads.run(parent.signal, later, { fresh: true });
    parent.abort(); expect(signal.aborted).toBe(true); held.resolve(); await first; await queued;
    expect(later).not.toHaveBeenCalled();
  });
  it("cancel also clears a pending follow-up without cancelling the parent's write lifetime", async () => {
    const reads = createReadCoordinator(), parent = new AbortController(), held = deferred();
    const first = reads.run(parent.signal, async () => held.promise), later = vi.fn(async () => {});
    const queued = reads.run(parent.signal, later, { fresh: true }); reads.cancel(); await queued;
    expect(parent.signal.aborted).toBe(false); held.resolve(); await first; expect(later).not.toHaveBeenCalled();
  });
});

class Visibility extends EventTarget {
  hidden = false;
  show(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event("visibilitychange")); }
}
describe("visible status polling", () => {
  it("keeps active work at five seconds and progressively backs idle reads off to thirty seconds", async () => {
    vi.useFakeTimers(); const document = new Visibility(), read = vi.fn(async () => {}); let active = false;
    const poller = startVisibleReadPolling({ document, read, active: () => active, current: () => true, cancel: vi.fn() });
    await flush(); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000); expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000); expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(29_999); expect(read).toHaveBeenCalledTimes(4);
    active = true; await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5_000); expect(read).toHaveBeenCalledTimes(6); poller.stop();
  });
  it("cancels on hide, performs no hidden reads, and immediately refreshes when visible", async () => {
    vi.useFakeTimers(); const document = new Visibility(), cancel = vi.fn(), read = vi.fn(async () => {});
    const poller = startVisibleReadPolling({ document, read, current: () => true, active: () => true, cancel });
    await flush(); document.show(true); expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(1);
    document.show(false); await flush(); expect(read).toHaveBeenCalledTimes(2); poller.stop();
    document.show(false); await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(2);
  });
  it("coalesces visible/manual wakeups behind an unsettled cancelled round", async () => {
    vi.useFakeTimers(); const document = new Visibility(), held = deferred();
    const read = vi.fn(async () => { if (read.mock.calls.length === 1) await held.promise; });
    const poller = startVisibleReadPolling({ document, read, current: () => true, active: () => true, cancel: vi.fn() });
    document.show(true); document.show(false); poller.refresh(); poller.refresh();
    await vi.advanceTimersByTimeAsync(40_000); expect(read).toHaveBeenCalledTimes(1);
    held.resolve(); await flush(); expect(read).toHaveBeenCalledTimes(2); poller.stop();
  });
  it("does not read an initially hidden document or an expired owner", async () => {
    const document = new Visibility(); document.hidden = true; const read = vi.fn(async () => {}); let current = true;
    const poller = startVisibleReadPolling({ document, read, current: () => current, active: () => true, cancel: vi.fn() });
    await flush(); expect(read).not.toHaveBeenCalled(); current = false; document.show(false); await flush();
    expect(read).not.toHaveBeenCalled(); poller.stop();
  });
});
