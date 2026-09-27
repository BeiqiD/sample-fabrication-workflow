import type { ByteWriter } from "../byte-writer";
import { ByteVerificationError, validateByteExpectation } from "../byte-verification";

/** Shadow copies own bounded streams, unlike the original buffered upload
 * adapter. R2 requires a stream whose length is known by workerd. Retain
 * backpressure through FixedLengthStream and cancel the source on failure;
 * a failed acknowledgement never authorizes another PUT or a DELETE. */
export function r2ShadowByteWriter(bucket: Pick<R2Bucket, "put">): ByteWriter {
  return {
    accepts: "both",
    async write(input) {
      const { key, body, contentType, byteSize, sha256 } = input;
      try { validateByteExpectation({ byteSize, sha256 }, "source"); }
      catch (error) {
        if (!(body instanceof ArrayBuffer)) await body.cancel().catch(() => undefined);
        throw error;
      }
      if (body instanceof ArrayBuffer) {
        if (body.byteLength !== byteSize) throw new ByteVerificationError("source", "size_mismatch");
        try { await bucket.put(key, body, { httpMetadata: { contentType } }); }
        catch { throw new ByteVerificationError("destination", "unavailable"); }
        return;
      }
      let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let output: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView> | undefined;
      let fixed: FixedLengthStream | undefined;
      let stopped = false;
      try {
        fixed = new FixedLengthStream(byteSize);
        source = body.getReader();
        output = fixed.writable.getWriter();
        const reader = source, writer = output;
        const pumping = (async () => {
          let observed = 0;
          while (!stopped) {
            const next = await reader.read();
            if (stopped) return;
            if (next.done) {
              if (observed !== byteSize) throw new ByteVerificationError("source", "size_mismatch");
              await writer.close();
              return;
            }
            const chunk = next.value;
            if (!(chunk instanceof Uint8Array)) throw new ByteVerificationError("source", "unavailable");
            if (chunk.byteLength > byteSize - observed) throw new ByteVerificationError("source", "size_mismatch");
            observed += chunk.byteLength;
            await writer.write(chunk);
          }
        })();
        const readable = fixed.readable;
        const putting = Promise.resolve().then(() => bucket.put(key, readable, { httpMetadata: { contentType } }));
        await Promise.all([pumping, putting]);
      }
      catch (error) {
        stopped = true;
        // Keep the upstream reader under our control. pipeTo's cancellation
        // waits behind an in-flight write and can deadlock when PUT rejects
        // while retaining its readable lock. No more chunks may be written.
        const cancellation = source ? source.cancel() : body.cancel();
        // Abort signals errors to a still-consuming provider. If it abandoned
        // a locked reader, this abort may wait forever for its pending write;
        // observe its rejection without making cleanup depend on that reader.
        if (output) void output.abort().catch(() => undefined);
        if (fixed && !fixed.readable.locked) await fixed.readable.cancel().catch(() => undefined);
        await cancellation.catch(() => undefined);
        throw error instanceof ByteVerificationError ? error : new ByteVerificationError("destination", "unavailable");
      } finally {
        source?.releaseLock();
        output?.releaseLock();
      }
    },
  };
}
