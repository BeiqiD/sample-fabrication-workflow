import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Native workerd supplies the actual FixedLengthStream, Request and crypto.
// Explicit barriers hold the original guard/provider acknowledgement after the
// source has failed; abort alone must not report the whole write as settled.
const workerSource = `
  import { s3ByteAdapter } from './s3-byte-adapter';
  function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
  export default { async fetch(request) {
    const mode = new URL(request.url).pathname.slice(1);
    const entered = deferred(), failSource = deferred(), sourceCancelled = deferred(), acknowledge = deferred();
    const events = [];
    let state = 'pending', error = null, sends = 0;
    const source = new ReadableStream({
      async pull(controller) { await failSource.promise; controller.enqueue(new Uint8Array([1, 2])); },
      cancel() { events.push('source-cancelled'); sourceCancelled.resolve(); }
    }, { highWaterMark: 0 });
    const adapter = s3ByteAdapter({ kind: 's3', endpoint: 'https://s3.amazonaws.com', bucket: 'examplebucket',
      region: 'us-east-1', root: '', forcePathStyle: false },
      { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' }, {
      beforeRequest: async () => {
        if (mode === 'guard') { events.push('guard-entered'); entered.resolve(); await acknowledge.promise; events.push('guard-settled'); }
        return true;
      },
      fetch: async signed => {
        sends++; events.push('provider-entered');
        const reader = signed.body.getReader();
        const originalRead = reader.read().catch(() => undefined);
        entered.resolve();
        await acknowledge.promise;
        await originalRead;
        reader.releaseLock(); events.push('provider-settled');
        return new Response(null, { status: 200 });
      }
    });
    const writing = adapter.writer.write({ key: 'held.bin', body: source, byteSize: 1,
      sha256: 'a'.repeat(64), contentType: 'application/octet-stream', filename: 'held.bin' }).then(
        () => { state = 'fulfilled'; },
        caught => { state = 'rejected'; error = { name: caught.name, phase: caught.phase, reason: caught.reason }; }
      );
    await entered.promise;
    failSource.resolve();
    await sourceCancelled.promise;
    // One task boundary lets all immediate cancellation continuations drain;
    // the original provider/guard remains explicitly held by acknowledge.
    await new Promise(resolve => setTimeout(resolve, 0));
    const before = { state, events: [...events] };
    acknowledge.resolve();
    await writing;
    return Response.json({ before, state, error, sends, events, locked: source.locked });
  } };
`;

describe("S3 streaming failure settlement", () => {
  it.each(["provider", "guard"])("waits for the original %s acknowledgement after source failure", async mode => {
    const bundled = await build({ stdin: { loader: "ts", resolveDir: fileURLToPath(new URL(".", import.meta.url)), contents: workerSource },
      bundle: true, format: "esm", platform: "browser", write: false });
    const native = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-20", log: new Log(LogLevel.ERROR) });
    try {
      const response = await native.dispatchFetch(`https://fixture.test/${mode}`, { signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(200);
      const result = await response.json() as {
        before: { state: string; events: string[] }; state: string; error: { name: string; phase: string; reason: string };
        sends: number; events: string[]; locked: boolean;
      };
      expect(result.before.events).toContain("source-cancelled");
      expect(result.before.events).not.toContain(`${mode}-settled`);
      expect(result.before.state).toBe("pending");
      expect(result).toMatchObject({ state: "rejected", locked: false, sends: mode === "provider" ? 1 : 0,
        error: { name: "ByteVerificationError", phase: "source", reason: "size_mismatch" } });
      expect(result.events).toContain(`${mode}-settled`);
    } finally { await native.dispose(); }
  }, 30_000);
});
