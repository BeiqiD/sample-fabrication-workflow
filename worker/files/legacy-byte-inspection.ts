import type { ByteReader } from "./byte-reader";
import {
  ByteVerificationError,
  MAX_VERIFIED_BYTES,
  type Sha256Factory,
  type Sha256Sink,
} from "./byte-verification";

export type LegacyRecoveryExpectation = { byteSize: number; sha256: string | null };
export type LegacyRecoveryByteInspection =
  | { outcome: "available"; byteSize: number; sha256: string }
  | { outcome: "missing" }
  | { outcome: "size_mismatch"; observedByteSize: number };

/** Recovery alone may discover an absent historical hash. Existing expected
 * length is still required and never replaced by the observed length. A known
 * hash is compared only after complete EOF. Hashing owns no object-sized copy:
 * one upstream chunk is consumed through sequential writes of at most 64 KiB.
 * On an overlong stream, observedByteSize is the bytes seen before cancellation,
 * not a claim about the total provider object length.
 */
export async function inspectLegacyRecoveryBytes(
  storage: Pick<ByteReader, "read">,
  key: string,
  expected: LegacyRecoveryExpectation,
  createHash: Sha256Factory,
): Promise<LegacyRecoveryByteInspection> {
  if (!Number.isSafeInteger(expected.byteSize) || expected.byteSize < 0
    || expected.byteSize > MAX_VERIFIED_BYTES
    || (expected.sha256 !== null && !/^[a-f0-9]{64}$/.test(expected.sha256))) {
    throw new ByteVerificationError("destination", "invalid_expectation");
  }
  let opened;
  try { opened = await storage.read(key); }
  catch { throw new ByteVerificationError("destination", "unavailable"); }
  if (opened.outcome === "missing") return { outcome: "missing" };
  if (opened.outcome !== "available") throw new ByteVerificationError("destination", "unavailable");

  let reader: ReadableStreamDefaultReader | undefined;
  let hash: Sha256Sink | undefined;
  let complete = false;
  try {
    reader = opened.body.getReader();
    hash = createHash();
    let byteSize = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) {
        if (byteSize !== expected.byteSize) {
          return { outcome: "size_mismatch", observedByteSize: byteSize };
        }
        const sha256 = await hash.finish();
        if (!/^[a-f0-9]{64}$/.test(sha256)) {
          throw new ByteVerificationError("destination", "unavailable");
        }
        if (expected.sha256 !== null && sha256 !== expected.sha256) {
          throw new ByteVerificationError("destination", "hash_mismatch");
        }
        complete = true;
        return { outcome: "available", sha256, byteSize };
      }
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) throw new ByteVerificationError("destination", "unavailable");
      if (chunk.byteLength > expected.byteSize - byteSize) {
        return { outcome: "size_mismatch", observedByteSize: byteSize + chunk.byteLength };
      }
      byteSize += chunk.byteLength;
      for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
        await hash.write(chunk.subarray(offset, offset + 64 * 1024));
      }
    }
  } catch (error) {
    // Provider, stream and digest exceptions never become persisted diagnostics.
    throw error instanceof ByteVerificationError
      ? error : new ByteVerificationError("destination", "unavailable");
  } finally {
    if (!complete) {
      await Promise.allSettled([
        Promise.resolve().then(() => reader ? reader.cancel() : opened.body.cancel()),
        Promise.resolve().then(() => hash?.abort()),
      ]);
    }
    reader?.releaseLock();
  }
}
