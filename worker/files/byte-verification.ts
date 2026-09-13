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
  constructor(readonly phase: VerificationPhase, readonly reason: VerificationReason) {
    super(phase === "source" && reason === "size_mismatch"
      ? "Attachment size changed during upload"
      : phase === "source" && reason === "hash_mismatch"
        ? "Attachment checksum changed during upload"
        : "File bytes could not be verified. Retry later.");
    this.name = "ByteVerificationError";
  }
}

export function validateByteExpectation(expected: ByteExpectation, phase: VerificationPhase) {
  if (!Number.isSafeInteger(expected.byteSize) || expected.byteSize < 0
    || expected.byteSize > MAX_VERIFIED_BYTES || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new ByteVerificationError(phase, "invalid_expectation");
  }
}

function failure(error: unknown, phase: VerificationPhase) {
  return error instanceof ByteVerificationError ? error : new ByteVerificationError(phase, "unavailable");
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
  try { hash = createHash(); } catch {
    void reader.cancel().catch(() => undefined).finally(() => reader.releaseLock());
    throw new ByteVerificationError(phase, "unavailable");
  }
  let byteSize = 0;
  let evidence: VerifiedBytes | undefined;
  let error: ByteVerificationError | undefined;
  let released = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const release = () => {
    if (!released) { reader.releaseLock(); released = true; }
  };
  const dispose = async () => {
    if (evidence) return;
    error ??= new ByteVerificationError(phase, "incomplete");
    controller?.error(error);
    await Promise.allSettled([reader.cancel(), hash.abort()]);
    release();
  };
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
          evidence = { sha256, byteSize };
          release();
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
        await dispose();
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
  catch (error) { await input.cancel().catch(() => undefined); throw error; }
  const reader = verified.body.getReader();
  try {
    while (!(await reader.read()).done) { /* hash sink consumes bounded chunks */ }
    return verified.result();
  } catch (error) {
    throw failure(error, phase);
  } finally {
    await verified.dispose();
    reader.releaseLock();
  }
}

export async function verifyStoredBytes(
  reader: Pick<ByteReader, "read">, key: string, expected: ByteExpectation,
  createHash: Sha256Factory,
): Promise<VerifiedBytes> {
  validateByteExpectation(expected, "destination");
  let result;
  try { result = await reader.read(key); }
  catch { throw new ByteVerificationError("destination", "unavailable"); }
  if (result.outcome !== "available") throw new ByteVerificationError("destination", "unavailable");
  return verifyByteStream(result.body, expected, createHash, "destination");
}
