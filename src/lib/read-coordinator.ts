/** A read round keeps its slot until every started request has settled. Aborting
 * a promise race alone cannot bound requests when a transport ignores abort. */
export const READ_TIMEOUT_MS = 20_000;
export const ACTIVE_READ_INTERVAL_MS = 5_000;
export const IDLE_READ_INTERVAL_MS = 30_000;
export class ReadTimeoutError extends Error {
  constructor() { super("Reading status timed out. Retry after the current requests finish."); this.name = "ReadTimeoutError"; }
}
const cancelled = () => new DOMException("The status read was cancelled.", "AbortError");
export const isReadCancellation = (signal: AbortSignal) => signal.aborted && signal.reason?.name === "AbortError";
export interface ReadRound {
  readonly signal: AbortSignal;
  all<const T extends readonly unknown[]>(values: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>;
}
interface Options { fresh?: boolean; onTimeout?: (error: ReadTimeoutError) => void }
type Work = (round: ReadRound) => Promise<void>;
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function createReadCoordinator(timeoutMs = READ_TIMEOUT_MS) {
  type Pending = ReturnType<typeof deferred> & { parent: AbortSignal; work: Work; options: Options };
  let active: { controller: AbortController; promise: Promise<void> } | null = null, queued: Pending | null = null;
  function start(parent: AbortSignal, work: Work, options: Options): Promise<void> {
    if (parent.aborted) return Promise.resolve();
    const completion = deferred(), controller = new AbortController(), requests: Promise<unknown>[] = [];
    const current = { controller, promise: completion.promise }; active = current;
    const abort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      const error = new ReadTimeoutError(); controller.abort(error); options.onTimeout?.(error);
    }, timeoutMs);
    const round: ReadRound = {
      signal: controller.signal,
      all<const T extends readonly unknown[]>(values: T) {
        const pending = values.map(value => Promise.resolve(value)); requests.push(...pending);
        return Promise.all(pending.map(value => value.catch(error => { controller.abort(error); throw error; }))) as Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>;
      },
    };
    void (async () => {
      let error: unknown;
      try { await work(round); }
      catch (failure) { error = failure; controller.abort(failure); }
      finally {
        await Promise.allSettled(requests);
        controller.abort(cancelled());
        clearTimeout(timer); parent.removeEventListener("abort", abort);
        if (active === current) active = null;
        const next = queued; queued = null;
        if (next) start(next.parent, next.work, next.options).then(next.resolve, next.reject);
        if (error !== undefined) completion.reject(error); else completion.resolve();
      }
    })();
    return completion.promise;
  }
  return {
    run(parent: AbortSignal, work: Work, options: Options = {}): Promise<void> {
      if (parent.aborted) return Promise.resolve();
      if (!active) return start(parent, work, options);
      if (!options.fresh) return active.promise;
      if (!queued) queued = { ...deferred(), parent, work, options };
      else { queued.parent = parent; queued.work = work; queued.options = options; }
      return queued.promise;
    },
    cancel() {
      active?.controller.abort(cancelled());
      queued?.resolve(); queued = null;
    },
    idle() { return queued?.promise ?? active?.promise ?? Promise.resolve(); },
  };
}

/** Timer cadence is UI freshness, never executor cadence. Hidden documents stop
 * automatic reads; one visible refresh is coalesced behind an unsettled round. */
export function startVisibleReadPolling(options: {
  read(): Promise<void>; current(): boolean; active(): boolean; cancel(): void;
  document?: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
}) {
  const document = options.document ?? globalThis.document;
  let stopped = false, running = false, again = false, idleRounds = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  async function poll() {
    clear();
    if (stopped || document.hidden || !options.current()) return;
    if (running) { again = true; return; }
    running = true;
    try { await options.read(); }
    finally {
      running = false;
      if (stopped || document.hidden || !options.current()) return;
      if (again) { again = false; void poll(); }
      else {
        const active = options.active();
        const delay = active ? ACTIVE_READ_INTERVAL_MS : Math.min(IDLE_READ_INTERVAL_MS, ACTIVE_READ_INTERVAL_MS * 2 ** idleRounds++);
        if (active) idleRounds = 0;
        timer = setTimeout(() => void poll(), delay);
      }
    }
  }
  function visibility() {
    clear();
    if (document.hidden) { again = false; options.cancel(); }
    else { idleRounds = 0; void poll(); }
  }
  document.addEventListener("visibilitychange", visibility);
  void poll();
  return {
    refresh() { idleRounds = 0; if (!document.hidden) void poll(); },
    stop() { stopped = true; clear(); options.cancel(); document.removeEventListener("visibilitychange", visibility); },
  };
}
