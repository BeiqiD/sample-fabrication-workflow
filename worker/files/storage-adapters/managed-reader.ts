import type { ManagedStorage } from "../../managed-storage";
import { SwitchdriveAuthenticationError } from "../../switchdrive-storage";
import { observedByteSize, type ByteMetadata, type ByteReader, type ByteReadFailure } from "../byte-reader";

function failure(error: unknown): ByteReadFailure {
  return error instanceof SwitchdriveAuthenticationError
    ? { outcome: "denied", status: error.status }
    : { outcome: "unavailable" };
}

function metadata(object: { contentType: string; etag: string | null }): ByteMetadata {
  return { contentType: object.contentType, etag: object.etag, httpMetadata: {} };
}

/** Compatibility adapter for a supplied, already-selected managed instance.
 * Provider-specific errors stay here; credentials, URLs and arbitrary messages
 * are not part of the transport result. No new defaults are consulted on reads.
 */
export function managedByteReader(storage: Pick<ManagedStorage, "get" | "stat">): ByteReader {
  return {
    async read(key) {
      let body: ReadableStream | undefined;
      try {
        const object = await storage.get(key);
        if (!object) return { outcome: "missing" };
        body = object.body;
        return { outcome: "available", body, ...metadata(object) };
      } catch (error) {
        await body?.cancel().catch(() => undefined);
        return failure(error);
      }
    },
    async stat(key) {
      try {
        const object = await storage.stat(key);
        if (!object) return { outcome: "missing" };
        return { outcome: "available", byteSize: observedByteSize(object.byteSize), ...metadata(object) };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
