import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { S3StorageNamespace } from "../../shared/contracts/storage-configuration";
import { ByteVerificationError } from "../files/byte-verification";
import { s3ByteAdapter, S3StorageUnavailableError } from "./s3-byte-adapter";

const namespace: S3StorageNamespace = { kind: "s3", endpoint: "https://s3.amazonaws.com", bucket: "examplebucket",
  region: "us-east-1", root: "", forcePathStyle: false };
// Public AWS example credentials, never installation credentials.
const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const now = () => new Date("2013-05-24T00:00:00.000Z");
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const signature = (request: Request) => request.headers.get("authorization")!.split("Signature=")[1];

describe("isolated S3 SigV4 byte transport", () => {
  // Independent fixtures generated with Python hashlib/hmac. That calculation
  // first reproduced AWS's published range-GET signature f0e8bdb8...6bdb41,
  // then removed Range for this full-object reader and signed the requests below.
  // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  it("signs a full-object virtual-host GET with independently checked SigV4", async () => {
    const send = vi.fn(async (_request: Request) => new Response("bytes"));
    const adapter = s3ByteAdapter(namespace, credentials, { fetch: send, now });
    const result = await adapter.reader.read("test.txt");
    expect(result.outcome).toBe("available");
    if (result.outcome !== "available") throw new Error("Expected a byte stream");
    expect(await new Response(result.body).text()).toBe("bytes");
    const request = send.mock.calls[0][0];
    expect(request.url).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
    expect(request.method).toBe("GET");
    expect(request.headers.get("x-amz-content-sha256")).toBe(emptyHash);
    expect(request.headers.get("x-amz-date")).toBe("20130524T000000Z");
    expect(signature(request)).toBe("df548e2ce037944d03f3e68682813b093763996d597cf890ca3d9037fd231eb4");
    expect(request.redirect).toBe("manual");
    expect(request.headers.has("range")).toBe(false);
    expect(request.headers.has("x-amz-security-token")).toBe(false);
    expect(request.headers.has("x-amz-expected-bucket-owner")).toBe(false);
  });

  it("signs exact payload SHA and content type for buffered PUT without trusting an ETag", async () => {
    const send = vi.fn(async (request: Request) => {
      expect(await request.text()).toBe("Welcome to Amazon S3.");
      return new Response(null, { status: 200, headers: { etag: '"opaque-provider-etag"' } });
    });
    const adapter = s3ByteAdapter(namespace, credentials, { fetch: send, now });
    await adapter.writer.write({ key: "test$file.text", body: new TextEncoder().encode("Welcome to Amazon S3.").buffer,
      byteSize: 21, sha256: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      contentType: "text/plain; charset=utf-8", filename: "test$file.text" });
    const request = send.mock.calls[0][0];
    expect(request.url).toBe("https://examplebucket.s3.amazonaws.com/test%24file.text");
    expect(signature(request)).toBe("96b5940a1337b6d3e9c5481a4fc27d441dde7a815b37916534911ce08bf05e3f");
    expect(request.headers.get("authorization")).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps opaque Unicode, percent, punctuation and repeated slashes exact under root and path-style bucket", async () => {
    const send = vi.fn(async (_request: Request) => new Response("bytes"));
    const adapter = s3ByteAdapter({ ...namespace, endpoint: "https://s3.example.test:9443/gateway%20prefix",
      bucket: "data-bucket", root: "研究 root/%literal+segment", forcePathStyle: true },
    { ...credentials, sessionToken: "fixture/token+==" }, { fetch: send, now });
    const result = await adapter.reader.read("研究//literal%2F+?#/'!*().txt");
    if (result.outcome === "available") await result.body.cancel();
    const request = send.mock.calls[0][0];
    expect(request.url).toBe("https://s3.example.test:9443/gateway%20prefix/data-bucket/%E7%A0%94%E7%A9%B6%20root/%25literal%2Bsegment/%E7%A0%94%E7%A9%B6//literal%252F%2B%3F%23/%27%21%2A%28%29.txt");
    expect(request.headers.get("x-amz-security-token")).toBe("fixture/token+==");
    expect(request.headers.get("authorization")).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
    expect(signature(request)).toBe("c1d7ff35157a5589a1404f2df1d56482bc4e89a38a63e4eacff9e0cc8bc23399");
  });

  it("encodes an endpoint path prefix with the same AWS URI rules as object keys", async () => {
    const send = vi.fn(async (_request: Request) => new Response(null, { headers: { "content-length": "0" } }));
    const adapter = s3ByteAdapter({ ...namespace, endpoint: "https://s3.example.test/gateway$api/%2flower", forcePathStyle: true }, credentials, { fetch: send, now });
    await adapter.reader.stat("test.txt");
    expect(send.mock.calls[0][0].url).toBe("https://s3.example.test/gateway%24api/%2Flower/examplebucket/test.txt");
  });

  it("sends and signs the expected AWS owner on GET, HEAD, PUT and DELETE", async () => {
    const send = vi.fn(async (_request: Request) => new Response("", { headers: { "content-length": "0" } }));
    const adapter = s3ByteAdapter({ ...namespace, expectedBucketOwner: "123456789012" }, credentials, { fetch: send, now });
    const result = await adapter.reader.read("test.txt");
    if (result.outcome === "available") await result.body.cancel();
    expect(result.outcome).toBe("available");
    expect(await adapter.reader.stat("test.txt")).toMatchObject({ outcome: "available", byteSize: 0 });
    await adapter.writer.write({ key: "test.txt", body: new ArrayBuffer(0), byteSize: 0, sha256: emptyHash,
      contentType: "application/octet-stream", filename: "test.txt" });
    expect(await adapter.deleter.delete("test.txt")).toEqual({ outcome: "acknowledged" });
    // Independent Python hashlib/hmac fixtures using the public AWS credentials
    // above. The owner must affect the signature, not only the outgoing headers.
    const signatures = ["1728e8b3863c59e08a349e5b099c75cd4900432d5f185e8bffb69a053dd3cd70",
      "9d1816da2b04c0d8340d0134d3844ecb7960369cdfbe0590ec024fdc39fe1781",
      "0020e8be876acfa47a353a13c7270a6d12a08bd8eddd7661a5896f70e0656e03",
      "f09cfff0e2f8eada99b7bf6556d7f0b8683470a49912977e41b6f794114d7ead"];
    expect(send.mock.calls.map(([request]) => request.method)).toEqual(["GET", "HEAD", "PUT", "DELETE"]);
    send.mock.calls.forEach(([request], index) => {
      expect(request.headers.get("x-amz-expected-bucket-owner")).toBe("123456789012");
      expect(request.headers.get("authorization")).toContain("x-amz-date;x-amz-expected-bucket-owner");
      expect(signature(request)).toBe(signatures[index]);
      expect(request.redirect).toBe("manual");
    });
  });

  it.each([403, 301, 307])("does not retry, redirect or drop the owner after provider status %i", async status => {
    const cancelled = vi.fn();
    const send = vi.fn(async (_request: Request) => new Response(new ReadableStream({ cancel: cancelled }), {
      status, headers: { location: "https://alternate.s3.amazonaws.com/test.txt" },
    }));
    const adapter = s3ByteAdapter({ ...namespace, expectedBucketOwner: "123456789012" }, credentials, { fetch: send, now });
    const failure = status === 403 ? { outcome: "denied", status } : { outcome: "unavailable" };
    expect(await adapter.reader.read("test.txt")).toEqual(failure);
    expect(await adapter.reader.stat("test.txt")).toEqual(failure);
    await expect(adapter.writer.write({ key: "test.txt", body: new ArrayBuffer(0), byteSize: 0, sha256: emptyHash,
      contentType: "application/octet-stream", filename: "test.txt" })).rejects.toEqual(new ByteVerificationError("destination", "unavailable"));
    expect(await adapter.deleter.delete("test.txt")).toEqual(failure);
    expect(send).toHaveBeenCalledTimes(4);
    expect(cancelled).toHaveBeenCalledTimes(4);
    for (const [request] of send.mock.calls) {
      expect(request.url).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("x-amz-expected-bucket-owner")).toBe("123456789012");
    }
  });

  it("rejects an owner constraint on generic S3 before issuing any request", () => {
    const send = vi.fn();
    expect(() => s3ByteAdapter({ ...namespace, endpoint: "https://objects.example.test", expectedBucketOwner: "123456789012" }, credentials, { fetch: send }))
      .toThrow(S3StorageUnavailableError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([".", "..", "folder/../file", "folder/./file", "\ud800", "bad\0key", ""])("rejects keys which cannot be addressed exactly before I/O: %j", async key => {
    const send = vi.fn(async (_request: Request) => new Response("unexpected"));
    const adapter = s3ByteAdapter(namespace, credentials, { fetch: send, now });
    expect(await adapter.reader.read(key)).toEqual({ outcome: "unavailable" });
    expect(await adapter.deleter.delete(key)).toEqual({ outcome: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([404, 401, 403, 301, 302, 307, 206, 429, 500])("maps read, stat and delete status %i without following or leaking provider errors", async status => {
    const cancelled = vi.fn();
    const send = vi.fn(async (_request: Request) => new Response(new ReadableStream({ cancel: cancelled }), {
      status, headers: { location: "https://untrusted.example.test", "content-type": "application/xml" },
    }));
    const adapter = s3ByteAdapter(namespace, credentials, { fetch: send, now });
    const failure = status === 404 ? { outcome: "missing" } : [401, 403].includes(status) ? { outcome: "denied", status } : { outcome: "unavailable" };
    expect(await adapter.reader.read("key")).toEqual(failure);
    expect(await adapter.reader.stat("key")).toEqual(failure);
    expect(await adapter.deleter.delete("key")).toEqual(status === 404 ? { outcome: "acknowledged" } : failure);
    expect(send).toHaveBeenCalledTimes(3);
    expect(cancelled).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.every(([request]) => request.redirect === "manual")).toBe(true);
  });

  it("returns advisory metadata, transfers the success stream, and discards HEAD/DELETE bodies", async () => {
    const cancelled = vi.fn();
    const send = vi.fn(async (_request: Request) => new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { "content-length": "23", "content-type": "image/tiff", etag: '"multipart-opaque-5"' },
    }));
    const adapter = s3ByteAdapter(namespace, credentials, { fetch: send, now });
    expect(await adapter.reader.stat("key")).toEqual({ outcome: "available", byteSize: 23,
      contentType: "image/tiff", etag: '"multipart-opaque-5"', httpMetadata: {} });
    const read = await adapter.reader.read("key");
    expect(read).toMatchObject({ outcome: "available", contentType: "image/tiff", etag: '"multipart-opaque-5"' });
    expect(cancelled).toHaveBeenCalledTimes(1);
    if (read.outcome === "available") await read.body.cancel();
    expect(await adapter.deleter.delete("key")).toEqual({ outcome: "acknowledged" });
    expect(cancelled).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([request]) => request.method)).toEqual(["HEAD", "GET", "DELETE"]);
  });

  it("sanitizes network/configuration failures and rejects invalid buffer size before PUT", async () => {
    const send = vi.fn(async (_request: Request): Promise<Response> => { throw new Error(`${credentials.secretAccessKey} private error`); });
    const adapter = s3ByteAdapter(namespace, credentials, { fetch: send, now });
    expect(await adapter.reader.read("key")).toEqual({ outcome: "unavailable" });
    expect(await adapter.reader.stat("key")).toEqual({ outcome: "unavailable" });
    expect(await adapter.deleter.delete("key")).toEqual({ outcome: "unavailable" });
    const input = { key: "key", body: new ArrayBuffer(0), byteSize: 0, sha256: emptyHash, contentType: "application/octet-stream", filename: "key" };
    await expect(adapter.writer.write(input)).rejects.toEqual(new ByteVerificationError("destination", "unavailable"));
    expect(send).toHaveBeenCalledTimes(4);
    await expect(adapter.writer.write({ ...input, byteSize: 1 })).rejects.toEqual(new ByteVerificationError("source", "size_mismatch"));
    expect(send).toHaveBeenCalledTimes(4);
    expect(() => s3ByteAdapter({ ...namespace, endpoint: `https://${credentials.secretAccessKey}@invalid.example.test` }, credentials))
      .toThrow(new S3StorageUnavailableError());
  });
});

describe("native Worker S3 streaming", () => {
  it("sends known-length bytes and cancels rejected, abandoned, short and oversized streams", async () => {
    const bundled = await build({ stdin: { loader: "ts", resolveDir: fileURLToPath(new URL(".", import.meta.url)), contents: `
      import { s3ByteAdapter } from './s3-byte-adapter';
      const heldReaders = [];
      export default { async fetch(request) {
        const input = await request.json();
        let calls = 0, pulls = 0, cancelled = 0, aborted = false, offset = 0;
        const chunks = input.chunks.map(text => new TextEncoder().encode(text));
        const source = new ReadableStream({ pull(controller) {
          pulls++;
          if (offset < chunks.length) controller.enqueue(chunks[offset++]);
          else controller.close();
        }, cancel() { cancelled++; } }, { highWaterMark: 0 });
        const adapter = s3ByteAdapter(${JSON.stringify(namespace)}, ${JSON.stringify(credentials)}, {
          now: () => new Date('2013-05-24T00:00:00Z'),
          fetch: async request => {
            calls++; request.signal.addEventListener('abort', () => { aborted = true; });
            if (input.mode === 'reject') throw new Error('private network detail');
            if (input.mode === 'abandoned') { heldReaders.push(request.body.getReader()); throw new Error('private abandoned detail'); }
            if (input.mode === 'early') return new Response(null, { status: 200 });
            if (input.mode === 'consume') { await request.arrayBuffer(); return new Response(null, { status: 200 }); }
            return fetch(request);
          }
        });
        let error = null;
        try { await adapter.writer.write({ key: 'native.bin', body: source, byteSize: input.byteSize,
          sha256: 'a'.repeat(64), contentType: 'application/octet-stream', filename: 'native.bin' }); }
        catch (caught) { error = { name: caught.name, phase: caught.phase, reason: caught.reason, message: caught.message }; }
        return Response.json({ error, calls, pulls, cancelled, aborted, locked: source.locked });
      } };` }, bundle: true, format: "esm", platform: "browser", write: false });
    const outgoing: { length: string | null; bytes: number[]; transferEncoding: string | null }[] = [];
    const native = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-07-20",
      log: new Log(LogLevel.ERROR), outboundService: async request => {
        outgoing.push({ length: request.headers.get("content-length"), transferEncoding: request.headers.get("transfer-encoding"),
          bytes: Array.from(new Uint8Array(await request.arrayBuffer())) });
        return new Response(null, { status: 200 });
      } });
    const invoke = async (mode: string, chunks: string[], byteSize: number) => {
      const response = await native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify({ mode, chunks, byteSize }), signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ error: { name: string; phase: string; reason: string; message: string } | null;
        calls: number; pulls: number; cancelled: number; aborted: boolean; locked: boolean }>;
    };
    try {
      expect(await invoke("network", ["one", "", "二", "three"], 11)).toMatchObject({ error: null, calls: 1, cancelled: 0, locked: false });
      expect(outgoing).toEqual([{ length: "11", transferEncoding: null, bytes: Array.from(new TextEncoder().encode("one二three")) }]);
      expect(await invoke("network", [], 0)).toMatchObject({ error: null, calls: 1, locked: false });
      expect(outgoing[1]).toEqual({ length: "0", transferEncoding: null, bytes: [] });
      for (const mode of ["reject", "abandoned", "early"]) {
        const result = await invoke(mode, ["one", "two", "unread tail"], 17);
        expect(result).toMatchObject({ calls: 1, cancelled: 1, aborted: true, locked: false,
          error: { name: "ByteVerificationError", phase: mode === "early" ? "source" : "destination", reason: mode === "early" ? "incomplete" : "unavailable" } });
        expect(JSON.stringify(result)).not.toContain("private");
      }
      expect(await invoke("consume", ["short"], 6)).toMatchObject({ locked: false, error: { phase: "source", reason: "size_mismatch" } });
      expect(await invoke("consume", ["too long", "unread tail"], 3)).toMatchObject({ cancelled: 1, locked: false, error: { phase: "source", reason: "size_mismatch" } });
      expect(outgoing).toHaveLength(2);
    } finally { await native.dispose(); }
  }, 30_000);
});
