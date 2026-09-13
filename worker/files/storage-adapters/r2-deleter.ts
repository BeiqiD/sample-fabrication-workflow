import type { ByteDeleter } from "../byte-deleter";

/** R2's resolved delete promise acknowledges deletion, including absent keys.
 * A rejection is uncertain; it must never be interpreted as proof of no effect.
 */
export function r2ByteDeleter(bucket: Pick<R2Bucket, "delete">): ByteDeleter {
  return {
    async delete(key) {
      try {
        await bucket.delete(key);
        return { outcome: "acknowledged" };
      } catch {
        return { outcome: "unavailable" };
      }
    },
  };
}
