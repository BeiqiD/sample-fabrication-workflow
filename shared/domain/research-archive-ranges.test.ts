import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStoreArchiveStream, measureStoreArchive, openStoreArchiveEntry, sourceFromStream, validateStoreArchive,
  type ArchiveEntry, type ArchiveHashFactory } from "./research-archive";

const hash: ArchiveHashFactory = () => { const value = createHash("sha256"); return { write(bytes) { value.update(bytes); }, finish: () => value.digest("hex") }; };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function stream(bytes: Uint8Array, cancelled = vi.fn()) {
  let at = 0; return new ReadableStream<Uint8Array>({ pull(controller) {
    if (at === bytes.length) controller.close(); else { const end = Math.min(at + 65536, bytes.length); controller.enqueue(bytes.subarray(at, end)); at = end; }
  }, cancel: cancelled }, { highWaterMark: 0 });
}
async function collect(body: ReadableStream<Uint8Array>) { return new Uint8Array(await new Response(body).arrayBuffer()); }
async function fixture(count = 10) {
  const contents = new Map<string, Uint8Array>(["manifest.json", "records.json", "report/index.html", "report/report.md"].map(path => [path, new TextEncoder().encode("{}") as Uint8Array]));
  for (let i = 0; i < count; i++) contents.set(`files/f_${i}`, new Uint8Array(65536).fill(i));
  const entries: ArchiveEntry[] = [...contents].map(([path, bytes]) => ({ path, kind: path.startsWith("files/") ? "payload" : path.startsWith("report/") ? "report" : "metadata", byteSize: bytes.length, sha256: sha(bytes) }));
  const open = async (entry: ArchiveEntry) => stream(contents.get(entry.path)!);
  const measured = await measureStoreArchive(entries, open, { createHash: hash });
  return { entries, contents, measured, bytes: await collect(createStoreArchiveStream(entries, open, { createHash: hash })) };
}

describe("actual ranged research archive sources", () => {
  it.each([10, 50])("reads only requested ranges for %i payloads while validating the complete archive", async count => {
    const value = await fixture(count), full = vi.fn(async () => stream(value.bytes)), requested: Array<{ offset: number; length: number }> = [];
    const ranged = vi.fn(async (offset: number, length: number) => { requested.push({ offset, length }); return stream(value.bytes.subarray(offset, offset + length)); });
    const source = sourceFromStream(value.bytes.length, full, ranged);
    const checked = await validateStoreArchive(source, { expectedSha256: value.measured.sha256, expectedEntries: value.entries, createHash: hash });
    expect(full).not.toHaveBeenCalled();
    expect(source.bytesRead).toBe(value.bytes.length + Math.min(65536, value.bytes.length));
    expect(requested).toEqual([{ offset: value.bytes.length - 65536, length: 65536 }, { offset: 0, length: value.bytes.length }]);
    const before = source.bytesRead;
    for (const entry of checked.entries.filter(entry => entry.kind === "payload")) {
      expect(await collect(await openStoreArchiveEntry(source, entry, { createHash: hash }))).toEqual(value.contents.get(entry.path));
    }
    const extraction = requested.slice(2);
    expect(extraction).toHaveLength(count);
    expect(source.bytesRead - before).toBe(extraction.reduce((sum, item) => sum + item.length, 0));
    expect(extraction.every(item => item.length < 66000)).toBe(true);
    source.dispose();
  }, 20000);

  it("retains the full-object fallback only when range transport explicitly reports unsupported", async () => {
    const bytes = new Uint8Array(200000).fill(3), full = vi.fn(async () => stream(bytes)), unsupported = vi.fn(async () => undefined);
    const source = sourceFromStream(bytes.length, full, unsupported);
    expect(await source.read(10000, 100)).toEqual(bytes.subarray(10000, 10100));
    expect(await source.read(10100, 100)).toEqual(bytes.subarray(10100, 10200));
    expect(unsupported).toHaveBeenCalledOnce(); expect(full).toHaveBeenCalledOnce(); source.dispose();
    const failed = sourceFromStream(bytes.length, full, async () => { throw new Error("provider denied"); });
    await expect(failed.open!(10000, 100)).rejects.toThrow("provider denied"); expect(full).toHaveBeenCalledOnce(); failed.dispose();
  });

  it.each(["truncated", "extra", "ignored"])("rejects %s range bodies instead of accepting a payload", async failure => {
    const bytes = new Uint8Array(1000).fill(4), full = vi.fn(async () => stream(bytes));
    const source = sourceFromStream(bytes.length, full, async (_offset, length) => stream(failure === "truncated" ? bytes.subarray(0, length - 1) : failure === "extra" ? bytes.subarray(0, length + 1) : bytes));
    await expect(collect(await source.open!(50, 100))).rejects.toThrow(/truncated|exceeds/);
    expect(full).not.toHaveBeenCalled(); source.dispose();
  });

  it("still rejects a corrupt complete archive when valid-looking member ranges are supported", async () => {
    const value = await fixture(1), bytes = value.bytes.slice(); bytes[value.measured.entries.find(entry => entry.kind === "payload")!.dataOffset] ^= 1;
    const source = sourceFromStream(bytes.length, async () => stream(bytes), async (offset, length) => stream(bytes.subarray(offset, offset + length)));
    await expect(validateStoreArchive(source, { expectedSha256: value.measured.sha256, expectedEntries: value.entries, createHash: hash })).rejects.toThrow(/CRC|SHA|corrupt/); source.dispose();
  });

  it("cancels the exact ranged owner on consumer cancellation, abort and source disposal", async () => {
    for (const mode of ["cancel", "abort", "dispose"] as const) {
      const controller = new AbortController(), cancelled = vi.fn(), raw = new ReadableStream<Uint8Array>({ pull() {}, cancel: cancelled }, { highWaterMark: 0 });
      const source = sourceFromStream(1000, async () => { throw new Error("Unexpected full read"); }, async () => raw);
      const body = await source.open!(100, 50, controller.signal), reader = body.getReader();
      const reading = reader.read().catch(error => error);
      if (mode === "cancel") await reader.cancel(); else if (mode === "abort") controller.abort(); else source.dispose();
      await reading; expect(cancelled).toHaveBeenCalledOnce(); expect(raw.locked).toBe(false); reader.releaseLock(); source.dispose();
    }
  });
});
