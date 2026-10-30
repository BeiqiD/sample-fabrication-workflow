// Independent Node process; only newly provisioned synthetic scratch roots.
import { createHash } from "node:crypto";
import type { ByteWriteInput } from "../../worker/files/byte-writer";
const [moduleUrl, root, namespaceJson, mode] = process.argv.slice(2);
if (!moduleUrl || !/^\/(?:tmp|workspace)\/rt3-local-byte-[^/]+\/private-objects$/.test(root || "") || !namespaceJson || !["before-publish", "after-publish", "file-limit"].includes(mode)) throw new Error("Invalid private process fixture");
const { openLocalByteStorage, LocalByteStorageError } = await import(moduleUrl) as typeof import("./local-byte-storage");
const storage = await openLocalByteStorage({ root, namespace: JSON.parse(namespaceJson) });
const bytes = mode === "file-limit" ? new Uint8Array(32 * 1024).fill(7) : new TextEncoder().encode("independent process bytes");
let body: ByteWriteInput["body"] = bytes.buffer;
if (mode === "before-publish") {
  // A held source is a deliberate crash cut point; its parent owns a two-second
  // finite deadline and SIGKILL, so unsettled top-level await cannot exit first.
  setInterval(() => {}, 1000);
  let pull = 0;
  body = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (!pull++) controller.enqueue(bytes);
    else { process.stdout.write("STAGED\n"); await new Promise<void>(() => {}); }
  } }, { highWaterMark: 0 });
}
if (mode === "file-limit") process.on("SIGXFSZ", () => {});
try {
  await storage.writer.write({ key: mode, body, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "application/octet-stream", filename: "private.bin" });
  if (mode === "after-publish") process.kill(process.pid, "SIGKILL"); // No write ACK is delivered to the parent.
  else throw new Error("Expected fault did not occur");
} catch (error) {
  if (mode !== "file-limit" || !(error instanceof LocalByteStorageError) || error.reason !== "unavailable") throw error;
  process.stdout.write("WRITE_FAILED\n"); await storage.close();
}
