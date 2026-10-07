import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResearchSha256, DEFAULT_RESEARCH_HASH_MAX_BYTES, hashResearchFile, hashResearchStream,
  RESEARCH_HASH_CHUNK_BYTES } from "./research-sha256";

const encode = (text: string) => new TextEncoder().encode(text);
const reference = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(length: number) {
  return Uint8Array.from({ length }, (_, index) => (index * 131 + (index >>> 7)) & 255);
}
function streamOf(chunks: Uint8Array[], cancel = vi.fn()) {
  let offset = 0;
  return { cancel, stream: new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === chunks.length) controller.close();
      else controller.enqueue(chunks[offset++]);
    },
    cancel,
  }, { highWaterMark: 0 }) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("incremental research SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
  ])("matches the standard vector %j", (text, sha256) => {
    const hash = createResearchSha256();
    hash.update(encode(text));
    expect(hash.digestHex()).toBe(sha256);
    expect(hash.digestHex()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches the one-million-a vector using repeated bounded writes", () => {
    const hash = createResearchSha256(), block = encode("a".repeat(1000));
    for (let index = 0; index < 1000; index += 1) hash.update(block);
    expect(hash.digestHex()).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it.each([1, 55, 56, 63, 64, 65, 127, 128, 129, 1024, 65_535, 65_536, 65_537, 196_611])(
    "matches Node SHA-256 across irregular block/chunk boundaries for %i bytes", length => {
      const bytes = fixture(length), hash = createResearchSha256();
      const sizes = [1, 7, 63, 65, 17, 64, 65_536, 3];
      let offset = 0, index = 0;
      while (offset < bytes.byteLength) {
        const end = Math.min(bytes.byteLength, offset + sizes[index++ % sizes.length]);
        hash.update(bytes.subarray(offset, end));
        hash.update(new Uint8Array());
        offset = end;
      }
      expect(hash.digestHex()).toBe(reference(bytes));
    },
  );

  it("hashes a large view with a nonzero backing-buffer offset without retaining caller bytes", () => {
    const backing = fixture(RESEARCH_HASH_CHUNK_BYTES * 3 + 91);
    const bytes = backing.subarray(13, backing.byteLength - 19), expected = reference(bytes);
    const hash = createResearchSha256();
    hash.update(bytes);
    backing.fill(0);
    expect(hash.digestHex()).toBe(expected);
  });

  it("keeps final digest reads stable and rejects updates after finalization", () => {
    const hash = createResearchSha256(); hash.update(encode("abc"));
    const first = hash.digestHex();
    expect(hash.digestHex()).toBe(first);
    expect(() => hash.update(encode("more"))).toThrow(/finalized/);
    expect(() => hash.update(new Uint8Array())).toThrow(/finalized/);
    expect(hash.digestHex()).toBe(first);
  });

  it("rejects values that are not byte views", () => {
    expect(() => createResearchSha256().update(new Uint16Array([1]) as unknown as Uint8Array)).toThrow(TypeError);
  });
});

describe("bounded research stream hashing", () => {
  it("hashes exact contents including oversized upstream chunks and releases the reader at EOF", async () => {
    const bytes = fixture(RESEARCH_HASH_CHUNK_BYTES * 2 + 29);
    const { stream, cancel } = streamOf([new Uint8Array(), bytes.subarray(0, 5), bytes.subarray(5)]);
    await expect(hashResearchStream(stream, { maxBytes: bytes.byteLength, expectedByteSize: bytes.byteLength }))
      .resolves.toEqual({ byteSize: bytes.byteLength, sha256: reference(bytes) });
    expect(stream.locked).toBe(false); expect(cancel).not.toHaveBeenCalled();
  });

  it("supports an empty stream with a zero-byte bound", async () => {
    const { stream } = streamOf([]);
    await expect(hashResearchStream(stream, { maxBytes: 0, expectedByteSize: 0 }))
      .resolves.toEqual({ byteSize: 0, sha256: reference(new Uint8Array()) });
    expect(stream.locked).toBe(false);
  });

  it("cancels over-limit input before reading later chunks", async () => {
    const { stream, cancel } = streamOf([fixture(4), fixture(4), fixture(1)]);
    await expect(hashResearchStream(stream, { maxBytes: 7 })).rejects.toThrow(/byte limit/);
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
  });

  it.each([2, 4])("rejects a declared byte count of %i for a three-byte stream", async expectedByteSize => {
    const { stream, cancel } = streamOf([encode("abc")]);
    await expect(hashResearchStream(stream, { maxBytes: 5, expectedByteSize })).rejects.toThrow(/expected size/);
    expect(stream.locked).toBe(false);
    // Cancellation of an already closed stream needs no upstream action.
    if (expectedByteSize === 2) expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxBytes %s without consuming input", async maxBytes => {
      const pull = vi.fn(), cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      await expect(hashResearchStream(stream, { maxBytes })).rejects.toThrow(/byte limit/);
      expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
    },
  );

  it.each([-1, 1.5, Number.NaN, 11])("rejects invalid expectedByteSize %s before reading", async expectedByteSize => {
    const { stream, cancel } = streamOf([fixture(1)]);
    await expect(hashResearchStream(stream, { maxBytes: 10, expectedByteSize })).rejects.toThrow(/expected research byte size/);
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
  });

  it("cancels and unlocks a stream when the signal was already aborted", async () => {
    const controller = new AbortController(), reason = new Error("Hash cancelled"); controller.abort(reason);
    const { stream, cancel } = streamOf([encode("abc")]);
    await expect(hashResearchStream(stream, { maxBytes: 3, signal: controller.signal })).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason); expect(stream.locked).toBe(false);
  });

  it("interrupts a pending read without waiting for a slow upstream cancellation", async () => {
    const controller = new AbortController(), reason = new Error("Hash cancelled");
    const pull = vi.fn(() => new Promise<void>(() => undefined));
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const result = hashResearchStream(stream, { maxBytes: 1, signal: controller.signal });
    await Promise.resolve(); expect(pull).toHaveBeenCalledOnce();
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason); expect(stream.locked).toBe(false);
  });

  it("rejects non-byte chunks and requests upstream cancellation", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(output) { output.enqueue("not bytes" as unknown as Uint8Array); }, cancel,
    }, { highWaterMark: 0 });
    await expect(hashResearchStream(stream, { maxBytes: 10 })).rejects.toThrow(TypeError);
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
  });

  it("releases the reader when the source rejects", async () => {
    const reason = new Error("Source failed");
    const stream = new ReadableStream<Uint8Array>({ pull(output) { output.error(reason); } }, { highWaterMark: 0 });
    await expect(hashResearchStream(stream, { maxBytes: 10 })).rejects.toBe(reason);
    expect(stream.locked).toBe(false);
  });
});

describe("streamed Blob and File hashing", () => {
  it("hashes a Blob through its stream without calling its arrayBuffer method", async () => {
    const bytes = fixture(RESEARCH_HASH_CHUNK_BYTES + 11), file = new Blob([bytes]);
    const arrayBuffer = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Whole-file buffering is forbidden"));
    const stream = vi.spyOn(file, "stream");
    await expect(hashResearchFile(file)).resolves.toEqual({ byteSize: bytes.byteLength, sha256: reference(bytes) });
    expect(stream).toHaveBeenCalledOnce(); expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("hashes Unicode File content with an explicit byte cap", async () => {
    const bytes = encode("层叠 αβγ 😀\n"), file = new File([bytes], "研究.txt");
    await expect(hashResearchFile(file, { maxBytes: bytes.byteLength }))
      .resolves.toEqual({ byteSize: bytes.byteLength, sha256: reference(bytes) });
  });

  it("rejects an oversized declared Blob before opening its stream", async () => {
    const file = new Blob(["abc"]), stream = vi.spyOn(file, "stream");
    Object.defineProperty(file, "size", { value: DEFAULT_RESEARCH_HASH_MAX_BYTES + 1 });
    await expect(hashResearchFile(file)).rejects.toThrow(/byte limit/);
    expect(stream).not.toHaveBeenCalled();
  });

  it("honors zero-byte custom caps and pre-aborted files without opening a stream", async () => {
    await expect(hashResearchFile(new Blob(), { maxBytes: 0 }))
      .resolves.toEqual({ byteSize: 0, sha256: reference(new Uint8Array()) });
    const file = new Blob(["abc"]), stream = vi.spyOn(file, "stream"), controller = new AbortController();
    controller.abort();
    await expect(hashResearchFile(file, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(stream).not.toHaveBeenCalled();
  });

  it("checks the declared size against the actual stream and cancels a changed source", async () => {
    const file = new Blob(["abc"]), { stream, cancel } = streamOf([encode("abcd")]);
    vi.spyOn(file, "stream").mockReturnValue(stream);
    await expect(hashResearchFile(file)).rejects.toThrow(/expected size/);
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
  });
});
