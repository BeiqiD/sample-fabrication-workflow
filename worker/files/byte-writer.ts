import type { ByteReader } from "./byte-reader";
import {
  ByteVerificationError, bufferByteStream, validateByteExpectation, verifyByteStream,
  verifyStoredBytes, verifyingStream, type ByteExpectation, type Sha256Factory,
} from "./byte-verification";

export interface ByteWriteInput extends ByteExpectation {
  key: string;
  body: ArrayBuffer | ReadableStream<Uint8Array>;
  contentType: string;
  filename: string;
}
/** Acknowledged transport only. Registration, verification and deletion belong
 * to the caller. An exception may follow a committed write; never replay it or
 * delete the key automatically. Capabilities describe the adapter, not a role.
 */
export interface ByteWriter {
  readonly accepts: "buffer" | "stream" | "both";
  write(input: ByteWriteInput): Promise<void>;
}

export async function writeVerifiedBytes(
  storage: { reader: Pick<ByteReader, "read">; writer: ByteWriter; createHash: Sha256Factory },
  input: ByteWriteInput,
) {
  const buffered = input.body instanceof ArrayBuffer;
  let source: ReturnType<typeof verifyingStream> | undefined;
  try {
    validateByteExpectation(input, "source");
    if (storage.writer.accepts !== "both"
      && storage.writer.accepts !== (buffered ? "buffer" : "stream")) {
      throw new ByteVerificationError("source", "invalid_expectation");
    }
    if (buffered) {
      await verifyByteStream(bufferByteStream(input.body as ArrayBuffer), input, storage.createHash, "source");
    } else {
      source = verifyingStream(input.body as ReadableStream<Uint8Array>, input, storage.createHash, "source");
    }
    try { await storage.writer.write({ ...input, body: source?.body ?? input.body }); }
    catch (error) {
      // Prefer a definite source mismatch observed by the forwarding stream to
      // the generic network rejection caused by that stream failing.
      if (source) {
        try { source.result(); } catch (sourceError) {
          if (sourceError instanceof ByteVerificationError
            && ["size_mismatch", "hash_mismatch"].includes(sourceError.reason)) throw sourceError;
        }
      }
      throw error instanceof ByteVerificationError ? error : new ByteVerificationError("destination", "unavailable");
    }
    source?.result(); // An early acknowledgement cannot certify an unread body.
    return await verifyStoredBytes(storage.reader, input.key, input, storage.createHash);
  } finally {
    if (source) await source.dispose();
    else if (!buffered) await (input.body as ReadableStream<Uint8Array>).cancel().catch(() => undefined);
  }
}
