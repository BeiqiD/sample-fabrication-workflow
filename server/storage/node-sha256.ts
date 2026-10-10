import { createHash, type Hash } from "node:crypto";
import type { Sha256Factory } from "../../worker/files/byte-verification";

/** Server-only incremental sink. No object-sized buffering or Worker globals. */
export const nodeSha256: Sha256Factory = () => {
  let hash: Hash | null = createHash("sha256");
  return {
    async write(bytes) {
      if (!hash) throw new Error("SHA-256 sink is closed");
      hash.update(bytes);
    },
    async finish() {
      if (!hash) throw new Error("SHA-256 sink is closed");
      const result = hash.digest("hex");
      hash = null;
      return result;
    },
    async abort() { hash = null; },
  };
};
