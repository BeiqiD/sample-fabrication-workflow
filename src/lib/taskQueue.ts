interface QueueEntry {
  started: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  start: () => Promise<void>;
  reject: (reason: unknown) => void;
}
function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

export class TaskQueue {
  private active = 0;
  private readonly pending: QueueEntry[] = [];

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Task queue concurrency must be a positive integer");
    }
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        started: false,
        signal,
        reject,
        start: async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
      };

      if (signal) {
        entry.onAbort = () => {
          if (entry.started) return;
          const index = this.pending.indexOf(entry);
          if (index >= 0) this.pending.splice(index, 1);
          signal.removeEventListener("abort", entry.onAbort!);
          reject(abortError());
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      this.pending.push(entry);
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      if (entry.signal?.aborted) {
        entry.signal.removeEventListener("abort", entry.onAbort!);
        entry.reject(abortError());
        continue;
      }

      entry.started = true;
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
      this.active += 1;
      void entry.start().finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}
