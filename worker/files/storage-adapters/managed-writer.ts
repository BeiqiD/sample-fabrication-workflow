import type { ManagedStorage } from "../../managed-storage";
import type { ByteWriter } from "../byte-writer";
import { ByteVerificationError, bufferByteStream } from "../byte-verification";

export function managedByteWriter(storage: Pick<ManagedStorage, "put">): ByteWriter {
  return {
    accepts: "both",
    async write(input) {
      let stored;
      try {
        stored = await storage.put({ key: input.key,
          body: input.body instanceof ArrayBuffer ? bufferByteStream(input.body) : input.body,
          byteSize: input.byteSize, sha256: input.sha256,
          contentType: input.contentType, filename: input.filename });
      } catch { throw new ByteVerificationError("destination", "unavailable"); }
      if (stored.byteSize !== input.byteSize) throw new ByteVerificationError("destination", "size_mismatch");
    },
  };
}
