import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStoreArchiveStream, measureStoreArchive, openStoreArchiveEntry, researchArchiveCrc32,
  sourceFromBlob, sourceFromStream, validateStoreArchive, RESEARCH_ARCHIVE_CHUNK_BYTES,
  RESEARCH_ARCHIVE_MAX_BYTES, RESEARCH_ARCHIVE_METADATA_MAX_BYTES, RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES,
  type ArchiveEntry, type ArchiveHashFactory, type ArchiveSource } from "./research-archive";

const encode = (value: string) => new TextEncoder().encode(value);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const nativeHash: ArchiveHashFactory = () => { const hash = createHash("sha256"); return { write: bytes => { hash.update(bytes); }, finish: () => hash.digest("hex") }; };
function bytesStream(bytes: Uint8Array, chunkBytes = 997, cancel = vi.fn()) {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) { if (at === bytes.length) controller.close(); else { const end = Math.min(at + chunkBytes, bytes.length); controller.enqueue(bytes.subarray(at, end)); at = end; } }, cancel,
  }, { highWaterMark: 0 });
}
async function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let length = 0, maxChunk = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); length += next.value.length; maxChunk = Math.max(maxChunk, next.value.length); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return { bytes, maxChunk };
}
function fixture(payloadBytes = 133_019) {
  const contents = new Map<string, Uint8Array>([
    ["manifest.json", encode('{"schema":"research-package/1"}')],
    ["records.json", encode('{"schema":"research-records/1","records":[]}')],
    ["report/index.html", encode('<!doctype html><p>Inert report</p>')],
    ["report/report.md", encode("# Report\n")],
    ["files/f_source", Uint8Array.from({ length: payloadBytes }, (_, at) => (at * 131 + (at >>> 7)) & 255)],
  ]);
  const entries: ArchiveEntry[] = [...contents].map(([path, bytes]) => ({ path, kind: path.startsWith("files/") ? "payload" : path.startsWith("report/") ? "report" : "metadata", byteSize: bytes.length, sha256: sha(bytes) }));
  const open = vi.fn(async (entry: ArchiveEntry) => bytesStream(contents.get(entry.path)!, RESEARCH_ARCHIVE_CHUNK_BYTES * 3));
  return { contents, entries, open };
}
async function archive(payloadBytes = 133_019) {
  const value = fixture(payloadBytes), measured = await measureStoreArchive(value.entries, value.open, { createHash: nativeHash });
  const output = await collect(createStoreArchiveStream(value.entries, value.open, { createHash: nativeHash }));
  return { ...value, measured, ...output };
}
function directSource(bytes: Uint8Array): ArchiveSource {
  return { byteSize: bytes.length, read: vi.fn(async (offset: number, length: number) => bytes.slice(offset, offset + length)) };
}
async function rejectedMutation(change: (bytes: Uint8Array, source: Awaited<ReturnType<typeof archive>>) => void) {
  const source = await archive(79), corrupted = source.bytes.slice(); change(corrupted, source);
  await expect(validateStoreArchive(directSource(corrupted), { expectedSha256: sha(corrupted), expectedEntries: source.entries, createHash: nativeHash })).rejects.toThrow();
}
const data = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function centralOffset(bytes: Uint8Array) { return data(bytes).getUint32(bytes.length - 6, true); }
function centralMember(bytes: Uint8Array, member: number) { let at = centralOffset(bytes); for (let index = 0; index < member; index++) at += 46 + data(bytes).getUint16(at + 28, true); return at; }

describe("bounded deterministic research ZIP STORE", () => {
  it("measures exact reproducible bytes, CRCs and offsets and splits large upstream chunks", async () => {
    const source = await archive();
    expect(source.measured.byteSize).toBe(source.bytes.length); expect(source.measured.sha256).toBe(sha(source.bytes));
    expect(source.maxChunk).toBeLessThanOrEqual(RESEARCH_ARCHIVE_CHUNK_BYTES);
    expect(researchArchiveCrc32(encode("123456789"))).toBe(0xcbf43926);
    const repeated = await collect(createStoreArchiveStream([...source.entries].reverse(), source.open));
    expect(Buffer.from(repeated.bytes).equals(Buffer.from(source.bytes))).toBe(true);
    expect(source.open).toHaveBeenCalledTimes(source.entries.length * 3);
    for (const entry of source.measured.entries) {
      expect(entry.crc32).toBe(researchArchiveCrc32(source.contents.get(entry.path)!));
      expect(sha(source.bytes.subarray(entry.dataOffset, entry.descriptorOffset))).toBe(entry.sha256);
    }
  });

  it("validates through at most two sequential raw reads and extracts a verified member without a Range API", async () => {
    const value = await archive(), reopen = vi.fn(async () => bytesStream(value.bytes, 8191));
    const source = sourceFromStream(value.bytes.length, reopen);
    const checked = await validateStoreArchive(source, { expectedSha256: value.measured.sha256, expectedEntries: value.entries, createHash: nativeHash });
    expect(reopen).toHaveBeenCalledTimes(2); expect(source.bytesRead).toBeLessThanOrEqual(value.bytes.length * 2);
    expect(checked.entries).toEqual(value.measured.entries); expect(checked.metadata.size).toBe(4);
    const payload = checked.entries.find(entry => entry.kind === "payload")!;
    const extracted = await collect(await openStoreArchiveEntry(source, payload));
    expect(Buffer.from(extracted.bytes).equals(Buffer.from(value.contents.get(payload.path)!))).toBe(true);
    expect(extracted.maxChunk).toBeLessThanOrEqual(RESEARCH_ARCHIVE_CHUNK_BYTES); expect(reopen).toHaveBeenCalledTimes(3);
    source.dispose();
  });

  it("retains one cursor across bounded forward reads and disposes the raw reader", async () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, at) => at & 255), raw: ReadableStream<Uint8Array>[] = [], cancelled = vi.fn();
    const reopen = vi.fn(async () => { const stream = bytesStream(bytes, 3111, cancelled); raw.push(stream); return stream; });
    const source = sourceFromStream(bytes.length, reopen);
    for (let at = 0; at < 100_000; at += 10_000) expect(Buffer.from(await source.read(at, 10_000)).equals(Buffer.from(bytes.subarray(at, at + 10_000)))).toBe(true);
    expect(reopen).toHaveBeenCalledOnce(); source.close(); expect(cancelled).toHaveBeenCalledOnce(); expect(raw[0].locked).toBe(false);
  });

  it("binds the exact declared inventory after inert metadata and before any payload authority", async () => {
    const source = await archive(51), resolve = vi.fn((metadata: ReadonlyMap<string, Uint8Array>) => {
      expect([...metadata.keys()]).toEqual(["manifest.json", "records.json", "report/index.html", "report/report.md"]);
      return source.entries;
    });
    await validateStoreArchive(directSource(source.bytes), { expectedSha256: source.measured.sha256, expectedEntries: resolve });
    expect(resolve).toHaveBeenCalledOnce();
    await expect(validateStoreArchive(directSource(source.bytes), { expectedSha256: source.measured.sha256,
      expectedEntries: source.entries.map(entry => entry.kind === "payload" ? { ...entry, sha256: "0".repeat(64) } : entry) })).rejects.toThrow(/SHA-256/);
    await expect(validateStoreArchive(directSource(source.bytes), { expectedSha256: source.measured.sha256,
      expectedEntries: source.entries.slice(0, 4) })).rejects.toThrow(/declaration/);
  });

  it("validates the complete 100-File inventory in a bounded directory read", async () => {
    const value = fixture(0), entries = value.entries.slice(0, 4);
    for (let index = 0; index < 100; index++) {
      const path = `files/f_${index.toString().padStart(3, "0")}`, bytes = Uint8Array.of(index);
      value.contents.set(path, bytes); entries.push({ path, kind: "payload", byteSize: 1, sha256: sha(bytes) });
    }
    const measured = await measureStoreArchive(entries, value.open), output = await collect(createStoreArchiveStream(entries, value.open)), source = directSource(output.bytes);
    const checked = await validateStoreArchive(source, { expectedSha256: measured.sha256, expectedEntries: entries });
    expect(checked.entries).toHaveLength(104);
    for (const call of vi.mocked(source.read).mock.calls) expect(call[1]).toBeLessThanOrEqual(RESEARCH_ARCHIVE_CHUNK_BYTES);
  });

  it.each(["files/f_source", "files/F_SOURCE"])("rejects a forged duplicate directory member %s before the declaration resolver", async duplicate => {
    const value = fixture(1), bytes = Uint8Array.of(17), path = "files/f_second";
    value.contents.set(path, bytes); value.entries.push({ path, kind: "payload", byteSize: bytes.length, sha256: sha(bytes) });
    const output = await collect(createStoreArchiveStream(value.entries, value.open));
    const firstPayload = centralMember(output.bytes, 4); output.bytes.set(encode(duplicate), firstPayload + 46);
    const resolver = vi.fn(() => value.entries);
    await expect(validateStoreArchive(directSource(output.bytes), { expectedSha256: sha(output.bytes), expectedEntries: resolver })).rejects.toThrow(/Duplicate|case-colliding/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects non-UTF8 metadata after ZIP CRC/SHA verification", async () => {
    const value = fixture(1), bytes = Uint8Array.of(0xff);
    value.contents.set("manifest.json", bytes); value.entries[0] = { ...value.entries[0], byteSize: bytes.length, sha256: sha(bytes) };
    const output = await collect(createStoreArchiveStream(value.entries, value.open));
    await expect(validateStoreArchive(directSource(output.bytes), { expectedSha256: sha(output.bytes), expectedEntries: value.entries })).rejects.toThrow(/UTF-8/);
  });

  it("keeps malicious report HTML inert and uses only bounded Blob slices", async () => {
    const value = fixture(9); value.contents.set("report/index.html", encode('<script>fetch("https://attacker.invalid")</script><img src="https://attacker.invalid">'));
    value.entries = value.entries.map(entry => { const bytes = value.contents.get(entry.path)!; return { ...entry, byteSize: bytes.length, sha256: sha(bytes) }; });
    const measured = await measureStoreArchive(value.entries, value.open), output = await collect(createStoreArchiveStream(value.entries, value.open));
    const blob = new Blob([output.bytes]), wholeBuffer = vi.spyOn(blob, "arrayBuffer").mockRejectedValue(new Error("Whole ZIP allocation forbidden"));
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const checked = await validateStoreArchive(sourceFromBlob(blob), { expectedSha256: measured.sha256, expectedEntries: value.entries });
      expect(new TextDecoder().decode(checked.metadata.get("report/index.html"))).toContain("<script>");
      expect(wholeBuffer).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { wholeBuffer.mockRestore(); fetch.mockRestore(); }
  });

  it.each([
    ["encrypted", (bytes: Uint8Array) => data(bytes).setUint16(centralMember(bytes, 0) + 8, 0x0809, true)],
    ["compressed", (bytes: Uint8Array) => data(bytes).setUint16(centralMember(bytes, 0) + 10, 8, true)],
    ["symlink", (bytes: Uint8Array) => data(bytes).setUint32(centralMember(bytes, 0) + 38, (0o120777 << 16) >>> 0, true)],
    ["ZIP64", (bytes: Uint8Array) => data(bytes).setUint16(centralMember(bytes, 0) + 6, 45, true)],
    ["spanned", (bytes: Uint8Array) => data(bytes).setUint16(bytes.length - 18, 1, true)],
    ["extra fields", (bytes: Uint8Array) => data(bytes).setUint16(centralMember(bytes, 0) + 30, 1, true)],
    ["overlapping local offsets", (bytes: Uint8Array) => data(bytes).setUint32(centralMember(bytes, 1) + 42, 0, true)],
    ["inconsistent sizes", (bytes: Uint8Array) => data(bytes).setUint32(centralMember(bytes, 0) + 20, 1, true)],
    ["wrong count", (bytes: Uint8Array) => data(bytes).setUint16(bytes.length - 12, 4, true)],
    ["comment or corrupt final byte", (bytes: Uint8Array) => { bytes[bytes.length - 1] = 1; }],
    ["unsafe path", (bytes: Uint8Array) => { bytes.set(encode("../manifest.x"), centralMember(bytes, 0) + 46); }],
    ["local name mismatch", (bytes: Uint8Array) => { bytes[30] ^= 1; }],
    ["noncanonical local timestamp", (bytes: Uint8Array) => { data(bytes).setUint16(10, 1, true); }],
  ] as const)("rejects %s even when the complete uploaded SHA is recomputed", async (_name, mutate) => rejectedMutation(mutate));

  it("rejects corrupt last payload bytes, changed descriptors and whole-ZIP identity", async () => {
    await rejectedMutation((bytes, value) => { bytes[value.measured.entries[4].descriptorOffset - 1] ^= 1; });
    await rejectedMutation((bytes, value) => { bytes[value.measured.entries[4].descriptorOffset + 4] ^= 1; });
    const value = await archive(1);
    await expect(validateStoreArchive(directSource(value.bytes), { expectedSha256: "0".repeat(64) })).rejects.toThrow(/complete research ZIP SHA-256/);
  });

  it("rejects duplicate/case-colliding paths, excess Files and size limits before source I/O", async () => {
    const value = fixture(1), base = value.entries.slice(0, 4), file = value.entries[4];
    for (const entries of [
      [...value.entries, { ...file, path: "files/F_SOURCE" }],
      [...base, ...Array.from({ length: 101 }, (_, at) => ({ ...file, path: `files/f_${at}` }))],
      [{ ...base[0], byteSize: RESEARCH_ARCHIVE_METADATA_MAX_BYTES + 1 }, ...base.slice(1)],
      [...base, { ...file, byteSize: RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES + 1 }],
      [...base.map((entry, at) => ({ ...entry, byteSize: at ? 0 : RESEARCH_ARCHIVE_METADATA_MAX_BYTES })), { ...file, byteSize: RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES }],
    ]) await expect(measureStoreArchive(entries, value.open)).rejects.toThrow();
    expect(value.open).not.toHaveBeenCalled();
    const read = vi.fn(); await expect(validateStoreArchive({ byteSize: RESEARCH_ARCHIVE_MAX_BYTES + 1, read }, { expectedSha256: "0".repeat(64) })).rejects.toThrow(/limits/); expect(read).not.toHaveBeenCalled();
  });

  it("rejects source drift in measurement and output rather than completing an archive", async () => {
    const value = fixture(7), wrong = vi.fn(async (entry: ArchiveEntry) => entry.kind === "payload" ? bytesStream(encode("changed")) : value.open(entry));
    await expect(measureStoreArchive(value.entries, wrong)).rejects.toThrow(/verification/);
    await expect(collect(createStoreArchiveStream(value.entries, wrong))).rejects.toThrow(/verification/);
    const truncated = vi.fn(async (entry: ArchiveEntry) => entry.kind === "payload" ? bytesStream(new Uint8Array()) : value.open(entry));
    await expect(measureStoreArchive(value.entries, truncated)).rejects.toThrow(/verification/);
  });

  it("requires terminal extraction proof even if source bytes change after preview", async () => {
    const value = await archive(71), entry = value.measured.entries[4], changed = value.bytes.slice(); changed[entry.descriptorOffset - 1] ^= 1;
    const extracted = await openStoreArchiveEntry(directSource(changed), entry);
    await expect(collect(extracted)).rejects.toThrow(/verification/);
  });

  it("rejects raw source truncation or excess bytes and closes the retained reader", async () => {
    const value = await archive(7);
    for (const bytes of [value.bytes.subarray(0, value.bytes.length - 1), new Uint8Array([...value.bytes, 0])]) {
      const cancelled = vi.fn(), raw = bytesStream(bytes, 17, cancelled), source = sourceFromStream(value.bytes.length, async () => raw);
      await expect(validateStoreArchive(source, { expectedSha256: value.measured.sha256 })).rejects.toThrow(/truncated|exceeds/);
      expect(raw.locked).toBe(false); source.dispose();
    }
  });

  it("does not open a raw File when an extraction is cancelled before its first pull", async () => {
    const value = await archive(1), reopen = vi.fn(async () => bytesStream(value.bytes)), source = sourceFromStream(value.bytes.length, reopen);
    const extracted = await openStoreArchiveEntry(source, value.measured.entries[4]); await extracted.cancel(); expect(reopen).not.toHaveBeenCalled(); source.dispose();
  });

  it("cancels a late-resolving source factory after the lease was aborted", async () => {
    const value = fixture(1), controller = new AbortController(), reason = new Error("Lease changed"), cancelled = vi.fn(), raw = bytesStream(encode("x"), 1, cancelled);
    let resolve!: (value: ReadableStream<Uint8Array>) => void;
    const opened = new Promise<ReadableStream<Uint8Array>>(ready => { resolve = ready; });
    const open = vi.fn(async () => opened), output = createStoreArchiveStream(value.entries, open, { signal: controller.signal }), reader = output.getReader();
    await reader.read(); const blocked = reader.read();
    for (let turn = 0; turn < 10 && !open.mock.calls.length; turn++) await Promise.resolve();
    expect(open).toHaveBeenCalledOnce(); controller.abort(reason); await expect(blocked).rejects.toBe(reason);
    resolve(raw); for (let turn = 0; turn < 10 && !cancelled.mock.calls.length; turn++) await Promise.resolve();
    expect(cancelled).toHaveBeenCalledOnce(); expect(raw.locked).toBe(false); reader.releaseLock();
  });

  it("interrupts a blocked output read and releases the source without waiting for provider cancellation", async () => {
    const value = fixture(1), heldCancel = vi.fn(() => new Promise<void>(() => undefined)), heldPull = vi.fn(() => new Promise<void>(() => undefined));
    const held = new ReadableStream<Uint8Array>({ pull: heldPull, cancel: heldCancel }, { highWaterMark: 0 });
    const output = createStoreArchiveStream(value.entries, async () => held), reader = output.getReader();
    expect((await reader.read()).done).toBe(false); const blocked = reader.read();
    for (let turn = 0; turn < 10 && !heldPull.mock.calls.length; turn++) await Promise.resolve();
    expect(heldPull).toHaveBeenCalledOnce(); await reader.cancel(new Error("Consumer disconnected"));
    await expect(blocked).resolves.toMatchObject({ done: true }); expect(heldCancel).toHaveBeenCalledOnce(); expect(held.locked).toBe(false); reader.releaseLock();
  });

  it("aborts a blocked validation and closes both retained and active raw streams", async () => {
    const value = await archive(7), controller = new AbortController(), reason = new Error("Lease expired"), cancelled = vi.fn();
    let calls = 0, held: ReadableStream<Uint8Array> | undefined; const pull = vi.fn(() => new Promise<void>(() => undefined));
    const source = sourceFromStream(value.bytes.length, async () => ++calls === 1 ? bytesStream(value.bytes) : (held = new ReadableStream({ pull, cancel: cancelled }, { highWaterMark: 0 })));
    const checking = validateStoreArchive(source, { expectedSha256: value.measured.sha256, signal: controller.signal });
    for (let turn = 0; turn < 30 && !pull.mock.calls.length; turn++) await Promise.resolve();
    expect(pull).toHaveBeenCalledOnce(); controller.abort(reason); await expect(checking).rejects.toBe(reason);
    expect(cancelled).toHaveBeenCalledOnce(); expect(held!.locked).toBe(false); source.dispose();
  });
});
