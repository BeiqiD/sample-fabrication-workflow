import { HTTPException } from "hono/http-exception";
import { FABUBLOX_IMPORT_REQUEST_HEADER, normalizeFabubloxImportRequestId } from "../../shared/contracts/fabublox-import";
import { MAX_FABUBLOX_IMPORT_BODY_BYTES, prepareFabubloxPayloadFromForm, type PreparedFabubloxPayload } from "../../worker/imports/fabublox-payload";
import { contentLengthWithin } from "../../worker/request-guards";

/** Failure of the original reader cancellation/release is retained. A failed
 * parser or an HTTP response is not permission to guess another cleanup ACK. */
export class FabubloxMultipartBodyCleanupError extends AggregateError {
  declare readonly retainedOwners: readonly unknown[];
  constructor(errors: readonly unknown[], owners: readonly unknown[]) {
    super(errors, "Original FabuBlox multipart body cleanup failed");
    this.name = "FabubloxMultipartBodyCleanupError";
    Object.defineProperty(this, "retainedOwners", { value: Object.freeze([...owners]) });
  }
}
type Owner = {
  readonly request: Request;
  readonly operations: Set<Promise<unknown>>;
  readonly chunks: ArrayBuffer[];
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  decoder?: Response;
  prepared?: Promise<PreparedFabubloxPayload & { requestId: string }>;
  closing?: Promise<void>;
  cancellation?: Promise<void>;
  originalCancellation?: Promise<void>;
  failure?: FabubloxMultipartBodyCleanupError;
  stopping: boolean;
  cancelAttempted: boolean;
  releaseAttempted: boolean;
};
const issued = new WeakMap<Request, object>();
const retained = new Set<Owner>();
/** Verify the exact neutral owner before a host adopts its cached first close.
 * Copied facades and caller promises cannot satisfy original body custody. */
export function assertRetainedFabubloxMultipartBodyOwner(request:Request,body:object):void {
  if(issued.get(request)!==body)throw new Error("Original FabuBlox body ownership is unavailable");
}
const tooLarge = () => new HTTPException(413, { message: "FabuBlox imports are limited to 50 MB" });
const stopped = () => new Error("Original FabuBlox body preparation is stopping");

/** Unmounted byte/parser owner only. It consumes this exact original Request,
 * never a cloned/reissued Request. The private Response decodes already owned
 * multipart bytes using only the original Content-Type. It supplies no actor,
 * current session, grant, File profile, receipt, provider or SQL capability.
 * A later authorized host must retain this owner before awaiting preparation,
 * then await its one original close before releasing its own native/lease. */
export function createRetainedFabubloxMultipartBody(request: Request) {
  const previous = issued.get(request);
  if (previous) throw new Error("Original FabuBlox body owner is already issued");
  if (request.bodyUsed || request.body?.locked) throw new Error("Original FabuBlox body is already owned");
  const owner: Owner = { request, operations: new Set(), chunks: [], stopping: false,
    cancelAttempted: false, releaseAttempted: false };
  const stopReason = () => request.signal.aborted ? request.signal.reason : stopped();
  function observe<T>(original: Promise<T>): Promise<T> {
    owner.operations.add(original);
    void original.catch(() => undefined); // Observe the original rejection without replacing it.
    return original;
  }
  function cancelOriginal(): Promise<void> {
    if (owner.cancellation) return owner.cancellation;
    if (owner.cancelAttempted) throw new Error("Original FabuBlox cancellation acknowledgement is unavailable");
    let resolveFirst!: () => void, rejectFirst!: (reason: unknown) => void;
    const reservation = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    owner.cancellation = reservation;
    void reservation.catch(() => undefined);
    // Publish and observe the first reservation before the sole actual method
    // invocation. Its synchronous cancel callback may abort this same Request;
    // that reentry receives this reservation, never another method attempt.
    owner.cancelAttempted = true;
    let original: Promise<void>;
    try { original = owner.reader ? owner.reader.cancel(stopReason()) : request.body?.cancel(stopReason()) ?? Promise.resolve(); }
    catch (error) { original = Promise.reject(error); }
    owner.originalCancellation = original;
    void original.catch(() => undefined);
    void original.then(resolveFirst, rejectFirst); // Exact original ACK/rejection, including falsy causes.
    return reservation;
  }
  function releaseOriginal() {
    if (!owner.reader || owner.releaseAttempted) return;
    owner.releaseAttempted = true;
    owner.reader.releaseLock();
  }
  // A single whole operation is reserved before invoking any body method.
  // Part reads, hashes, concurrent image operations and decoder delivery are
  // retained before awaits. Whole preparation cannot settle ahead of a late
  // original part operation, even when original Promise.all rejects early.
  const preparation = Promise.resolve().then(async () => {
    let failed = false, cause: unknown;
    let result: (PreparedFabubloxPayload & { requestId: string }) | undefined;
    try {
      const rawRequestId = request.headers.get(FABUBLOX_IMPORT_REQUEST_HEADER);
      if (!rawRequestId) throw new HTTPException(428, { message: "Refresh this page before importing a workbook." });
      const requestId = normalizeFabubloxImportRequestId(rawRequestId);
      if (!requestId) throw new HTTPException(400, { message: "Invalid import request identity" });
      if (!contentLengthWithin(request, MAX_FABUBLOX_IMPORT_BODY_BYTES)) throw tooLarge();
      if (owner.stopping) throw stopReason();
      if (request.body) owner.reader = request.body.getReader();
      let bytes = 0;
      if (owner.reader) {
        while (true) {
          if (owner.stopping) throw stopReason();
          const originalRead = observe(owner.reader.read());
          const next = await originalRead;
          if (owner.stopping) throw stopReason();
          if (next.done) break;
          if (!(next.value instanceof Uint8Array)) throw new TypeError("Invalid original multipart byte chunk");
          // Count actual wire bytes before retaining/materializing a chunk.
          if (next.value.byteLength > MAX_FABUBLOX_IMPORT_BODY_BYTES - bytes) throw tooLarge();
          bytes += next.value.byteLength;
          owner.chunks.push(Uint8Array.from(next.value).buffer);
        }
      }
      const headers = new Headers();
      const contentType = request.headers.get("content-type");
      if (contentType !== null) headers.set("content-type", contentType);
      owner.decoder = new Response(new Blob(owner.chunks), { headers });
      const originalForm = observe(owner.decoder.formData());
      const form = await originalForm;
      if (owner.stopping) throw stopReason();
      const originalPayload = observe(prepareFabubloxPayloadFromForm(form, { retain: original => { observe(original); } }));
      const payload = await originalPayload;
      if (owner.stopping) throw stopReason();
      result = { ...payload, requestId };
    } catch (error) { failed = true; cause = error; }
    const settled = await Promise.allSettled([...owner.operations]);
    if (failed) {
      const errors: unknown[] = [cause];
      for (const outcome of settled) if (outcome.status === "rejected" && !errors.includes(outcome.reason)) errors.push(outcome.reason);
      if (errors.length > 1) throw new AggregateError(errors, "Original FabuBlox payload preparation failed");
      throw cause; // Including an original falsy rejection.
    }
    if (result === undefined) throw new Error("Original FabuBlox preparation result is unavailable");
    return result;
  });
  owner.prepared = preparation;
  void preparation.catch(() => undefined);
  const facade = Object.freeze({
    prepared: preparation,
    close(): Promise<void> {
      if (owner.closing) return owner.closing;
      owner.stopping = true;
      // Register cached close before any cancellation method is invoked.
      owner.closing = Promise.resolve().then(async () => {
        let cancellationFailed = false, cancellationCause: unknown;
        try { await cancelOriginal(); }
        catch (error) { cancellationFailed = true; cancellationCause = error; }
        // Preparation retains all late decoder/part operations. Its work
        // rejection remains in the original prepared promise, independently
        // of a successful original body cleanup acknowledgement.
        await Promise.allSettled([preparation]);
        await Promise.allSettled([...owner.operations]);
        const errors: unknown[] = cancellationFailed ? [cancellationCause] : [];
        try { releaseOriginal(); } catch (error) { errors.push(error); }
        request.signal.removeEventListener("abort", aborted);
        if (errors.length) {
          owner.failure = new FabubloxMultipartBodyCleanupError(errors,
            [owner, request, owner.reader, owner.decoder, preparation, owner.cancellation, owner.originalCancellation]);
          throw owner.failure;
        }
        owner.chunks.length = 0;
        retained.delete(owner);
      });
      void owner.closing.catch(() => undefined);
      return owner.closing;
    },
  });
  issued.set(request, facade); retained.add(owner);
  function aborted() {
    owner.stopping = true;
    void cancelOriginal().catch(() => undefined); // Its first rejecting promise remains retained for close.
  }
  request.signal.addEventListener("abort", aborted, { once: true });
  if (request.signal.aborted) aborted();
  return facade;
}
