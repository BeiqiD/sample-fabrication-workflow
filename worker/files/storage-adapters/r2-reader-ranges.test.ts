import { describe, expect, it, vi } from "vitest";
import { r2ByteReader } from "./r2-reader";
const metadata = { size: 100, range: { offset: 7, length: 11 }, httpEtag: '"opaque"', writeHttpMetadata(headers: Headers) { headers.set("content-type", "application/zip"); } };
describe("R2 exact-range reader", () => {
  it("issues only an exact range on the captured opaque object key without buffering", async () => {
    const pull = vi.fn(), body = new ReadableStream({ pull }, { highWaterMark: 0 });
    const get = vi.fn(async () => ({ ...metadata, body })), reader = r2ByteReader({ get } as unknown as R2Bucket);
    const result = await reader.readRange!("raw/%2F/a//b", { offset: 7, length: 11 });
    expect(get).toHaveBeenCalledExactlyOnceWith("raw/%2F/a//b", { range: { offset: 7, length: 11 } }); expect(pull).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "available", byteSize: 100, range: { offset: 7, length: 11 }, contentType: "application/zip" });
    if (result.outcome !== "available") throw new Error("range unavailable"); await result.body.cancel();
  });
  it.each([undefined, { offset: 0, length: 100 }, { offset: 7, length: 10 }])("closes an ignored or mismatched range %j", async range => {
    const cancelled = vi.fn(), body = new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 });
    const reader = r2ByteReader({ get: async () => ({ ...metadata, range, body }) } as unknown as R2Bucket);
    expect(await reader.readRange!("object", { offset: 7, length: 11 })).toEqual({ outcome: "unavailable" }); expect(cancelled).toHaveBeenCalledOnce();
  });
  it.each([{ offset: -1, length: 2 }, { offset: 0, length: 0 }, { offset: 0.5, length: 1 }, { offset: Number.MAX_SAFE_INTEGER, length: 2 }])("rejects invalid ranges before I/O %j", async range => {
    const get = vi.fn(), reader = r2ByteReader({ get } as unknown as R2Bucket);
    expect(await reader.readRange!("object", range)).toEqual({ outcome: "unavailable" }); expect(get).not.toHaveBeenCalled();
  });
  it("keeps missing/provider errors distinct and exposes late stream errors", async () => {
    const missing = r2ByteReader({ get: async () => null } as unknown as R2Bucket);
    expect(await missing.readRange!("object", { offset: 7, length: 11 })).toEqual({ outcome: "missing" });
    const unavailable = r2ByteReader({ get: async () => { throw new Error("secret endpoint"); } } as unknown as R2Bucket);
    expect(await unavailable.readRange!("object", { offset: 7, length: 11 })).toEqual({ outcome: "unavailable" });
    const reader = r2ByteReader({ get: async () => ({ ...metadata, body: new ReadableStream({ pull(controller) { controller.error(new Error("interrupted")); } }) }) } as unknown as R2Bucket);
    const result = await reader.readRange!("object", { offset: 7, length: 11 });
    if (result.outcome !== "available") throw new Error("range unavailable"); await expect(new Response(result.body).arrayBuffer()).rejects.toThrow("interrupted");
  });
});
