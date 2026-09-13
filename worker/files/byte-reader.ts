/** Read-only transport for one already-bound storage instance.
 *
 * The caller owns authorization, locator selection and retention. An available
 * stream or provider size/ETag is not verified File identity. This boundary only
 * supports full-object reads: no range, conditional request, checksum, retry or
 * fallback guarantee is implied. Successful reads transfer stream ownership to
 * the caller, including cancellation and errors that occur after opening it.
 */
export interface ByteMetadata {
  contentType: string;
  etag: string | null;
  httpMetadata: Readonly<Record<string, string>>;
}

export type ByteReadFailure =
  | { outcome: "missing" }
  | { outcome: "denied"; status: 401 | 403 }
  | { outcome: "unavailable" };

export type ByteReadResult = ByteReadFailure
  | ({ outcome: "available"; body: ReadableStream } & ByteMetadata);

export type ByteStatResult = ByteReadFailure
  | ({ outcome: "available"; byteSize: number | null } & ByteMetadata);

export interface ByteReader {
  read(key: string): Promise<ByteReadResult>;
  stat(key: string): Promise<ByteStatResult>;
}

export function observedByteSize(size: unknown): number | null {
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null;
}
