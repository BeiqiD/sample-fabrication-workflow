import { checkedSaveStorageCandidateInput, type S3StorageCredentials, type S3StorageNamespace } from "../../shared/contracts/storage-configuration";
import type { ByteDeleter } from "../files/byte-deleter";
import type { ByteMetadata, ByteReader, ByteReadFailure } from "../files/byte-reader";
import { ByteVerificationError, validateByteExpectation } from "../files/byte-verification";
import type { ByteWriteInput, ByteWriter } from "../files/byte-writer";

export interface S3ByteAdapter { reader: ByteReader; writer: ByteWriter; deleter: ByteDeleter }
export interface S3ByteAdapterOptions {
  fetch?: (request: Request) => Promise<Response>;
  now?: () => Date;
}
export class S3StorageUnavailableError extends Error {
  constructor() { super("S3 storage is unavailable."); this.name = "S3StorageUnavailableError"; }
}
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
const uri = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
async function hmac(key: string | ArrayBuffer, value: string): Promise<ArrayBuffer> {
  const bytes = typeof key === "string" ? encoder.encode(key) : new Uint8Array(key);
  try {
    const imported = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return await crypto.subtle.sign("HMAC", imported, encoder.encode(value));
  } finally { bytes.fill(0); }
}
function objectUrl(namespace: S3StorageNamespace, key: string): URL {
  if (typeof key !== "string" || !key || key.length > 4096 || key.includes("\0")
    || decoder.decode(encoder.encode(key)) !== key || key.split("/").some(part => part === "." || part === "..")) throw new S3StorageUnavailableError();
  // Fetch's URL parser normalizes dot segments even when percent-encoded.
  // Reject those unsupported keys rather than address a different S3 object.
  const url = new URL(namespace.endpoint);
  if (!namespace.forcePathStyle) url.hostname = `${namespace.bucket}.${url.hostname}`;
  // Endpoint prefixes must obey the same SigV4 escaping, including uppercase
  // escapes, while preserving escaped slashes within a path segment.
  const prefix = url.pathname.replace(/\/+$/, "").split("/").map(part => uri(decodeURIComponent(part))).join("/");
  url.pathname = `${prefix}/${namespace.forcePathStyle ? `${uri(namespace.bucket)}/` : ""}${namespace.root ? `${namespace.root.split("/").map(uri).join("/")}/` : ""}${key.split("/").map(uri).join("/")}`;
  return url;
}
function failure(status: number): ByteReadFailure {
  return status === 404 ? { outcome: "missing" } : status === 401 || status === 403 ? { outcome: "denied", status } : { outcome: "unavailable" };
}
function metadata(response: Response): ByteMetadata {
  return { contentType: response.headers.get("content-type") || "application/octet-stream", etag: response.headers.get("etag"), httpMetadata: {} };
}
async function discard(response: Response) { await response.body?.cancel().catch(() => undefined); }

/** One supplied S3 instance, with no database, role selection, credential
 * discovery, retries, multipart upload or activation. The owner must establish
 * its provider account/namespace and exact configuration before using it.
 *
 * A PUT is one SigV4 signed payload with a known whole-object SHA-256, not the
 * AWS chunk-signing protocol. Existing writeVerifiedBytes still owns source
 * validation and complete destination readback; ETags never prove File hashes.
 * Signing rules: AWS S3 developerguide/sig-v4-header-based-auth.html.
 */
export function s3ByteAdapter(rawNamespace: S3StorageNamespace, rawCredentials: S3StorageCredentials,
  options: S3ByteAdapterOptions = {}): S3ByteAdapter {
  let namespace: S3StorageNamespace, credentials: S3StorageCredentials;
  try {
    const checked = checkedSaveStorageCandidateInput({ expectedRevision: null, label: "S3 transport", namespace: rawNamespace,
      credentials: { mode: "replace", value: rawCredentials } });
    if (checked.namespace.kind !== "s3" || checked.credentials.mode !== "replace" || !("accessKeyId" in checked.credentials.value)) throw new Error();
    namespace = checked.namespace; credentials = checked.credentials.value;
  } catch { throw new S3StorageUnavailableError(); }
  const send = options.fetch ?? (request => fetch(request)), now = options.now ?? (() => new Date());
  async function request(method: "GET" | "HEAD" | "PUT" | "DELETE", key: string, payloadHash = EMPTY_SHA256,
    body?: ArrayBuffer | ReadableStream, contentType?: string, signal?: AbortSignal): Promise<Response> {
    const url = objectUrl(namespace, key), timestamp = now().toISOString().replace(/[:-]|\.\d{3}/g, ""), date = timestamp.slice(0, 8);
    const headers = new Headers({ host: url.host, "x-amz-date": timestamp, "x-amz-content-sha256": payloadHash, "accept-encoding": "identity" });
    if (namespace.expectedBucketOwner) headers.set("x-amz-expected-bucket-owner", namespace.expectedBucketOwner);
    if (credentials.sessionToken) headers.set("x-amz-security-token", credentials.sessionToken);
    if (contentType) headers.set("content-type", contentType);
    const signed = ["host", "x-amz-content-sha256", "x-amz-date", ...(namespace.expectedBucketOwner ? ["x-amz-expected-bucket-owner"] : []),
      ...(credentials.sessionToken ? ["x-amz-security-token"] : []), ...(contentType ? ["content-type"] : [])].sort();
    const canonical = [method, url.pathname, "", signed.map(name => `${name}:${headers.get(name)!.trim().replace(/\s+/g, " ")}\n`).join(""), signed.join(";"), payloadHash].join("\n");
    const scope = `${date}/${namespace.region}/s3/aws4_request`;
    const signingKey = await hmac(await hmac(await hmac(await hmac(`AWS4${credentials.secretAccessKey}`, date), namespace.region), "s3"), "aws4_request");
    const signature = hex(await hmac(signingKey, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)))}`));
    headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`);
    return send(new Request(url, { method, headers, body, signal, redirect: "manual", cache: "no-store" }));
  }
  const reader: ByteReader = {
    async read(key) {
      let response: Response | undefined;
      try {
        response = await request("GET", key);
        if (response.redirected || response.status !== 200 || !response.body) { const result = response.redirected ? { outcome: "unavailable" as const } : failure(response.status); await discard(response); return result; }
        return { outcome: "available", body: response.body, ...metadata(response) };
      } catch { if (response) await discard(response); return { outcome: "unavailable" }; }
    },
    async stat(key) {
      let response: Response | undefined;
      try {
        response = await request("HEAD", key);
        if (response.redirected || response.status !== 200) return response.redirected ? { outcome: "unavailable" } : failure(response.status);
        const raw = response.headers.get("content-length"), size = raw !== null && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : NaN;
        return { outcome: "available", byteSize: Number.isSafeInteger(size) ? size : null, ...metadata(response) };
      } catch { return { outcome: "unavailable" }; }
      finally { if (response) await discard(response); }
    },
  };
  const writer: ByteWriter = {
    accepts: "both",
    async write(input: ByteWriteInput) {
      let source: ReadableStreamDefaultReader<Uint8Array> | undefined, output: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView> | undefined;
      let fixed: FixedLengthStream | undefined, stopped = false, ended = false;
      const abort = new AbortController();
      try {
        validateByteExpectation(input, "source");
        if (input.body instanceof ArrayBuffer) {
          if (input.body.byteLength !== input.byteSize) throw new ByteVerificationError("source", "size_mismatch");
          const response = await request("PUT", input.key, input.sha256, input.body, input.contentType, abort.signal);
          try { if (response.redirected || ![200, 201, 204].includes(response.status)) throw new ByteVerificationError("destination", "unavailable"); }
          finally { await discard(response); }
          return;
        }
        fixed = new FixedLengthStream(input.byteSize); source = input.body.getReader(); output = fixed.writable.getWriter();
        const incoming = source, outgoing = output;
        const pumping = (async () => {
          let observed = 0;
          while (!stopped) {
            const next = await incoming.read();
            if (stopped) return;
            if (next.done) {
              if (observed !== input.byteSize) throw new ByteVerificationError("source", "size_mismatch");
              ended = true; await outgoing.close(); return;
            }
            if (!(next.value instanceof Uint8Array)) throw new ByteVerificationError("source", "unavailable");
            if (next.value.byteLength > input.byteSize - observed) throw new ByteVerificationError("source", "size_mismatch");
            observed += next.value.byteLength; await outgoing.write(next.value);
          }
        })();
        const putting = (async () => {
          const response = await request("PUT", input.key, input.sha256, fixed!.readable, input.contentType, abort.signal);
          try {
            if (response.redirected || ![200, 201, 204].includes(response.status)) throw new ByteVerificationError("destination", "unavailable");
            if (!ended) throw new ByteVerificationError("source", "incomplete");
          } finally { await discard(response); }
        })();
        await Promise.all([pumping, putting]);
      } catch (error) {
        stopped = true; abort.abort();
        const cancellation = source ? source.cancel() : input.body instanceof ArrayBuffer ? Promise.resolve() : input.body.cancel();
        if (output) void output.abort().catch(() => undefined);
        if (fixed && !fixed.readable.locked) await fixed.readable.cancel().catch(() => undefined);
        await cancellation.catch(() => undefined);
        throw error instanceof ByteVerificationError ? error : new ByteVerificationError("destination", "unavailable");
      } finally { source?.releaseLock(); output?.releaseLock(); }
    },
  };
  const deleter: ByteDeleter = {
    async delete(key) {
      let response: Response | undefined;
      try {
        response = await request("DELETE", key);
        if (response.redirected) return { outcome: "unavailable" };
        if ([200, 204, 404].includes(response.status)) return { outcome: "acknowledged" };
        return response.status === 401 || response.status === 403 ? { outcome: "denied", status: response.status } : { outcome: "unavailable" };
      } catch { return { outcome: "unavailable" }; }
      finally { if (response) await discard(response); }
    },
  };
  return { reader, writer, deleter };
}
