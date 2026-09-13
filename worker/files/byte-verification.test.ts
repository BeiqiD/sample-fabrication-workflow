import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ByteVerificationError, MAX_VERIFIED_BYTES, bufferByteStream, verifyByteStream, verifyStoredBytes } from "./byte-verification";
import { writeVerifiedBytes, type ByteWriteInput, type ByteWriter } from "./byte-writer";
import { cloudflareSha256 } from "./storage-adapters/cloudflare-sha256";
import { r2ByteWriter } from "./storage-adapters/r2-writer";

const bytes = new TextEncoder().encode("verified bytes — 文件");
const expected = (value = bytes) => ({ byteSize: value.byteLength,
  sha256: createHash("sha256").update(value).digest("hex") });
const stream = (value = bytes) => new Response(value).body!;
const input = (body: ByteWriteInput["body"] = bytes.buffer): ByteWriteInput => ({
  ...expected(), key: "opaque/key", body, contentType: "application/octet-stream", filename: "source.bin",
});
function fixture(options: { destination?: Uint8Array; consume?: boolean; loseResponse?: boolean } = {}) {
  const read = vi.fn(async () => ({ outcome: "available" as const,
    body: stream(options.destination), contentType: "application/octet-stream", etag: expected().sha256, httpMetadata: {} }));
  const write = vi.fn(async (request: ByteWriteInput) => {
    if (!(request.body instanceof ArrayBuffer) && options.consume !== false) {
      const reader = request.body.getReader();
      try { while (!(await reader.read()).done) { /* consume without retaining */ } }
      finally { reader.releaseLock(); }
    }
    if (options.loseResponse) throw new Error("private credentials and provider URL");
  });
  return { reader: { read }, writer: { accepts: "both", write } satisfies ByteWriter, createHash: cloudflareSha256 };
}

describe("full-object byte verification", () => {
  it("hashes owned buffers through bounded views without making an object-sized copy", async () => {
    const buffer = new Uint8Array(200_000).fill(7).buffer;
    const reader = bufferByteStream(buffer).getReader();
    let count = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.buffer).toBe(buffer);
      expect(next.value.byteOffset).toBe(count);
      expect(next.value.byteLength).toBeLessThanOrEqual(64 * 1024);
      count += next.value.byteLength;
    }
    expect(count).toBe(buffer.byteLength);
    reader.releaseLock();
  });
  it.each(["buffer", "stream"] as const)("checks source and destination for %s writes", async kind => {
    const storage = fixture();
    const result = await writeVerifiedBytes(storage, input(kind === "buffer" ? bytes.buffer : stream()));
    expect(result).toEqual(expected());
    expect(storage.writer.write).toHaveBeenCalledOnce();
    expect(storage.reader.read).toHaveBeenCalledExactlyOnceWith("opaque/key");
  });

  it("accepts empty content only after successful EOF and the empty hash", async () => {
    expect(await verifyByteStream(stream(new Uint8Array()), expected(new Uint8Array()), cloudflareSha256, "source"))
      .toEqual(expected(new Uint8Array()));
  });

  it.each(["size_mismatch", "hash_mismatch"] as const)("rejects source %s before buffer PUT", async reason => {
    const storage = fixture();
    const request = { ...input(), ...(reason === "size_mismatch" ? { byteSize: bytes.length - 1 } : { sha256: "0".repeat(64) }) };
    await expect(writeVerifiedBytes(storage, request)).rejects.toMatchObject({ phase: "source", reason });
    expect(storage.writer.write).not.toHaveBeenCalled();
    expect(storage.reader.read).not.toHaveBeenCalled();
  });

  it.each(["size_mismatch", "hash_mismatch"] as const)("rejects streamed source %s and never verifies/publishes destination", async reason => {
    const storage = fixture();
    const request = { ...input(stream()), ...(reason === "size_mismatch" ? { byteSize: bytes.length - 1 } : { sha256: "0".repeat(64) }) };
    await expect(writeVerifiedBytes(storage, request)).rejects.toMatchObject({ phase: "source", reason });
    expect(storage.writer.write).toHaveBeenCalledOnce();
    expect(storage.reader.read).not.toHaveBeenCalled();
  });

  it("does not certify a provider acknowledgement that leaves the source unread", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(bytes); }, cancel }, { highWaterMark: 0 });
    const storage = fixture({ consume: false });
    await expect(writeVerifiedBytes(storage, input(source))).rejects.toMatchObject({ phase: "source", reason: "incomplete" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(storage.reader.read).not.toHaveBeenCalled();
  });

  it("does not replay an uncertain PUT or inspect destination after a lost response", async () => {
    const storage = fixture({ loseResponse: true });
    await expect(writeVerifiedBytes(storage, input(stream()))).rejects.toEqual(new ByteVerificationError("destination", "unavailable"));
    expect(storage.writer.write).toHaveBeenCalledOnce();
    expect(storage.reader.read).not.toHaveBeenCalled();
  });

  it("rejects same-size changed destination even when ETag equals the claimed SHA", async () => {
    const storage = fixture({ destination: bytes.map(byte => byte ^ 1) });
    await expect(writeVerifiedBytes(storage, input())).rejects.toMatchObject({ phase: "destination", reason: "hash_mismatch" });
  });

  it.each([0, bytes.length - 1, bytes.length + 1])("rejects destination length %i", async size => {
    const storage = fixture({ destination: new Uint8Array(size) });
    await expect(writeVerifiedBytes(storage, input())).rejects.toMatchObject({ phase: "destination", reason: "size_mismatch" });
  });

  it("late stream errors cannot certify a matching prefix", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(bytes);
      else controller.error(new Error("secret provider endpoint"));
    } }, { highWaterMark: 0 });
    await expect(verifyByteStream(body, expected(), cloudflareSha256, "destination"))
      .rejects.toEqual(new ByteVerificationError("destination", "unavailable"));
  });

  it("stops and cancels an oversized producer at the first excess chunk", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(bytes); }, cancel }, { highWaterMark: 0 });
    await expect(verifyByteStream(body, expected(), cloudflareSha256, "source"))
      .rejects.toMatchObject({ reason: "size_mismatch" });
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([-1, 0.5, NaN, Infinity, MAX_VERIFIED_BYTES + 1])("rejects unsupported size %s before I/O", async byteSize => {
    const storage = fixture();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    await expect(writeVerifiedBytes(storage, { ...input(body), byteSize }))
      .rejects.toMatchObject({ reason: "invalid_expectation" });
    expect(storage.writer.write).not.toHaveBeenCalled();
    expect(storage.reader.read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("limits each hash write and awaits backpressure without tee", async () => {
    const value = new Uint8Array(200_000).fill(7);
    let pending = 0;
    let maximum = 0;
    const sizes: number[] = [];
    const factory = () => {
      const sink = cloudflareSha256();
      return { ...sink, async write(chunk: Uint8Array) {
        pending++; maximum = Math.max(maximum, pending); sizes.push(chunk.byteLength);
        await sink.write(chunk); pending--;
      } };
    };
    expect(await verifyByteStream(stream(value), expected(value), factory, "destination")).toEqual(expected(value));
    expect(maximum).toBe(1);
    expect(Math.max(...sizes)).toBe(64 * 1024);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(value.byteLength);
  });

  it.each(["missing", "denied", "unavailable"] as const)("keeps %s distinct from successful verification", async outcome => {
    const reader = { read: vi.fn(async () => outcome === "denied" ? { outcome, status: 403 as const } : { outcome }) };
    await expect(verifyStoredBytes(reader, "key", expected(), cloudflareSha256))
      .rejects.toMatchObject({ phase: "destination", reason: "unavailable" });
    expect(reader.read).toHaveBeenCalledOnce();
  });

  it("keeps the buffered-only R2 capability explicit and performs no unsupported write", async () => {
    const put = vi.fn();
    const read = vi.fn();
    await expect(writeVerifiedBytes({ writer: r2ByteWriter({ put }), reader: { read }, createHash: cloudflareSha256 }, input(stream())))
      .rejects.toMatchObject({ phase: "source", reason: "invalid_expectation" });
    expect(put).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
