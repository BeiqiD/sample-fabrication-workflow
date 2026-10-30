import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

const CHUNK = 64 * 1024, MAX = 100 * 1024 * 1024;
function source(size, observation, corrupt = false) {
  let offset = 0;
  return new Readable({ highWaterMark: CHUNK, read() {
    if (offset === size) { this.push(null); return; }
    const chunk = Buffer.alloc(Math.min(CHUNK, size - offset), 37);
    if (corrupt && offset === 0) chunk[0] ^= 1;
    offset += chunk.length; observation.chunks += 1;
    observation.maxChunk = Math.max(observation.maxChunk, chunk.length);
    this.push(chunk);
  } });
}
async function digest(stream) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest("hex") };
}

export async function runTransferSpike({ bytes = 16 * 1024 * 1024 } = {}) {
  assert(Number.isSafeInteger(bytes) && bytes >= CHUNK && bytes <= MAX);
  const root = await mkdtemp(join(tmpdir(), "fp3-transfer-spike-"));
  const started = performance.now(), observation = { chunks: 0, maxChunk: 0 };
  try {
    const expected = await digest(source(bytes, { chunks: 0, maxChunk: 0 }));
    const candidate = join(root, `${randomUUID()}.candidate`);
    const sourceHash = createHash("sha256"); let sourceBytes = 0, forwarded = 0;
    const verifier = new Transform({ highWaterMark: CHUNK, transform(chunk, _encoding, done) {
      sourceBytes += chunk.length; sourceHash.update(chunk); forwarded += 1; done(null, chunk);
    } });
    await pipeline(source(bytes, observation), verifier, createWriteStream(candidate, { flags: "wx", highWaterMark: CHUNK }));
    assert.equal(sourceBytes, expected.bytes); assert.equal(sourceHash.digest("hex"), expected.sha256);
    assert.deepEqual(await digest(createReadStream(candidate, { highWaterMark: CHUNK })), expected);
    assert.equal(forwarded, Math.ceil(bytes / CHUNK)); assert.equal(observation.maxChunk, CHUNK);
    assert.notEqual((await digest(source(bytes, { chunks: 0, maxChunk: 0 }, true))).sha256, expected.sha256);
    // A transport acknowledgement before EOF never supplies whole-byte evidence.
    const early = source(bytes, { chunks: 0, maxChunk: 0 });
    const iterator = early[Symbol.asyncIterator](); await iterator.next();
    assert.equal(early.readableEnded, false); await iterator.return();

    const interrupted = join(root, `${randomUUID()}.zip.candidate`);
    const zip = new JSZip(); zip.file("source.bin", createReadStream(candidate), { binary: true });
    let outputBytes = 0;
    const interrupt = new Transform({ transform(chunk, _encoding, done) {
      outputBytes += chunk.length;
      if (outputBytes > CHUNK) done(new Error("simulated process interruption")); else done(null, chunk);
    } });
    await assert.rejects(pipeline(zip.generateNodeStream({ streamFiles: true, compression: "STORE" }), interrupt,
      createWriteStream(interrupted, { flags: "wx" })), /simulated process interruption/);
    const partialBytes = (await stat(interrupted)).size;
    await assert.rejects(JSZip.loadAsync(await readFile(interrupted)));
    // The old execution has positively settled locally. Discard it, rebuild from
    // the pinned source under a new output identity, then independently verify.
    const rebuilt = join(root, `${randomUUID()}.zip.candidate`);
    assert.notEqual(rebuilt, interrupted);
    const retryZip = new JSZip(); retryZip.file("source.bin", createReadStream(candidate), { binary: true });
    await pipeline(retryZip.generateNodeStream({ streamFiles: true, compression: "STORE" }),
      createWriteStream(rebuilt, { flags: "wx", highWaterMark: CHUNK }));
    // Bounded output transport is qualified above. ZIP validation here is a
    // deliberately small fixture and makes no bounded import/archive claim.
    const loaded = await JSZip.loadAsync(await readFile(rebuilt));
    assert.deepEqual(await digest(new Readable().wrap(loaded.file("source.bin").nodeStream())), expected);
    return { runtime: "node-local-fixture", bytes, hashChunkBytes: CHUNK,
      sourceChunks: observation.chunks, maxSourceChunk: observation.maxChunk,
      independentlyVerified: true, corruptionRejected: true, earlyAckRejected: true,
      interruptedOutputBytes: partialBytes, rebuiltWithNewKey: true,
      elapsedMs: Math.round(performance.now() - started) };
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runTransferSpike(), null, 2));
}
