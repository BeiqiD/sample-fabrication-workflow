import type { ByteWriter } from "../byte-writer";
import { ByteVerificationError } from "../byte-verification";

/** Current R2 callers already own bounded buffers. Streaming R2 uploads need
 * separately qualified known-length plumbing before this capability expands. */
export function r2ByteWriter(bucket: Pick<R2Bucket, "put">): ByteWriter {
  return {
    accepts: "buffer",
    async write(input) {
      if (!(input.body instanceof ArrayBuffer)) throw new ByteVerificationError("source", "invalid_expectation");
      try {
        await bucket.put(input.key, input.body, { httpMetadata: { contentType: input.contentType } });
      } catch { throw new ByteVerificationError("destination", "unavailable"); }
    },
  };
}
