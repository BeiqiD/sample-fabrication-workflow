import type { ReadableStreamReadResult } from "node:stream/web";
import { HTTPException } from "hono/http-exception";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";

/** One consumer of the exact ingress body, without tee/clone or a second read.
 * The returned stream preserves backpressure; its original read, cancellation
 * and release outcomes stay retained until the one original cleanup settles. */
export function ownedCommentAcceptanceBody(request: Request) {
  const body = request.body;
  if (!body) throw new HTTPException(400, { message: "The upload body is missing" });
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); }
  catch (cause) {
    let original!: Promise<void>;
    const failure = new StorageProfileCleanupError(cause, cause, {
      owner: Object.freeze({ request, body }), dispose: () => original,
    });
    original = Promise.reject(failure); original.then(() => undefined, () => undefined);
    // A foreign lock or failed acquisition is uncertain. Never cancel another
    // reader or infer an original close from bodyUsed/locked flags.
    throw failure;
  }
  const pending = new Set<Promise<ReadableStreamReadResult<Uint8Array>>>();
  let finished = false, closing: Promise<void> | undefined, cancellation: Promise<void> | undefined;
  function close(cause?: unknown): Promise<void> {
    if (!closing) {
      closing = (async () => {
        const failures: unknown[] = [];
        if (!finished) {
          try { cancellation = reader.cancel(cause); }
          catch (error) { cancellation = Promise.reject(error); }
          cancellation.then(() => undefined, () => undefined);
          try { await cancellation; } catch (error) { failures.push(error); }
        }
        await Promise.allSettled([...pending]);
        try { reader.releaseLock(); } catch (error) { failures.push(error); }
        if (failures.length) throw new StorageProfileCleanupError(cause,
          new AggregateError(failures, "Original Comment ingress cleanup failed"), {
            owner: Object.freeze({ request, body, reader, pending, cancellation }), dispose: () => closing!,
          });
      })();
      closing.then(() => undefined, () => undefined);
    }
    return closing;
  }
  const selected = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closing) { await closing; controller.close(); return; }
      let original: Promise<ReadableStreamReadResult<Uint8Array>>;
      try { original = reader.read(); }
      catch (error) { original = Promise.reject(error); }
      pending.add(original);
      original.then(() => pending.delete(original), () => pending.delete(original));
      try {
        const next = await original;
        if (next.done) { finished = true; await close(); controller.close(); }
        else if (!(next.value instanceof Uint8Array)) throw new HTTPException(400, { message: "The Comment upload body is invalid" });
        else controller.enqueue(next.value);
      } catch (cause) {
        try { await close(cause); }
        catch (cleanup) { controller.error(cleanup); return; }
        controller.error(cause);
      }
    },
    cancel: close,
  }, { highWaterMark: 0 });
  return Object.freeze({ body: selected, dispose: close });
}

/** Exact original JSON/image ingress with the same original size rejection.
 * A failed cancel/release is reported as owned cleanup, never silently erased
 * by parsing, a concurrent session denial or a successful HTTP response. */
export async function readOwnedCommentAcceptanceBody(request: Request, maximum: number): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const scope = ownedCommentAcceptanceBody(request), reader = scope.body.getReader();
  const parts: Uint8Array[] = []; let size = 0, cause: unknown, failed = false;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      if (next.value.byteLength > maximum - size)
        throw new HTTPException(413, { message: "The Comment request exceeds its byte limit" });
      parts.push(next.value); size += next.value.byteLength;
    }
  } catch (error) { failed = true; cause = error; }
  const failures: unknown[] = [];
  if (failed) { try { await reader.cancel(cause); } catch (error) { failures.push(error); } }
  try { await scope.dispose(cause); } catch (error) { failures.push(error); }
  try { reader.releaseLock(); } catch (error) { failures.push(error); }
  if (failures.length) {
    let retained!: Promise<void>;
    const failure = new StorageProfileCleanupError(cause,
      new AggregateError(failures, "Original Comment bounded ingress cleanup failed"), {
        owner: Object.freeze({ request, scope, reader }), dispose: () => retained,
      });
    retained = Promise.reject(failure); retained.then(() => undefined, () => undefined); throw failure;
  }
  if (failed) throw cause;
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes.buffer;
}
