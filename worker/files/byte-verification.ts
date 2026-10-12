import type { ByteReader } from "./byte-reader";

export const MAX_VERIFIED_BYTES = 100 * 1024 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;
export interface ByteExpectation { byteSize: number; sha256: string }
export interface VerifiedBytes extends ByteExpectation {}
export interface Sha256Sink {
  write(bytes: Uint8Array): Promise<void>;
  finish(): Promise<string>;
  abort(): Promise<void>;
}
export type Sha256Factory = () => Sha256Sink;
export type VerificationPhase = "source" | "destination";
export type VerificationReason = "invalid_expectation" | "size_mismatch"
  | "hash_mismatch" | "unavailable" | "incomplete";

/** View existing owned bytes without Response's ArrayBuffer body copy. */
export function bufferByteStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === buffer.byteLength) { controller.close(); return; }
    const length = Math.min(HASH_CHUNK_BYTES, buffer.byteLength - offset);
    controller.enqueue(new Uint8Array(buffer, offset, length));
    offset += length;
  } }, { highWaterMark: 0 });
}

export class ByteVerificationError extends Error {
  constructor(readonly phase: VerificationPhase, readonly reason: VerificationReason, options?: ErrorOptions) {
    super(phase === "source" && reason === "size_mismatch"
      ? "Attachment size changed during upload"
      : phase === "source" && reason === "hash_mismatch"
        ? "Attachment checksum changed during upload"
        : "File bytes could not be verified. Retry later.", options);
    this.name = "ByteVerificationError";
  }
}

export function validateByteExpectation(expected: ByteExpectation, phase: VerificationPhase) {
  if (!Number.isSafeInteger(expected.byteSize) || expected.byteSize < 0
    || expected.byteSize > MAX_VERIFIED_BYTES || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new ByteVerificationError(phase, "invalid_expectation");
  }
}

// Exact failed verification owners remain private. These promises are cleanup
// outcomes, never byte evidence or permission to retry an original operation.
const failedVerifications = new Set<object>();
const constructionCleanups = new WeakMap<ByteVerificationError, () => Promise<void>>();
export function disposeByteVerificationFailure(error: unknown): Promise<void> | undefined {
  return error instanceof ByteVerificationError ? constructionCleanups.get(error)?.() : undefined;
}
function cleanupFailure(failures: unknown[], message: string): unknown {
  const distinct = [...new Set(failures)];
  return distinct.length === 1 ? distinct[0] : new AggregateError(distinct, message);
}
function workAndCleanup(work: unknown, cleanup: unknown): unknown {
  return work === cleanup ? work : new AggregateError([work, cleanup], "Byte verification work and cleanup failed");
}
function failure(error: unknown, phase: VerificationPhase) {
  return error instanceof ByteVerificationError ? error : new ByteVerificationError(phase, "unavailable", { cause: error });
}

/** A single backpressured consumer, without tee or whole-object accumulation.
 * Holds the upstream chunk and at most one 64 KiB hash write at a time. The
 * upstream producer still owns its chunk allocation. Evidence exists only at
 * successful EOF; it does not pin an object version or publish File identity.
 */
export function verifyingStream(
  input: ReadableStream<Uint8Array>, expected: ByteExpectation,
  createHash: Sha256Factory, phase: VerificationPhase,
) {
  validateByteExpectation(expected, phase);
  const reader = input.getReader();
  let hash: Sha256Sink;
  try { hash = createHash(); } catch (cause) {
    const error = new ByteVerificationError(phase, "unavailable", { cause });
    let closing: Promise<void> | undefined;
    const owner = { input, reader, cause, close: (): Promise<void> => closing ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      try { await reader.cancel(); } catch (cleanup) { failures.push(cleanup); }
      try { reader.releaseLock(); } catch (cleanup) { failures.push(cleanup); }
      if (failures.length) {
        failedVerifications.add(owner);
        throw cleanupFailure(failures, "Byte verification construction cleanup failed");
      }
    }) };
    constructionCleanups.set(error, owner.close);
    // Observe the original promise even if a caller discards the constructor
    // rejection; the actual caller can still await this same first outcome.
    void owner.close().catch(() => undefined);
    throw error;
  }
  let byteSize = 0;
  let evidence: VerifiedBytes | undefined;
  let error: unknown;
  let released = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const release = () => {
    if (!released) { reader.releaseLock(); released = true; }
  };
  let disposing: Promise<void> | undefined;
  const owner = { input, reader, hash, close: (): Promise<void> => dispose() };
  const dispose: () => Promise<void> = () => disposing ??= Promise.resolve().then(async () => {
    if (evidence) return;
    error ??= new ByteVerificationError(phase, "incomplete");
    const failures: unknown[] = [];
    try { controller?.error(error); } catch (cleanup) { failures.push(cleanup); }
    // Invoke each original cleanup exactly once, retaining synchronous throws
    // and awaiting both native outcomes before releasing the reader lock.
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => reader.cancel()), Promise.resolve().then(() => hash.abort()),
    ]);
    for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
    try { release(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length) {
      failedVerifications.add(owner);
      throw cleanupFailure(failures, "Byte verification cleanup failed");
    }
  });
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull(output) {
      try {
        const next = await reader.read();
        if (error) return;
        if (next.done) {
          if (byteSize !== expected.byteSize) throw new ByteVerificationError(phase, "size_mismatch");
          const sha256 = await hash.finish();
          if (error) return;
          if (sha256 !== expected.sha256) throw new ByteVerificationError(phase, "hash_mismatch");
          release();
          evidence = { sha256, byteSize };
          output.close();
          return;
        }
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) throw new ByteVerificationError(phase, "unavailable");
        if (chunk.byteLength > expected.byteSize - byteSize) {
          throw new ByteVerificationError(phase, "size_mismatch");
        }
        byteSize += chunk.byteLength;
        for (let offset = 0; offset < chunk.byteLength; offset += HASH_CHUNK_BYTES) {
          await hash.write(chunk.subarray(offset, offset + HASH_CHUNK_BYTES));
          if (error) return;
        }
        output.enqueue(chunk);
      } catch (cause) {
        error ??= failure(cause, phase);
        try { await dispose(); }
        catch (cleanup) { error = workAndCleanup(error, cleanup); }
      }
    },
    cancel: dispose,
  }, { highWaterMark: 0 });
  return {
    body, dispose,
    result(): VerifiedBytes {
      if (error) throw error;
      if (!evidence) throw new ByteVerificationError(phase, "incomplete");
      return evidence;
    },
  };
}

export async function verifyByteStream(
  input: ReadableStream<Uint8Array>, expected: ByteExpectation,
  createHash: Sha256Factory, phase: VerificationPhase,
): Promise<VerifiedBytes> {
  let verified: ReturnType<typeof verifyingStream>;
  try { verified = verifyingStream(input, expected, createHash, phase); }
  catch (error) {
    const originalCleanup = disposeByteVerificationFailure(error) ?? input.cancel();
    try { await originalCleanup; }
    catch (cleanup) {
      failedVerifications.add({ input, expected, createHash, error, originalCleanup, cleanup });
      throw workAndCleanup(error, cleanup);
    }
    throw error;
  }
  const reader = verified.body.getReader();
  let result: VerifiedBytes | undefined, rejected = false, workError: unknown;
  try {
    while (!(await reader.read()).done) { /* hash sink consumes bounded chunks */ }
    result = verified.result();
  } catch (error) { rejected = true; workError = failure(error, phase); }
  const failures: unknown[] = [];
  try { await verified.dispose(); } catch (cleanup) { failures.push(cleanup); }
  try { reader.releaseLock(); } catch (cleanup) { failures.push(cleanup); }
  if (failures.length) {
    const cleanup = cleanupFailure(failures, "Byte verification consumer cleanup failed");
    throw rejected ? workAndCleanup(workError, cleanup) : cleanup;
  }
  if (rejected) throw workError;
  return result!;
}

export async function verifyStoredBytes(
  reader: Pick<ByteReader, "read">, key: string, expected: ByteExpectation,
  createHash: Sha256Factory,
): Promise<VerifiedBytes> {
  validateByteExpectation(expected, "destination");
  let result;
  try { result = await reader.read(key); }
  catch (error) { throw new ByteVerificationError("destination", "unavailable", { cause: error }); }
  if (result.outcome !== "available") throw new ByteVerificationError("destination", "unavailable");
  return verifyByteStream(result.body, expected, createHash, "destination");
}
