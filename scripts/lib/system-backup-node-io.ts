import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArchiveSource, ArchiveOptions } from "../../shared/domain/research-archive";

export const recoverySqlIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const nodeRecoverySha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const NODE_RECOVERY_ARCHIVE_OPTIONS: ArchiveOptions = { createHash: () => {
  const hash = createHash("sha256"); return { write(bytes) { hash.update(bytes); }, finish() { return hash.digest("hex"); } };
} };
export async function nodeRecoveryFileSha256(path: string) {
  const hash = createHash("sha256"); let byteSize = 0;
  for await (const bytes of createReadStream(path, { highWaterMark: 64 * 1024 })) { hash.update(bytes); byteSize += bytes.length; }
  return { sha256: hash.digest("hex"), byteSize };
}
export async function nodeRecoveryArchiveSource(path: string): Promise<ArchiveSource> {
  const details = await stat(path); if (!details.isFile()) throw new Error("System backup source must be a local regular file");
  const range = (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || offset > details.size || length > details.size - offset) throw new Error("Invalid system backup byte range");
  };
  return { byteSize: details.size,
    async read(offset, length, signal) {
      range(offset, length); signal?.throwIfAborted();
      if (length > 64 * 1024) throw new Error("System backup random read exceeded its bounded chunk");
      const file = await open(path, "r");
      try {
        const bytes = new Uint8Array(length); let cursor = 0;
        while (cursor < length) { signal?.throwIfAborted(); const next = await file.read(bytes, cursor, length - cursor, offset + cursor); if (!next.bytesRead) throw new Error("System backup source was truncated"); cursor += next.bytesRead; }
        return bytes;
      } finally { await file.close(); }
    },
    async open(offset, length, signal) {
      range(offset, length); signal?.throwIfAborted();
      if (!length) return new ReadableStream({ start(controller) { controller.close(); } });
      return Readable.toWeb(createReadStream(path, { start: offset, end: offset + length - 1, highWaterMark: 64 * 1024, signal })) as ReadableStream<Uint8Array>;
    },
  };
}
export async function writePrivateRecoveryStream(path: string, stream: ReadableStream<Uint8Array>) {
  await pipeline(Readable.fromWeb(stream as unknown as import("node:stream/web").ReadableStream), createWriteStream(path, { flags: "wx", mode: 0o600 }));
}
