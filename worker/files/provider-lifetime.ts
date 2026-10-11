import { StorageProfileCleanupError } from "./storage-profile-opening";

export type OwnProviderOperation = <T>(operation: () => Promise<T>) => Promise<T>;
export interface ProviderReaderLifetime {
  run: OwnProviderOperation;
  ownBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
  cancelBody(body: ReadableStream<Uint8Array>, reason?: unknown): Promise<void>;
  operationFailed(cause: unknown): void;
}
export interface ProviderWriterLifetime extends ProviderReaderLifetime {
  cleanup(owner: unknown, operation: () => Promise<void>): Promise<void>;
  cleanupFailed(owner: unknown, cause: unknown): void;
}

/** One opening owns original transport promises and every selected body. Abort
 * requests cancellation; only the cached cancellation/read promises establish
 * settlement. No installation lease, retry, or provider admission is granted. */
export function ownedProviderLifetime(providerOwner: unknown, signal?: AbortSignal) {
  const operations = new Set<Promise<unknown>>();
  const operationFailures: unknown[] = [];
  const failedCleanups: { owner: unknown; cause: unknown; original?: Promise<void> }[] = [];
  const bodies = new Set<OwnedBody>();
  const selectedBodies = new WeakMap<ReadableStream<Uint8Array>, OwnedBody>();
  let closed = false;
  let disposal: Promise<void> | undefined;
  interface OwnedBody {
    cancel(reason?: unknown): Promise<void>;
    readonly originalFailures: unknown[];
    readonly cleanupFailures: unknown[];
  }

  function ownBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const originalFailures: unknown[] = [], cleanupFailures: unknown[] = [];
    let rawCancellation: Promise<void> | undefined;
    function cancelRaw(reason?: unknown): Promise<void> {
      if (!rawCancellation) {
        rawCancellation = cleanup(body, () => body.cancel(reason));
        rawCancellation.then(() => bodies.delete(record), () => undefined);
      }
      return rawCancellation;
    }
    let selectedCancellation = cancelRaw;
    const record: OwnedBody = { cancel: reason => selectedCancellation(reason), originalFailures, cleanupFailures };
    // Select the actual raw stream BEFORE reader acquisition can reject. A
    // locked stream cannot be cancelled here; its one failed original cancel
    // still owns the selected raw body and must quarantine disposal.
    bodies.add(record); selectedBodies.set(body, record);
    const reader = (() => {
      try { return body.getReader(); }
      catch (error) {
        operationFailed(error); originalFailures.push(error); cancelRaw(error); throw error;
      }
    })();
    const reads = new Set<ReturnType<typeof reader.read>>();
    let ended = false;
    let completion: Promise<void> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const interrupted = (cause?: unknown) => new Error("File read was interrupted", { cause });
    function stop() {
      ended = true;
      signal?.removeEventListener("abort", abort);
    }
    function complete(cancel: boolean, reason?: unknown): Promise<void> {
      if (completion) return completion;
      stop();
      // Capture only actual reader operations, never this pull/cancel/drain
      // bookkeeping promise: awaiting it here would create a self-cycle.
      const originalReads = [...reads];
      let cancellation: Promise<void> | undefined;
      if (cancel) {
        try { cancellation = reader.cancel(reason); }
        catch (error) { cancellation = Promise.reject(error); }
      }
      completion = (async () => {
        const cancelled = cancellation ? await Promise.allSettled([cancellation]) : [];
        await Promise.allSettled(originalReads);
        for (const result of cancelled) if (result.status === "rejected") cleanupFailures.push(result.reason);
        try { reader.releaseLock(); } catch (error) { cleanupFailures.push(error); }
        if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Provider body cleanup is incomplete");
      })();
      // An AbortSignal event cannot return an awaited promise. Ownership keeps
      // this exact completion, including rejection, for cancel/dispose callers.
      completion.then(() => bodies.delete(record), () => undefined);
      return completion;
    }
    function cancel(reason?: unknown): Promise<void> {
      const settled = complete(true, reason);
      // Keep the output readable until actual cancellation and original reads
      // settle. A pending consumer read cannot report abort ahead of cleanup.
      settled.then(() => controller?.error(interrupted(reason)),
        error => controller?.error(interrupted(new AggregateError([reason, error], "Provider cancellation failed"))));
      return settled;
    }
    function abort() {
      if (!ended) originalFailures.push(signal?.reason);
      cancel(signal?.reason);
    }
    selectedCancellation = cancel;
    const wrapped = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        signal?.addEventListener("abort", abort, { once: true });
        if (closed || signal?.aborted) abort();
      },
      async pull(value) {
        if (ended) return;
        const original = reader.read();
        reads.add(original);
        original.then(() => reads.delete(original), error => { reads.delete(original); originalFailures.push(error); });
        try {
          const next = await original;
          if (ended) return;
          if (next.done) {
            try { await complete(false); value.close(); }
            catch (error) { value.error(interrupted(error)); }
          }
          else value.enqueue(next.value);
        } catch (error) {
          if (ended) return;
          value.error(interrupted(error));
          // Preserve the read rejection and drain the underlying selected body.
          complete(true, error);
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    selectedBodies.set(wrapped, record);
    return wrapped;
  }

  function cancelBody(body: ReadableStream<Uint8Array>, reason?: unknown): Promise<void> {
    const record = selectedBodies.get(body);
    return record ? record.cancel(reason) : Promise.reject(new Error("Unowned provider body cancellation"));
  }

  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Storage profile opening is disposed"));
    let original: Promise<T>;
    try { original = operation(); } catch (error) { original = Promise.reject(error); }
    operations.add(original);
    original.then(() => operations.delete(original), error => { operations.delete(original); operationFailures.push(error); });
    return original;
  }
  function cleanupFailed(owner: unknown, cause: unknown, original?: Promise<void>) { failedCleanups.push({ owner, cause, original }); }
  function operationFailed(cause: unknown) { operationFailures.push(cause); }
  function cleanup(owner: unknown, operation: () => Promise<void>): Promise<void> {
    // Cleanup is owned even after disposal stopped new transport admission.
    // Invoke exactly once here, capturing the actual promise before returning.
    let original: Promise<void>;
    try { original = operation(); } catch (error) { original = Promise.reject(error); }
    operations.add(original);
    original.then(() => operations.delete(original), error => {
      operations.delete(original); cleanupFailed(owner, error, original);
    });
    return original;
  }
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    closed = true;
    const originalOperations = [...operations];
    const currentBodies = [...bodies];
    disposal = (async () => {
      // Cancel currently selected bodies before waiting for transport ACKs.
      // A delayed GET can select another body while its original promise drains.
      await Promise.allSettled([...currentBodies.map(body => body.cancel()), ...originalOperations]);
      // Settling an already admitted writer can dispatch its original abort
      // cleanup after the first snapshot. Drain those owned promises too.
      while (operations.size) await Promise.allSettled([...operations]);
      await Promise.allSettled([...bodies].map(body => body.cancel()));
      const failedBodies = [...bodies].filter(body => body.cleanupFailures.length);
      if (failedBodies.length || failedCleanups.length) {
        const validation = new AggregateError([...operationFailures,
          ...failedBodies.flatMap(body => body.originalFailures)], "Provider operations settled with incomplete cleanup");
        const cleanup = new AggregateError([...failedBodies.flatMap(body => body.cleanupFailures),
          ...failedCleanups.map(value => value.cause)], "Provider body cleanup is incomplete");
        throw new StorageProfileCleanupError(validation, cleanup, {
          owner: Object.freeze({ provider: providerOwner, lifetime, failedCleanups: Object.freeze([...failedCleanups]) }), dispose,
        });
      }
    })();
    disposal.then(() => undefined, () => undefined);
    return disposal;
  }
  const lifetime = Object.freeze({ run, ownBody, cancelBody, cleanup, cleanupFailed, operationFailed, dispose });
  return lifetime;
}
