import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { BlobLocator } from "../blob-lifecycle/types";
import { getBlob, statBlob } from "../blob-lifecycle/storage";
import { SwitchdriveAuthenticationError } from "../switchdrive-storage";
import { legacyByteReader } from "./legacy-byte-reader";
import { managedByteReader } from "./storage-adapters/managed-reader";
import { r2ByteReader } from "./storage-adapters/r2-reader";

afterEach(() => vi.unstubAllGlobals());

const locator: BlobLocator = { storeKind: "r2", provider: "r2", objectKey: "raw/%2F/a//b", blobRecordId: "legacy-asset" };
const metadata = {
  size: 4,
  httpEtag: '"not-a-sha256"',
  writeHttpMetadata(headers: Headers) {
    headers.set("content-type", "text/plain");
    headers.set("content-encoding", "gzip");
    headers.set("content-language", "zh");
    headers.set("expires", "Wed, 01 Jan 2031 00:00:00 GMT");
    headers.set("content-disposition", "inline");
    headers.set("cache-control", "public, max-age=3600");
    headers.set("set-cookie", "must-not-be-forwarded=1");
  },
};

describe("instance-bound full-object byte readers", () => {
  it("preserves R2 streams, opaque keys and allowed HTTP metadata without buffering or pre-reading", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode("test"));
      controller.close();
    });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const get = vi.fn(async () => ({ ...metadata, body }));
    const head = vi.fn(async () => metadata);
    const reader = r2ByteReader({ get, head } as unknown as Pick<R2Bucket, "get" | "head">);
    const result = await reader.read(locator.objectKey);
    expect(get).toHaveBeenCalledExactlyOnceWith(locator.objectKey);
    expect(head).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "available", contentType: "text/plain", etag: '"not-a-sha256"' });
    if (result.outcome !== "available") throw new Error("Expected stream");
    expect(result.body).toBe(body);
    expect(result.httpMetadata).toEqual({
      "content-type": "text/plain", "content-encoding": "gzip", "content-language": "zh",
      "expires": "Wed, 01 Jan 2031 00:00:00 GMT", "content-disposition": "inline", "cache-control": "public, max-age=3600",
    });
    expect(result).not.toHaveProperty("sha256");
    expect(await new Response(result.body).text()).toBe("test");
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it.each(["r2", "managed"])("hands %s stream cancellation to its consumer", async (kind) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel }, { highWaterMark: 0 });
    const reader = kind === "r2"
      ? r2ByteReader({ get: async () => ({ ...metadata, body }) } as unknown as R2Bucket)
      : managedByteReader({ get: async () => ({ body, contentType: "text/plain", etag: null }), stat: vi.fn() });
    const result = await reader.read("literal-key");
    expect(result.outcome).toBe("available");
    expect(cancel).not.toHaveBeenCalled();
    if (result.outcome !== "available") throw new Error("Expected stream");
    await result.body.cancel("caller stopped");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("caller stopped");
  });

  it("keeps a late stream failure visible rather than returning truncated success", async () => {
    const body = new ReadableStream({ pull(controller) { controller.error(new Error("interrupted")); } }, { highWaterMark: 0 });
    const reader = managedByteReader({ get: async () => ({ body, contentType: "text/plain", etag: null }), stat: vi.fn() });
    const result = await reader.read("key");
    expect(result.outcome).toBe("available");
    if (result.outcome !== "available") throw new Error("Expected stream");
    await expect(new Response(result.body).text()).rejects.toThrow("interrupted");
  });

  it("releases an R2 body when metadata prevents a handoff and hides provider detail", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const reader = r2ByteReader({ get: async () => ({
      body, writeHttpMetadata() { throw new Error("private provider endpoint and credentials"); },
    }) } as unknown as R2Bucket);
    await expect(reader.read("key")).resolves.toEqual({ outcome: "unavailable" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([0, 17, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "4"])(
    "keeps untrustworthy provider length %s unknown", async (size) => {
      const expected = typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null;
      const r2 = r2ByteReader({ head: async () => ({ ...metadata, size }) } as unknown as R2Bucket);
      const managed = managedByteReader({ get: vi.fn(), stat: async () => ({ byteSize: size as number, contentType: "text/plain", etag: null }) });
      expect(await r2.stat("key")).toMatchObject({ outcome: "available", byteSize: expected });
      expect(await managed.stat("key")).toMatchObject({ outcome: "available", byteSize: expected });
    },
  );

  it.each(["read", "stat"] as const)("distinguishes missing, denied and unavailable on %s", async (method) => {
    for (const error of [null, new SwitchdriveAuthenticationError(401), new SwitchdriveAuthenticationError(403), new Error("secret upstream URL")]) {
      const operation = vi.fn(async () => { if (error) throw error; return null; });
      const reader = managedByteReader({ get: operation, stat: operation });
      const expected = error instanceof SwitchdriveAuthenticationError ? { outcome: "denied", status: error.status }
        : error ? { outcome: "unavailable" } : { outcome: "missing" };
      expect(await reader[method]("opaque-key")).toEqual(expected);
      expect(operation).toHaveBeenCalledExactlyOnceWith("opaque-key");
    }
    for (const error of [null, new Error("secret R2 detail")]) {
      const operation = vi.fn(async () => { if (error) throw error; return null; });
      const reader = r2ByteReader({ get: operation, head: operation } as unknown as R2Bucket);
      expect(await reader[method]("key")).toEqual({ outcome: error ? "unavailable" : "missing" });
      expect(operation).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps two supplied same-kind instances separate", async () => {
    const first = managedByteReader({ get: async () => ({ body: new Response("first").body!, contentType: "text/plain", etag: null }), stat: vi.fn() });
    const second = managedByteReader({ get: async () => ({ body: new Response("second").body!, contentType: "text/plain", etag: null }), stat: vi.fn() });
    const a = await first.read("same-key");
    const b = await second.read("same-key");
    if (a.outcome !== "available" || b.outcome !== "available") throw new Error("Expected streams");
    expect(await new Response(a.body).text()).toBe("first");
    expect(await new Response(b.body).text()).toBe("second");
  });
});

describe("historical locator composition", () => {
  it.each([
    { storeKind: "r2", provider: "switchdrive" },
    { storeKind: "managed", provider: "r2" },
    { storeKind: "managed", provider: "unknown" },
    { storeKind: "unknown", provider: "r2" },
  ])("rejects mismatched locators without touching any binding: %j", async (identity) => {
    const env = new Proxy({} as Env, { get() { throw new Error("No binding should be consulted"); } });
    const invalid = { ...locator, ...identity } as BlobLocator;
    expect(legacyByteReader(env, invalid)).toEqual({ outcome: "provider_unavailable", message: "File storage locator is invalid" });
    expect(await getBlob(env, invalid)).toMatchObject({ outcome: "provider_unavailable" });
    expect(await statBlob(env, invalid)).toMatchObject({ outcome: "provider_unavailable" });
  });

  it("never falls back to R2 when the recorded managed provider is unconfigured", async () => {
    const get = vi.fn();
    const head = vi.fn();
    const env = { ASSETS: { get, head } } as unknown as Env;
    const managed = { ...locator, storeKind: "managed", provider: "switchdrive" } as BlobLocator;
    await expect(getBlob(env, managed)).resolves.toEqual({ outcome: "provider_unavailable", message: "Managed storage is not configured" });
    await expect(statBlob(env, managed)).resolves.toMatchObject({ outcome: "provider_unavailable" });
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });

  it("does not resolve managed configuration to read R2 and returns safe failure text", async () => {
    const operation = vi.fn(async () => { throw new Error("signed-provider-url?secret=private"); });
    const env = {
      ASSETS: { get: operation, head: operation },
      get MANAGED_STORAGE_PROVIDER() { throw new Error("Unrelated provider"); },
    } as unknown as Env;
    await expect(getBlob(env, locator)).resolves.toEqual({ outcome: "provider_unavailable", message: "R2 is unavailable" });
    await expect(statBlob(env, locator)).resolves.toEqual({ outcome: "provider_unavailable", message: "R2 is unavailable" });
  });

  it("keeps managed denials unavailable in the old result contract without exposing provider errors", async () => {
    const fetchMock = vi.fn(async () => new Response("private upstream detail", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user",
      SWITCHDRIVE_USERNAME: "user", SWITCHDRIVE_APP_PASSWORD: "secret", SWITCHDRIVE_ROOT: "root",
    } as Env;
    const managed = { ...locator, objectKey: "key", storeKind: "managed", provider: "switchdrive" } as BlobLocator;
    await expect(getBlob(env, managed)).resolves.toEqual({ outcome: "provider_unavailable", message: "Managed storage is unavailable" });
    await expect(statBlob(env, managed)).resolves.toEqual({ outcome: "provider_unavailable", message: "Managed storage is unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
