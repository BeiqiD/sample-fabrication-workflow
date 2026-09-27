import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const root = new URL("../", import.meta.url);
let mf;
before(async () => {
  const built = await build({ stdin: {
    sourcefile: "shadow-r2-writer-native.ts", resolveDir: fileURLToPath(root),
    contents: `
      import { r2ShadowByteWriter } from './worker/files/storage-adapters/r2-shadow-writer.ts';
      const abandonedReaders = [];
      export default { async fetch(request, env) {
        const input = await request.json();
        let calls = 0, pulls = 0, cancelled = 0;
        const encoder = new TextEncoder();
        const chunks = input.chunks.map(value => encoder.encode(value));
        let offset = 0;
        const stream = new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (offset < chunks.length) controller.enqueue(chunks[offset++]);
            else if (input.sourceFault) controller.error(new Error('private source failure'));
            else controller.close();
          },
          cancel() { cancelled += 1; },
        }, { highWaterMark: 0 });
        const body = input.buffer ? encoder.encode(input.chunks.join('')).buffer : stream;
        const writer = r2ShadowByteWriter({ async put(key, value, options) {
          calls += 1;
          if (input.rejectWithLockedReader) {
            abandonedReaders.push(value.getReader());
            throw new Error('private destination failure with abandoned reader');
          }
          if (input.rejectBeforeRead) throw new Error('private destination failure');
          const result = await env.ASSETS.put(key, value, options);
          if (input.loseAcknowledgement) throw new Error('private committed acknowledgement failure');
          return result;
        } });
        let error = null;
        try { await writer.write({ key: input.key, body, byteSize: input.byteSize,
          sha256: 'a'.repeat(64), contentType: 'application/octet-stream', filename: 'fixture.bin' }); }
        catch (caught) { error = { name: caught.name, side: caught.side, reason: caught.reason, message: caught.message }; }
        const stored = await env.ASSETS.get(input.key);
        return Response.json({ ok: error === null, error, calls, pulls, cancelled, locked: stream.locked,
          text: stored ? await stored.text() : null, size: stored?.size ?? null,
          contentType: stored?.httpMetadata.contentType ?? null });
      } };`,
  }, platform: "neutral", bundle: true, format: "esm", write: false });
  mf = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-07-20", r2Buckets: ["ASSETS"], log: new Log(LogLevel.ERROR) });
});
after(async () => { await mf?.dispose(); });

async function write(input) {
  const response = await mf.dispatchFetch("https://qualification.invalid/", {
    method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("native R2 accepts a zero-length known-length stream", { timeout: 15_000 }, async () => {
  const result = await write({ key: "zero", chunks: [], byteSize: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.calls, 1);
  assert.equal(result.text, "");
  assert.equal(result.size, 0);
  assert.equal(result.locked, false);
});

test("native R2 consumes multiple chunks with exact content length and metadata", { timeout: 15_000 }, async () => {
  const result = await write({ key: "multi", chunks: ["one", "", "二", "three"], byteSize: 11 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.calls, 1);
  assert.equal(result.text, "one二three");
  assert.equal(result.size, 11);
  assert.equal(result.contentType, "application/octet-stream");
  assert.equal(result.locked, false);
});

test("native R2 rejects short streams and settles both sides", { timeout: 15_000 }, async () => {
  const result = await write({ key: "short", chunks: ["short"], byteSize: 6 });
  assert.equal(result.ok, false);
  assert.equal(result.error.name, "ByteVerificationError");
  assert.equal(result.calls, 1);
  assert.equal(result.text, null);
  assert.equal(result.locked, false);
});

test("native R2 rejects oversized streams and cancels their unread tail", { timeout: 15_000 }, async () => {
  const result = await write({ key: "long", chunks: ["too-long", "unread-tail"], byteSize: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.error.name, "ByteVerificationError");
  assert.equal(result.calls, 1);
  assert.equal(result.text, null);
  assert.equal(result.cancelled, 1);
  assert.equal(result.locked, false);
});

test("native R2 propagates source failure without a successful or retried write", { timeout: 15_000 }, async () => {
  const result = await write({ key: "source-fault", chunks: ["partial"], byteSize: 20, sourceFault: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.name, "ByteVerificationError");
  assert.equal(result.calls, 1);
  assert.equal(result.text, null);
  assert.equal(result.locked, false);
});

test("provider rejection before consumption cancels the source without hanging", { timeout: 15_000 }, async () => {
  const result = await write({ key: "provider-reject", chunks: ["one", "two", "three"], byteSize: 11, rejectBeforeRead: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, "unavailable");
  assert.equal(result.calls, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.locked, false);
  assert.equal(result.text, null);
});

test("a lost R2 acknowledgement preserves the committed object and never replays PUT", { timeout: 15_000 }, async () => {
  const result = await write({ key: "ack-lost", chunks: ["committed", " bytes"], byteSize: 15, loseAcknowledgement: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, "unavailable");
  assert.equal(result.calls, 1);
  assert.equal(result.text, "committed bytes");
  assert.equal(result.size, 15);
  assert.equal(result.locked, false);
});

test("provider rejection with an abandoned reader still cancels the source and settles", { timeout: 15_000 }, async () => {
  const result = await write({ key: "provider-abandoned-reader", chunks: ["one", "two", "three"], byteSize: 11,
    rejectWithLockedReader: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, "unavailable");
  assert.equal(result.calls, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.locked, false);
  assert.equal(result.text, null);
});

test("buffer length and stream bounds reject before opening R2", { timeout: 15_000 }, async () => {
  for (const input of [
    { key: "bad-buffer", chunks: ["bytes"], byteSize: 6, buffer: true },
    { key: "bad-bound", chunks: ["bytes"], byteSize: 104857601 },
  ]) {
    const result = await write(input);
    assert.equal(result.ok, false);
    assert.equal(result.calls, 0);
    assert.equal(result.text, null);
    if (!input.buffer) assert.equal(result.cancelled, 1);
  }
});
