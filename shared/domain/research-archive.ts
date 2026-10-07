import { createResearchSha256 } from "./research-sha256";

export const RESEARCH_ARCHIVE_CHUNK_BYTES = 64 * 1024;
export const RESEARCH_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
export const RESEARCH_ARCHIVE_METADATA_MAX_BYTES = 4 * 1024 * 1024;
export const RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES = 96 * 1024 * 1024;
export const RESEARCH_ARCHIVE_MAX_FILES = 100;
export const RESEARCH_ARCHIVE_METADATA_PATHS = ["manifest.json", "records.json", "report/index.html", "report/report.md"] as const;

export type ArchiveEntryKind = "metadata" | "report" | "payload";
export interface ArchiveEntry { path: string; kind: ArchiveEntryKind; byteSize: number; sha256: string; crc32?: number }
export interface ArchiveEntryHeader {
  path: string; kind: ArchiveEntryKind; byteSize: number; crc32: number;
  localHeaderOffset: number; dataOffset: number; descriptorOffset: number;
}
export interface ArchiveIndexEntry extends ArchiveEntryHeader { sha256: string }
export interface ArchiveSource {
  byteSize: number;
  /** A bounded random/retained sequential read. Never return the complete ZIP. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** One range stream; a provider without Range can reopen and discard a prefix. */
  open?(offset: number, length: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  close?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
  readonly bytesRead?: number;
}
export interface ArchiveHash {
  write(bytes: Uint8Array): void | Promise<void>;
  finish(): string | Promise<string>;
  abort?(): void | Promise<void>;
}
export type ArchiveHashFactory = () => ArchiveHash;
export type OpenArchiveEntry = (entry: ArchiveEntry, signal?: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
export interface ArchiveOptions { signal?: AbortSignal; createHash?: ArchiveHashFactory }
export interface MeasuredStoreArchive { byteSize: number; sha256: string; entries: ArchiveIndexEntry[] }
export interface ValidatedStoreArchive extends MeasuredStoreArchive { metadata: ReadonlyMap<string, Uint8Array> }
export interface ValidateStoreArchiveOptions extends ArchiveOptions {
  expectedSha256: string;
  expectedEntries?: readonly ArchiveEntry[] | ((metadata: ReadonlyMap<string, Uint8Array>, headers: readonly ArchiveEntryHeader[]) => readonly ArchiveEntry[] | Promise<readonly ArchiveEntry[]>);
}
export class ResearchArchiveError extends Error {
  constructor(readonly code: "invalid_archive" | "size_limit" | "integrity", message: string) { super(message); this.name = "ResearchArchiveError"; }
}

const FLAGS = 0x0808, VERSION = 20, DOS_DATE = 0x21, MADE_BY = 0x0314;
const REGULAR_ATTRIBUTES = ((0o100644 << 16) | 0x20) >>> 0;
const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, DESCRIPTOR = 0x08074b50, END = 0x06054b50;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const shaPattern = /^[a-f0-9]{64}$/;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crcUpdate(state: number, bytes: Uint8Array) { for (const byte of bytes) state = (state >>> 8) ^ crcTable[(state ^ byte) & 255]; return state >>> 0; }
export function researchArchiveCrc32(bytes: Uint8Array) { return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }
function invalid(message = "The research ZIP structure is invalid."): never { throw new ResearchArchiveError("invalid_archive", message); }
function integrity(message = "Research bytes failed complete verification."): never { throw new ResearchArchiveError("integrity", message); }
function limit(): never { throw new ResearchArchiveError("size_limit", "The research archive exceeds its bounded limits."); }
function aborted(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError"); }
function safeNumber(value: number) { return Number.isSafeInteger(value) && value >= 0; }
function checkSource(source: ArchiveSource) { if (!safeNumber(source.byteSize) || source.byteSize < 22) invalid(); if (source.byteSize > RESEARCH_ARCHIVE_MAX_BYTES) limit(); }
function range(source: ArchiveSource, offset: number, length: number) {
  if (!safeNumber(offset) || !safeNumber(length) || offset > source.byteSize || length > source.byteSize - offset) invalid("Invalid research archive byte range.");
}
function kindFor(path: string): ArchiveEntryKind {
  if (path === "manifest.json" || path === "records.json") return "metadata";
  if (path === "report/index.html" || path === "report/report.md") return "report";
  if (/^files\/[A-Za-z0-9_-]{1,128}$/.test(path)) return "payload";
  return invalid("An undeclared or unsafe research archive path was supplied.");
}
function order(path: string) { const index = RESEARCH_ARCHIVE_METADATA_PATHS.findIndex(entry => entry === path); return index < 0 ? 4 : index; }
function compare(left: string, right: string) { return order(left) - order(right) || (left < right ? -1 : left > right ? 1 : 0); }
function checkHeaders<T extends { path: string; kind: ArchiveEntryKind; byteSize: number }>(entries: readonly T[], canonical = false): T[] {
  if (!Array.isArray(entries) || entries.length < 4 || entries.length > RESEARCH_ARCHIVE_MAX_FILES + 4) invalid();
  let metadata = 0, payload = 0, files = 0; const names = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || kindFor(entry.path) !== entry.kind || !safeNumber(entry.byteSize)) invalid();
    const folded = entry.path.toLowerCase(); if (names.has(folded)) invalid("Duplicate or case-colliding research archive paths."); names.add(folded);
    if (entry.kind === "payload") { payload += entry.byteSize; files++; } else metadata += entry.byteSize;
  }
  if (RESEARCH_ARCHIVE_METADATA_PATHS.some(path => !names.has(path))) invalid("The research archive metadata inventory is incomplete.");
  if (metadata > RESEARCH_ARCHIVE_METADATA_MAX_BYTES || payload > RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES || files > RESEARCH_ARCHIVE_MAX_FILES) limit();
  const sorted = [...entries].sort((a, b) => compare(a.path, b.path));
  if (canonical && sorted.some((entry, index) => entry.path !== entries[index].path)) invalid("Research archive member order is not canonical.");
  return sorted;
}
function checkedEntries(entries: readonly ArchiveEntry[]) {
  const result = checkHeaders(entries).map(entry => Object.freeze({ ...entry }));
  for (const entry of result) if (typeof entry.sha256 !== "string" || !shaPattern.test(entry.sha256) || entry.crc32 !== undefined && (!safeNumber(entry.crc32) || entry.crc32 > 0xffffffff)) invalid("Invalid research member verification metadata.");
  return result;
}
function hashFactory(options: ArchiveOptions): ArchiveHashFactory {
  return options.createHash ?? (() => { const hash = createResearchSha256(); return { write: bytes => hash.update(bytes), finish: () => hash.digestHex() }; });
}
function cancel(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown) { void reader.cancel(reason).catch(() => undefined); }
async function writeHash(hash: ArchiveHash, bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += RESEARCH_ARCHIVE_CHUNK_BYTES) await hash.write(bytes.subarray(offset, offset + RESEARCH_ARCHIVE_CHUNK_BYTES));
}
async function finishHash(hash: ArchiveHash) { const value = await hash.finish(); if (typeof value !== "string" || !shaPattern.test(value)) integrity("Invalid research SHA-256 implementation result."); return value; }
function abortHash(hash: ArchiveHash) { try { void Promise.resolve(hash.abort?.()).catch(() => undefined); } catch { /* Preserve the original failure. */ } }
function bytesEqual(left: Uint8Array, right: Uint8Array) { if (left.length !== right.length) return false; for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false; return true; }
function view(bytes: Uint8Array) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

function localHeader(entry: { path: string }) {
  const name = encoder.encode(entry.path), bytes = new Uint8Array(30 + name.length), data = view(bytes);
  data.setUint32(0, LOCAL, true); data.setUint16(4, VERSION, true); data.setUint16(6, FLAGS, true); data.setUint16(12, DOS_DATE, true);
  data.setUint16(26, name.length, true); bytes.set(name, 30); return bytes;
}
function descriptor(entry: { crc32: number; byteSize: number }) {
  const bytes = new Uint8Array(16), data = view(bytes); data.setUint32(0, DESCRIPTOR, true); data.setUint32(4, entry.crc32, true);
  data.setUint32(8, entry.byteSize, true); data.setUint32(12, entry.byteSize, true); return bytes;
}
function centralHeader(entry: ArchiveEntryHeader) {
  const name = encoder.encode(entry.path), bytes = new Uint8Array(46 + name.length), data = view(bytes);
  data.setUint32(0, CENTRAL, true); data.setUint16(4, MADE_BY, true); data.setUint16(6, VERSION, true); data.setUint16(8, FLAGS, true);
  data.setUint16(14, DOS_DATE, true); data.setUint32(16, entry.crc32, true); data.setUint32(20, entry.byteSize, true); data.setUint32(24, entry.byteSize, true);
  data.setUint16(28, name.length, true); data.setUint32(38, REGULAR_ATTRIBUTES, true); data.setUint32(42, entry.localHeaderOffset, true); bytes.set(name, 46); return bytes;
}
function endHeader(count: number, centralSize: number, centralOffset: number) {
  const bytes = new Uint8Array(22), data = view(bytes); data.setUint32(0, END, true); data.setUint16(8, count, true); data.setUint16(10, count, true);
  data.setUint32(12, centralSize, true); data.setUint32(16, centralOffset, true); return bytes;
}
function predictedSize(entries: readonly ArchiveEntry[]) {
  return entries.reduce((total, entry) => total + 30 + encoder.encode(entry.path).length + entry.byteSize + 16 + 46 + encoder.encode(entry.path).length, 22);
}
function iteratorStream(iterator: AsyncGenerator<Uint8Array>, signal?: AbortSignal, onCancel?: (reason?: unknown) => void, onEnded?: () => void): ReadableStream<Uint8Array> {
  let ended = false, output: ReadableStreamDefaultController<Uint8Array>;
  const onAbort = () => { if (!ended) { ended = true; onEnded?.(); output.error(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")); void iterator.return(undefined).catch(() => undefined); } };
  return new ReadableStream<Uint8Array>({
    start(controller) { output = controller; signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort(); },
    async pull(controller) { try { aborted(signal); const item = await iterator.next(); if (ended) return; if (item.done) { ended = true; signal?.removeEventListener("abort", onAbort); onEnded?.(); controller.close(); } else controller.enqueue(item.value); }
      catch (error) { if (!ended) { ended = true; signal?.removeEventListener("abort", onAbort); onEnded?.(); controller.error(error); } void iterator.return(undefined).catch(() => undefined); } },
    cancel(reason) { ended = true; signal?.removeEventListener("abort", onAbort); onCancel?.(reason); onEnded?.(); return iterator.return(reason).then(() => undefined); },
  }, { highWaterMark: 0 });
}
function streamOptions(options: ArchiveOptions) {
  const controller = new AbortController(), onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true }); if (options.signal?.aborted) onAbort();
  return { options: { ...options, signal: controller.signal }, cancel: (reason?: unknown) => controller.abort(reason),
    ended: () => options.signal?.removeEventListener("abort", onAbort) };
}

async function* storeArchiveChunks(entries: readonly ArchiveEntry[], openEntry: OpenArchiveEntry, options: ArchiveOptions,
  record?: (entries: ArchiveIndexEntry[]) => void): AsyncGenerator<Uint8Array> {
  const frozen = checkedEntries(entries), total = predictedSize(frozen); if (total > RESEARCH_ARCHIVE_MAX_BYTES) limit();
  const index: ArchiveIndexEntry[] = []; let offset = 0;
  for (const entry of frozen) {
    aborted(options.signal); const header = localHeader(entry); const localHeaderOffset = offset; yield header; offset += header.length;
    const dataOffset = offset; let crc = 0xffffffff, length = 0, complete = false;
    const stream = await openEntry(entry, options.signal), reader = stream.getReader();
    if (options.signal?.aborted) { cancel(reader, options.signal.reason); reader.releaseLock(); aborted(options.signal); }
    let hash: ArchiveHash;
    try { hash = hashFactory(options)(); } catch (error) { cancel(reader, error); reader.releaseLock(); throw error; }
    const onAbort = () => cancel(reader, options.signal?.reason); options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        aborted(options.signal); const next = await reader.read(); aborted(options.signal); if (next.done) break;
        if (!(next.value instanceof Uint8Array) || next.value.length > entry.byteSize - length) integrity("Research source member size changed.");
        for (let cursor = 0; cursor < next.value.length; cursor += RESEARCH_ARCHIVE_CHUNK_BYTES) {
          aborted(options.signal); const bytes = next.value.subarray(cursor, cursor + RESEARCH_ARCHIVE_CHUNK_BYTES);
          await hash.write(bytes); crc = crcUpdate(crc, bytes); length += bytes.length; offset += bytes.length; yield bytes;
        }
      }
      if (length !== entry.byteSize || await finishHash(hash) !== entry.sha256) integrity("Research source member failed complete verification.");
      crc = (crc ^ 0xffffffff) >>> 0; if (entry.crc32 !== undefined && entry.crc32 !== crc) integrity("Research source member CRC changed.");
      complete = true;
    } finally { options.signal?.removeEventListener("abort", onAbort); if (!complete) { cancel(reader); abortHash(hash); } reader.releaseLock(); }
    const indexed = { ...entry, crc32: crc, localHeaderOffset, dataOffset, descriptorOffset: offset }; index.push(indexed);
    const footer = descriptor(indexed); yield footer; offset += footer.length;
  }
  const centralOffset = offset;
  for (const entry of index) { aborted(options.signal); const bytes = centralHeader(entry); yield bytes; offset += bytes.length; }
  yield endHeader(index.length, offset - centralOffset, centralOffset); record?.(index);
}

/** Deterministic STORE V1: UTF-8, signed data descriptors, 1980-01-01,
 * regular files, no extras/comments/ZIP64. Measurement verifies the sources and
 * computes the exact output SHA/length in one pass; output reopens the same
 * frozen entries in a second pass. No provider/multipart assumptions occur. */
export function createStoreArchiveStream(entries: readonly ArchiveEntry[], openEntry: OpenArchiveEntry, options: ArchiveOptions = {}) {
  const frozen = checkedEntries(entries); if (predictedSize(frozen) > RESEARCH_ARCHIVE_MAX_BYTES) limit();
  const linked = streamOptions(options);
  return iteratorStream(storeArchiveChunks(frozen, openEntry, linked.options), linked.options.signal, linked.cancel, linked.ended);
}
export async function measureStoreArchive(entries: readonly ArchiveEntry[], openEntry: OpenArchiveEntry, options: ArchiveOptions = {}): Promise<MeasuredStoreArchive> {
  const hash = hashFactory(options)(); let byteSize = 0, index: ArchiveIndexEntry[] = [];
  try {
    for await (const bytes of storeArchiveChunks(entries, openEntry, options, result => { index = result; })) { aborted(options.signal); await writeHash(hash, bytes); byteSize += bytes.length; }
    return { byteSize, sha256: await finishHash(hash), entries: index };
  } catch (error) { abortHash(hash); throw error; }
}

/** A retained sequential cursor supports bounded read() calls. Backward reads
 * reopen once; forward reads discard prefixes without retaining them. open()
 * creates one independent range stream with bounded output. close() cancels
 * every held reader. bytesRead counts physical skipped and delivered bytes. */
export function sourceFromStream(byteSize: number, reopen: (signal?: AbortSignal) => Promise<ReadableStream<Uint8Array>>): ArchiveSource & { readonly bytesRead: number; close(): void; dispose(): void } {
  if (!safeNumber(byteSize) || byteSize > RESEARCH_ARCHIVE_MAX_BYTES) limit();
  interface RawCursor { reader: ReadableStreamDefaultReader<Uint8Array>; position: number; pending: Uint8Array; signal?: AbortSignal; onAbort: () => void; closed: boolean }
  const cursors = new Set<RawCursor>(); let retained: RawCursor | undefined, bytesRead = 0, busy = false;
  const closeCursor = (cursor: RawCursor) => { if (cursor.closed) return; cursor.closed = true; cursor.signal?.removeEventListener("abort", cursor.onAbort); cancel(cursor.reader); try { cursor.reader.releaseLock(); } catch { /* Pending read is cancelled. */ } cursors.delete(cursor); };
  async function cursor(signal?: AbortSignal): Promise<RawCursor> {
    aborted(signal); const raw = await reopen(signal), reader = raw.getReader();
    if (signal?.aborted) { cancel(reader, signal.reason); reader.releaseLock(); aborted(signal); }
    const value: RawCursor = { reader, position: 0, pending: new Uint8Array(), signal, closed: false, onAbort: () => closeCursor(value) };
    cursors.add(value); signal?.addEventListener("abort", value.onAbort, { once: true }); if (signal?.aborted) { closeCursor(value); aborted(signal); } return value;
  }
  async function take(value: RawCursor, maximum: number) {
    aborted(value.signal); if (value.closed) invalid("Research source reader is closed.");
    while (!value.pending.length) {
      const next = await value.reader.read(); aborted(value.signal); if (next.done) integrity("Research source is truncated.");
      if (!(next.value instanceof Uint8Array)) invalid("Research source did not supply byte chunks.");
      bytesRead += next.value.length; value.pending = next.value;
      if (next.value.length > byteSize - value.position) integrity("Research source exceeds its declared byte size.");
    }
    const bytes = value.pending.subarray(0, maximum); value.pending = value.pending.subarray(bytes.length); value.position += bytes.length; return bytes;
  }
  async function skip(value: RawCursor, offset: number) { while (value.position < offset) await take(value, Math.min(RESEARCH_ARCHIVE_CHUNK_BYTES, offset - value.position)); }
  async function end(value: RawCursor) { if (value.pending.length || !(await value.reader.read()).done) integrity("Research source exceeds its declared byte size."); }
  const source: ArchiveSource & { readonly bytesRead: number; close(): void; dispose(): void } = {
    byteSize, get bytesRead() { return bytesRead; },
    async read(offset, length, signal) {
      range(source, offset, length); if (length > RESEARCH_ARCHIVE_CHUNK_BYTES) limit(); aborted(signal); if (busy) invalid("Concurrent retained research reads are unsupported."); busy = true;
      try {
        if (!retained || retained.closed || retained.position > offset || retained.signal !== signal) { if (retained) closeCursor(retained); retained = await cursor(signal); }
        await skip(retained, offset); const bytes = new Uint8Array(length); let at = 0;
        while (at < length) { const part = await take(retained, length - at); bytes.set(part, at); at += part.length; }
        if (offset + length === byteSize) { await end(retained); closeCursor(retained); } return bytes;
      } catch (error) { if (retained) closeCursor(retained); throw error; } finally { busy = false; }
    },
    async open(offset, length, signal) {
      range(source, offset, length); aborted(signal); const value = await cursor(signal); let remaining = length, started = false, output: ReadableStreamDefaultController<Uint8Array>;
      const onAbort = () => { output.error(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")); closeCursor(value); };
      return new ReadableStream<Uint8Array>({
        start(controller) { output = controller; signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort(); },
        async pull(controller) {
          try { aborted(signal); if (!started) { await skip(value, offset); started = true; }
            if (!remaining) { if (offset + length === byteSize) await end(value); signal?.removeEventListener("abort", onAbort); closeCursor(value); controller.close(); return; }
            const bytes = await take(value, Math.min(remaining, RESEARCH_ARCHIVE_CHUNK_BYTES)); remaining -= bytes.length; controller.enqueue(bytes);
          } catch (error) { signal?.removeEventListener("abort", onAbort); closeCursor(value); controller.error(error); }
        }, cancel() { signal?.removeEventListener("abort", onAbort); closeCursor(value); },
      }, { highWaterMark: 0 });
    },
    close() { for (const value of [...cursors]) closeCursor(value); retained = undefined; }, dispose() { source.close(); },
  }; return source;
}
export function sourceFromBlob(blob: Blob): ArchiveSource {
  const source: ArchiveSource = { byteSize: blob.size,
    async read(offset, length, signal) { range(source, offset, length); if (length > RESEARCH_ARCHIVE_CHUNK_BYTES) limit(); aborted(signal); const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); aborted(signal); return bytes; },
    async open(offset, length, signal) { range(source, offset, length); aborted(signal); return blob.slice(offset, offset + length).stream(); },
  }; return source;
}
async function openRange(source: ArchiveSource, offset: number, length: number, signal?: AbortSignal) {
  range(source, offset, length); aborted(signal); if (source.open) return source.open(offset, length, signal);
  let position = offset;
  return new ReadableStream<Uint8Array>({ async pull(controller) {
    try { aborted(signal); if (position === offset + length) { controller.close(); return; }
      const requested = Math.min(RESEARCH_ARCHIVE_CHUNK_BYTES, offset + length - position), bytes = await source.read(position, requested, signal);
      if (!(bytes instanceof Uint8Array) || bytes.length !== requested) integrity("Research archive range is incomplete."); position += bytes.length; controller.enqueue(bytes);
    } catch (error) { controller.error(error); }
  } }, { highWaterMark: 0 });
}
class ByteCursor {
  position = 0; private pending: Uint8Array = new Uint8Array(); private ended = false;
  private reader: ReadableStreamDefaultReader<Uint8Array>; private onAbort: () => void;
  constructor(stream: ReadableStream<Uint8Array>, private options: ArchiveOptions, private hash?: ArchiveHash) {
    this.reader = stream.getReader(); this.onAbort = () => cancel(this.reader, options.signal?.reason); options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) { cancel(this.reader, options.signal.reason); this.reader.releaseLock(); options.signal.removeEventListener("abort", this.onAbort); aborted(options.signal); }
  }
  async take(length: number): Promise<Uint8Array> {
    if (!safeNumber(length) || length > RESEARCH_ARCHIVE_CHUNK_BYTES) invalid(); aborted(this.options.signal);
    const result = new Uint8Array(length); let filled = 0;
    while (filled < length) {
      if (!this.pending.length) {
        const next = await this.reader.read(); aborted(this.options.signal); if (next.done) integrity("Research ZIP is truncated.");
        if (!(next.value instanceof Uint8Array)) invalid(); this.pending = next.value; if (this.hash) await writeHash(this.hash, next.value);
      }
      const count = Math.min(length - filled, this.pending.length); result.set(this.pending.subarray(0, count), filled); this.pending = this.pending.subarray(count); filled += count; this.position += count;
    } return result;
  }
  async finish() { if (this.pending.length || !(await this.reader.read()).done) invalid("Research ZIP has trailing bytes."); aborted(this.options.signal); this.ended = true; }
  close() { this.options.signal?.removeEventListener("abort", this.onAbort); if (!this.ended) cancel(this.reader); this.reader.releaseLock(); }
}
async function readAt(source: ArchiveSource, offset: number, length: number, signal?: AbortSignal) {
  range(source, offset, length); if (length > RESEARCH_ARCHIVE_CHUNK_BYTES) limit(); aborted(signal);
  const bytes = await source.read(offset, length, signal); aborted(signal); if (!(bytes instanceof Uint8Array) || bytes.length !== length) integrity("Research ZIP range is incomplete."); return bytes;
}
function parseIndex(tail: Uint8Array, tailOffset: number, byteSize: number): { headers: ArchiveEntryHeader[]; centralOffset: number; centralBytes: Uint8Array; endBytes: Uint8Array } {
  const endBytes = tail.subarray(tail.length - 22), end = view(endBytes);
  if (end.getUint32(0, true) !== END || end.getUint16(4, true) || end.getUint16(6, true) || end.getUint16(20, true)) invalid("Unsupported research ZIP end record.");
  const count = end.getUint16(10, true), centralSize = end.getUint32(12, true), centralOffset = end.getUint32(16, true);
  if (count !== end.getUint16(8, true) || count < 4 || count > RESEARCH_ARCHIVE_MAX_FILES + 4
    || centralSize > RESEARCH_ARCHIVE_CHUNK_BYTES - 22 || centralOffset < tailOffset || centralOffset + centralSize !== byteSize - 22) invalid("Research ZIP directory bounds are invalid.");
  const centralBytes = tail.subarray(centralOffset - tailOffset, tail.length - 22), headers: ArchiveEntryHeader[] = []; let offset = 0, dataEnd = 0;
  for (let item = 0; item < count; item++) {
    if (offset + 46 > centralBytes.length) invalid(); const data = view(centralBytes.subarray(offset));
    const nameLength = data.getUint16(28, true), length = 46 + nameLength;
    if (data.getUint32(0, true) !== CENTRAL || data.getUint16(4, true) !== MADE_BY || data.getUint16(6, true) !== VERSION
      || data.getUint16(8, true) !== FLAGS || data.getUint16(10, true) || data.getUint16(12, true) || data.getUint16(14, true) !== DOS_DATE
      || data.getUint16(30, true) || data.getUint16(32, true) || data.getUint16(34, true) || data.getUint16(36, true)
      || data.getUint32(38, true) !== REGULAR_ATTRIBUTES || nameLength < 1 || nameLength > 134 || offset + length > centralBytes.length) invalid("Unsupported research ZIP member header.");
    let path: string; try { path = decoder.decode(centralBytes.subarray(offset + 46, offset + length)); } catch { return invalid("Research ZIP paths must be valid UTF-8."); }
    const byteSize = data.getUint32(24, true), localHeaderOffset = data.getUint32(42, true);
    if (byteSize !== data.getUint32(20, true) || localHeaderOffset !== dataEnd) invalid("Overlapping or inconsistent research ZIP members.");
    const dataOffset = localHeaderOffset + 30 + nameLength, descriptorOffset = dataOffset + byteSize;
    dataEnd = descriptorOffset + 16; if (dataEnd > centralOffset) invalid("Research ZIP member escapes its directory boundary.");
    headers.push({ path, kind: kindFor(path), byteSize, crc32: data.getUint32(16, true), localHeaderOffset, dataOffset, descriptorOffset }); offset += length;
  }
  if (offset !== centralBytes.length || dataEnd !== centralOffset) invalid("Research ZIP contains undeclared byte regions.");
  checkHeaders(headers, true); return { headers, centralOffset, centralBytes, endBytes };
}
function compareExpected(headers: readonly ArchiveEntryHeader[], expected: readonly ArchiveEntry[]) {
  const entries = checkedEntries(expected); if (entries.length !== headers.length) invalid("Research ZIP members do not match their declaration.");
  for (let at = 0; at < entries.length; at++) if (entries[at].path !== headers[at].path || entries[at].byteSize !== headers[at].byteSize
    || entries[at].kind !== headers[at].kind || entries[at].crc32 !== undefined && entries[at].crc32 !== headers[at].crc32) integrity("Research ZIP member declaration changed.");
  return new Map(entries.map(entry => [entry.path, entry]));
}

/** Validate the directory with one bounded tail read, then verify the entire
 * ZIP sequentially: local headers, every member CRC/SHA, descriptors, central
 * directory and EOF. A reopened sequential source needs at most two full ZIP
 * passes. Metadata remains inert bytes; no report HTML/URL is executed or
 * fetched. Catalog/relationship authority belongs to the caller's resolver. */
export async function validateStoreArchive(source: ArchiveSource, options: ValidateStoreArchiveOptions): Promise<ValidatedStoreArchive> {
  checkSource(source); if (typeof options.expectedSha256 !== "string" || !shaPattern.test(options.expectedSha256)) invalid("An exact research ZIP SHA-256 is required.");
  let cursor: ByteCursor | undefined; const zipHash = hashFactory(options)();
  try {
    const tailLength = Math.min(source.byteSize, RESEARCH_ARCHIVE_CHUNK_BYTES), tailOffset = source.byteSize - tailLength;
    const index = parseIndex(await readAt(source, tailOffset, tailLength, options.signal), tailOffset, source.byteSize);
    await source.close?.(); cursor = new ByteCursor(await openRange(source, 0, source.byteSize, options.signal), options, zipHash);
    const metadata = new Map<string, Uint8Array>(), entries: ArchiveIndexEntry[] = [];
    let expected = typeof options.expectedEntries === "function" ? undefined : options.expectedEntries ? compareExpected(index.headers, options.expectedEntries) : undefined;
    for (const header of index.headers) {
      aborted(options.signal); if (cursor.position !== header.localHeaderOffset || !bytesEqual(await cursor.take(localHeader(header).length), localHeader(header))) invalid("Local and central research ZIP headers disagree.");
      const memberHash = hashFactory(options)(); let crc = 0xffffffff, left = header.byteSize, offset = 0;
      const captured = header.kind === "payload" ? undefined : new Uint8Array(header.byteSize);
      try {
        while (left) { const bytes = await cursor.take(Math.min(left, RESEARCH_ARCHIVE_CHUNK_BYTES)); await memberHash.write(bytes); crc = crcUpdate(crc, bytes); captured?.set(bytes, offset); offset += bytes.length; left -= bytes.length; }
        const sha256 = await finishHash(memberHash); crc = (crc ^ 0xffffffff) >>> 0;
        if (crc !== header.crc32 || !bytesEqual(await cursor.take(16), descriptor(header))) integrity("Research ZIP member CRC or descriptor is corrupt.");
        if (expected?.get(header.path)?.sha256 !== undefined && expected.get(header.path)!.sha256 !== sha256) integrity("Research ZIP member SHA-256 does not match its declaration.");
        entries.push({ ...header, sha256 });
      } catch (error) { abortHash(memberHash); throw error; }
      if (captured) { try { decoder.decode(captured); } catch { invalid("Research metadata must be valid UTF-8."); } metadata.set(header.path, captured); }
      if (metadata.size === 4 && typeof options.expectedEntries === "function" && !expected) {
        expected = compareExpected(index.headers, await options.expectedEntries(metadata, index.headers));
        for (const entry of entries) if (expected.get(entry.path)!.sha256 !== entry.sha256) integrity("Research metadata SHA-256 does not match its declaration.");
      }
    }
    if (!bytesEqual(await cursor.take(index.centralBytes.length), index.centralBytes) || !bytesEqual(await cursor.take(22), index.endBytes)) invalid("Research ZIP directory changed during reading.");
    await cursor.finish(); const sha256 = await finishHash(zipHash); if (sha256 !== options.expectedSha256) integrity("The complete research ZIP SHA-256 changed.");
    return { byteSize: source.byteSize, sha256, entries, metadata };
  } catch (error) { abortHash(zipHash); throw error; }
  finally { cursor?.close(); await source.close?.(); }
}

/** Extract a previously validated member from one fresh range/skip stream.
 * Its local header and descriptor are rechecked; successful EOF requires exact
 * full bytes, CRC and SHA. A staging writer must await this terminal proof. */
export async function openStoreArchiveEntry(source: ArchiveSource, entry: ArchiveIndexEntry, options: ArchiveOptions = {}): Promise<ReadableStream<Uint8Array>> {
  checkSource(source); if (kindFor(entry.path) !== entry.kind || !safeNumber(entry.byteSize) || typeof entry.sha256 !== "string" || !shaPattern.test(entry.sha256)
    || !safeNumber(entry.crc32) || entry.crc32 > 0xffffffff || !safeNumber(entry.localHeaderOffset)
    || entry.dataOffset !== entry.localHeaderOffset + localHeader(entry).length || entry.descriptorOffset !== entry.dataOffset + entry.byteSize) invalid("Invalid verified research entry index.");
  if (entry.byteSize > (entry.kind === "payload" ? RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES : RESEARCH_ARCHIVE_METADATA_MAX_BYTES)) limit();
  range(source, entry.localHeaderOffset, localHeader(entry).length + entry.byteSize + 16);
  const linked = streamOptions(options);
  async function* chunks() {
    const stream = await openRange(source, entry.localHeaderOffset, localHeader(entry).length + entry.byteSize + 16, linked.options.signal);
    const cursor = new ByteCursor(stream, linked.options), hash = hashFactory(linked.options)(); let complete = false, crc = 0xffffffff, left = entry.byteSize;
    try {
      if (!bytesEqual(await cursor.take(localHeader(entry).length), localHeader(entry))) invalid("Research member local header changed.");
      while (left) { const bytes = await cursor.take(Math.min(left, RESEARCH_ARCHIVE_CHUNK_BYTES)); await hash.write(bytes); crc = crcUpdate(crc, bytes); left -= bytes.length; yield bytes; }
      if (!bytesEqual(await cursor.take(16), descriptor(entry)) || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32 || await finishHash(hash) !== entry.sha256) integrity("Extracted research member failed complete verification.");
      await cursor.finish(); complete = true;
    } finally { if (!complete) abortHash(hash); cursor.close(); }
  }
  return iteratorStream(chunks(), linked.options.signal, linked.cancel, linked.ended);
}
