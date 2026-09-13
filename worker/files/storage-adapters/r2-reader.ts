import { observedByteSize, type ByteMetadata, type ByteReader } from "../byte-reader";

// Only standard object metadata crosses this boundary. Route-owned security,
// disposition and cache policy are still applied after the read is authorized.
const HTTP_METADATA = [
  "content-type", "content-language", "content-disposition", "content-encoding",
  "cache-control", "expires",
] as const;

function metadata(object: Pick<R2Object, "writeHttpMetadata" | "httpEtag">): ByteMetadata {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const httpMetadata: Record<string, string> = {};
  for (const name of HTTP_METADATA) {
    const value = headers.get(name);
    if (value !== null) httpMetadata[name] = value;
  }
  return {
    contentType: headers.get("content-type") || "application/octet-stream",
    etag: object.httpEtag || null,
    httpMetadata,
  };
}

/** The supplied binding is the instance. Its label is not a persisted namespace. */
export function r2ByteReader(bucket: Pick<R2Bucket, "get" | "head">): ByteReader {
  return {
    async read(key) {
      let body: ReadableStream | undefined;
      try {
        const object = await bucket.get(key);
        if (!object) return { outcome: "missing" };
        body = object.body;
        return { outcome: "available", body, ...metadata(object) };
      } catch {
        // A response opened before malformed metadata failed is not handed off.
        await body?.cancel().catch(() => undefined);
        return { outcome: "unavailable" };
      }
    },
    async stat(key) {
      try {
        const object = await bucket.head(key);
        if (!object) return { outcome: "missing" };
        return { outcome: "available", byteSize: observedByteSize(object.size), ...metadata(object) };
      } catch {
        return { outcome: "unavailable" };
      }
    },
  };
}
