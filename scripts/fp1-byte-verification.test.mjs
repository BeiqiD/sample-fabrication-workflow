import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const root = new URL("../", import.meta.url);
const LIMIT = 100 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

// The host provides the expected digest independently of the Worker algorithm.
// The host always generates one chunk at a time. The streaming Worker fixture
// does too; the R2 fixture deliberately starts with the caller-owned buffer.
function fixtureSha256(byteSize) {
  const hash = createHash("sha256");
  for (let offset = 0, index = 0; offset < byteSize; offset += CHUNK_BYTES, index++) {
    hash.update(Buffer.alloc(Math.min(CHUNK_BYTES, byteSize - offset), (index * 31 + 7) % 251));
  }
  return hash.digest("hex");
}

const workerSource = `
import { MAX_VERIFIED_BYTES } from "./worker/files/byte-verification.ts";
import { writeVerifiedBytes } from "./worker/files/byte-writer.ts";
import { cloudflareSha256 } from "./worker/files/storage-adapters/cloudflare-sha256.ts";
import { managedByteWriter } from "./worker/files/storage-adapters/managed-writer.ts";
import { managedByteReader } from "./worker/files/storage-adapters/managed-reader.ts";
import { r2ByteWriter } from "./worker/files/storage-adapters/r2-writer.ts";
import { r2ByteReader } from "./worker/files/storage-adapters/r2-reader.ts";

export default {
  async fetch(request, env) {
    const { mode, byteSize, sha256, chunkBytes } = await request.json();
    const stats = {
      puts: 0, gets: 0, stats: 0, deletes: 0, consumedBytes: 0,
      sourceChunks: 0, consumedChunks: 0, sourceCancels: 0,
      destinationChunks: 0, maxSourceLead: 0, hashes: [],
      nativeDigestStream: typeof crypto.DigestStream === "function",
      limit: MAX_VERIFIED_BYTES,
    };
    let bufferedBody;
    function fixture(destination = false) {
      let offset = 0;
      let index = 0;
      const length = byteSize - (destination && mode === "truncated" ? 1 : 0);
      return new ReadableStream({
        pull(controller) {
          if (offset === length) {
            if (destination && mode === "tail-error") {
              controller.error(new Error("fixture destination failed after its final bytes"));
            } else controller.close();
            return;
          }
          const bytes = new Uint8Array(Math.min(chunkBytes, length - offset));
          bytes.fill((index * 31 + 7) % 251);
          if (destination && mode === "wrong-hash" && index === 0) bytes[0] ^= 1;
          offset += bytes.length;
          index++;
          if (destination) stats.destinationChunks++;
          else {
            stats.sourceChunks++;
            stats.maxSourceLead = Math.max(stats.maxSourceLead, stats.sourceChunks - stats.consumedChunks);
          }
          controller.enqueue(bytes);
        },
        cancel() { if (!destination) stats.sourceCancels++; },
      }, { highWaterMark: 0 });
    }
    // This is an in-process transport fixture, not a remote provider claim.
    // The real managed adapters wrap it, and it consumes/discards upload chunks.
    const transport = {
      async put(input) {
        stats.puts++;
        const reader = input.body.getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            stats.consumedBytes += next.value.byteLength;
            stats.consumedChunks++;
          }
        } finally { reader.releaseLock(); }
        if (mode === "unknown-put") throw new Error("fixture PUT response was lost after consumption");
        return { byteSize: stats.consumedBytes };
      },
      async get() {
        stats.gets++;
        return { body: fixture(true), contentType: "application/octet-stream", etag: "untrusted-etag" };
      },
      async stat() { stats.stats++; throw new Error("unexpected metadata-only verification"); },
      async delete() { stats.deletes++; throw new Error("unexpected cleanup"); },
    };
    const createHash = () => {
      const native = cloudflareSha256();
      const source = stats.hashes.length === 0;
      const observed = { writes: 0, bytes: 0, maxWriteBytes: 0, finished: false, aborted: false };
      stats.hashes.push(observed);
      return {
        async write(bytes) {
          observed.writes++;
          observed.bytes += bytes.byteLength;
          observed.maxWriteBytes = Math.max(observed.maxWriteBytes, bytes.byteLength);
          if (source && bufferedBody) {
            stats.sourceUsesOriginalBuffer &&= bytes.buffer === bufferedBody;
          }
          await native.write(bytes);
        },
        async finish() {
          const digest = await native.finish();
          observed.finished = true;
          return digest;
        },
        async abort() { observed.aborted = true; await native.abort(); },
      };
    };
    try {
      let storage = {
        reader: managedByteReader(transport), writer: managedByteWriter(transport), createHash,
      };
      let body;
      if (mode === "r2-buffer") {
        bufferedBody = new ArrayBuffer(byteSize);
        for (let offset = 0, index = 0; offset < byteSize; offset += chunkBytes, index++) {
          new Uint8Array(bufferedBody, offset, Math.min(chunkBytes, byteSize - offset))
            .fill((index * 31 + 7) % 251);
        }
        stats.sourceUsesOriginalBuffer = true;
        const bucket = {
          async put(key, input, options) {
            stats.puts++;
            stats.originalBufferAtPut = input instanceof ArrayBuffer && input === bufferedBody;
            return env.BUCKET.put(key, input, options);
          },
          async get(key) { stats.gets++; return env.BUCKET.get(key); },
          async head(key) { stats.stats++; return env.BUCKET.head(key); },
        };
        storage = { reader: r2ByteReader(bucket), writer: r2ByteWriter(bucket), createHash };
        body = bufferedBody;
      } else body = fixture();
      const evidence = await writeVerifiedBytes(storage, {
        key: "qualification/object.bin", body, byteSize, sha256,
        filename: "object.bin", contentType: "application/octet-stream",
      });
      return Response.json({ outcome: "verified", evidence, stats });
    } catch (error) {
      return Response.json({ outcome: "rejected", phase: error.phase, reason: error.reason, stats });
    }
  },
};
`;

test("native workerd verifies bounded streaming writes and rejects incomplete evidence", { timeout: 60_000 }, async (t) => {
  const bundle = await build({
    stdin: { contents: workerSource, resolveDir: fileURLToPath(root), sourcefile: "fp1-byte-qualification-worker.mjs" },
    bundle: true, format: "esm", platform: "neutral", write: false,
  });
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-20", r2Buckets: ["BUCKET"], log: new Log(LogLevel.ERROR),
  });
  const smallSize = 2 * CHUNK_BYTES + 17;
  const smallSha256 = fixtureSha256(smallSize);
  async function exercise(mode, byteSize = smallSize, sha256 = smallSha256) {
    const response = await mf.dispatchFetch("https://qualification.test/", {
      method: "POST", body: JSON.stringify({ mode, byteSize, sha256, chunkBytes: CHUNK_BYTES }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.stats.nativeDigestStream, true);
    assert.equal(result.stats.limit, LIMIT);
    assert.equal(result.stats.stats, 0, "HEAD metadata cannot establish byte identity");
    assert.equal(result.stats.deletes, 0, "verification never owns candidate deletion");
    return result;
  }
  try {
    await t.test("100 MiB completes both native hashes with bounded writes and producer backpressure", async () => {
      const sha256 = fixtureSha256(LIMIT);
      const started = performance.now();
      const result = await exercise("complete", LIMIT, sha256);
      const elapsedMs = performance.now() - started;
      assert.equal(result.outcome, "verified");
      assert.deepEqual(result.evidence, { byteSize: LIMIT, sha256 });
      assert.equal(result.stats.puts, 1);
      assert.equal(result.stats.gets, 1);
      assert.equal(result.stats.consumedBytes, LIMIT);
      assert.equal(result.stats.sourceChunks, 100);
      assert.equal(result.stats.destinationChunks, 100);
      assert.equal(result.stats.maxSourceLead, 1);
      assert.deepEqual(result.stats.hashes, Array.from({ length: 2 }, () => ({
        writes: 1600, bytes: LIMIT, maxWriteBytes: 64 * 1024, finished: true, aborted: false,
      })));
      t.diagnostic(
        "Local workerd qualification: 100 MiB source + 100 MiB destination, "
        + "1 MiB producer chunks, 64 KiB maximum native hash write, 3,200 hash writes, "
        + elapsedMs.toFixed(1) + " ms host wall time. "
        + "This does not qualify a deployed Cloudflare CPU tier or a remote provider.",
      );
    });
    await t.test("10 MiB caller-owned buffer uses original views and verifies a real local R2 write", async () => {
      const byteSize = 10 * CHUNK_BYTES;
      const sha256 = fixtureSha256(byteSize);
      const result = await exercise("r2-buffer", byteSize, sha256);
      assert.equal(result.outcome, "verified");
      assert.deepEqual(result.evidence, { byteSize, sha256 });
      assert.equal(result.stats.puts, 1);
      assert.equal(result.stats.gets, 1);
      assert.equal(result.stats.sourceUsesOriginalBuffer, true, "source hashing must not copy the complete input buffer");
      assert.equal(result.stats.originalBufferAtPut, true, "the R2 adapter still receives the caller's ArrayBuffer");
      assert.equal(result.stats.hashes.length, 2);
      assert.equal(result.stats.hashes[0].writes, 160);
      for (const hash of result.stats.hashes) {
        assert.equal(hash.bytes, byteSize);
        assert(hash.maxWriteBytes <= 64 * 1024);
        assert.equal(hash.finished, true);
        assert.equal(hash.aborted, false);
      }
    });
    for (const [mode, reason] of [["wrong-hash", "hash_mismatch"], ["truncated", "size_mismatch"], ["tail-error", "unavailable"]]) {
      await t.test(mode + " destination cannot publish successful evidence", async () => {
        const result = await exercise(mode);
        assert.equal(result.outcome, "rejected");
        assert.equal(result.phase, "destination");
        assert.equal(result.reason, reason);
        assert.equal(result.stats.puts, 1);
        assert.equal(result.stats.gets, 1);
        assert.equal(result.stats.hashes[0].finished, true);
        assert.equal(result.stats.hashes[1].bytes, smallSize - (mode === "truncated" ? 1 : 0));
      });
    }
    await t.test("a declared size above 100 MiB rejects before opening a hash or doing I/O", async () => {
      const result = await exercise("oversize", LIMIT + 1, "0".repeat(64));
      assert.equal(result.outcome, "rejected");
      assert.equal(result.phase, "source");
      assert.equal(result.reason, "invalid_expectation");
      assert.equal(result.stats.puts, 0);
      assert.equal(result.stats.gets, 0);
      assert.equal(result.stats.sourceChunks, 0);
      assert.equal(result.stats.sourceCancels, 1);
      assert.deepEqual(result.stats.hashes, []);
    });
    await t.test("a consumed PUT with a lost response is not replayed, read back or deleted", async () => {
      const result = await exercise("unknown-put");
      assert.equal(result.outcome, "rejected");
      assert.equal(result.phase, "destination");
      assert.equal(result.reason, "unavailable");
      assert.equal(result.stats.puts, 1);
      assert.equal(result.stats.gets, 0);
      assert.equal(result.stats.consumedBytes, smallSize);
      assert.equal(result.stats.hashes.length, 1);
      assert.equal(result.stats.hashes[0].finished, true);
    });
  } finally { await mf.dispose(); }
});
