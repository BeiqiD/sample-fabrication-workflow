import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Public example credentials and isolated providers only. Workerd exercises the
// real FixedLengthStream, Request and crypto rather than Node stream substitutes.
const workerSource = `
  import { s3ByteAdapter } from './s3-byte-adapter';
  import { primaryD1 } from '../d1-primary';
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unbound provider access is forbidden'); };
  export default { async fetch(request, env) {
    const input = await request.json(), constraints = [], events = [], providerRequests = [], guards = [];
    let cancelled = 0, pulls = 0, offset = 0;
    const chunks = (input.chunks ?? ['one', 'two', 'unread tail']).map(value => new TextEncoder().encode(value));
    const source = new ReadableStream({
      pull(controller) { pulls++; if (offset < chunks.length) controller.enqueue(chunks[offset++]); else controller.close(); },
      cancel() { cancelled++; }
    }, { highWaterMark: 0 });
    const trackedDb = { withSession(constraint) { constraints.push(constraint); return env.DB.withSession(constraint); } };
    const currentOwner = async () => Boolean(await primaryD1(trackedDb).prepare(
      "SELECT 1 AS owned FROM qualification_claims c JOIN qualification_runtime r ON r.id=c.runtime_id " +
      "WHERE c.id='operation' AND c.owner='original-owner' AND c.incarnation='original-incarnation' " +
      "AND r.enabled=1 AND c.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    ).first());
    let initiallyAllowed = true;
    if (input.guard === 'database') {
      await env.DB.batch([
        env.DB.prepare('UPDATE qualification_runtime SET enabled=1 WHERE id=1'),
        env.DB.prepare("UPDATE qualification_claims SET owner='original-owner',incarnation='original-incarnation',expires_at=? WHERE id='operation'")
          .bind(new Date(Date.now() + 60_000).toISOString())
      ]);
      initiallyAllowed = await currentOwner();
    }
    events.push('caller-check');
    // Another actor changes authority after the caller's successful check.
    // The final signed-request boundary must read primary state again.
    if (input.change === 'paused') await env.DB.prepare('UPDATE qualification_runtime SET enabled=0 WHERE id=1').run();
    if (input.change === 'reclaimed') await env.DB.prepare("UPDATE qualification_claims SET owner='replacement-owner',incarnation='replacement-incarnation' WHERE id='operation'").run();
    if (input.change === 'expired') await env.DB.prepare("UPDATE qualification_claims SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='operation'").run();
    const adapter = s3ByteAdapter({ kind: 's3', endpoint: 'https://s3.amazonaws.com', bucket: 'examplebucket',
      region: 'us-east-1', root: '', forcePathStyle: false },
      { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, {
      now: () => { events.push('signing-clock'); return new Date('2013-05-24T00:00:00.000Z'); },
      beforeRequest: async operation => {
        guards.push(operation); events.push('request-guard');
        if (input.guard === 'database') return currentOwner();
        if (input.guard === 'throw') throw new Error('private lifecycle failure');
        if (input.guard === 'truthy') return 1;
        return input.guard === 'allow';
      },
      fetch: async signed => {
        providerRequests.push(signed.method); events.push('provider-request');
        return nativeFetch(signed);
      }
    });
    let result = null, error = null;
    try {
      if (input.method === 'DELETE') result = await adapter.deleter.delete('native.bin');
      else await adapter.writer.write({ key: 'native.bin', body: source, byteSize: input.byteSize ?? 17,
        sha256: 'a'.repeat(64), contentType: 'application/octet-stream', filename: 'native.bin' });
    } catch (caught) {
      error = { name: caught.name, phase: caught.phase, reason: caught.reason, message: caught.message };
    }
    return Response.json({ initiallyAllowed, result, error, guards, providerRequests, events, constraints,
      cancelled, pulls, locked: source.locked });
  } };
`;

interface GuardResult {
  initiallyAllowed: boolean;
  result: { outcome: string } | null;
  error: { name: string; phase: string; reason: string; message: string } | null;
  guards: { method: string; key: string }[];
  providerRequests: string[];
  events: string[];
  constraints: string[];
  cancelled: number;
  pulls: number;
  locked: boolean;
}
interface ProviderRequest { method: string; length: string | null; transferEncoding: string | null; bytes: number[] }
let bundlePromise: Promise<string> | undefined;
function bundledWorker() {
  return bundlePromise ??= build({ stdin: { loader: "ts", resolveDir: fileURLToPath(new URL(".", import.meta.url)), contents: workerSource },
    bundle: true, format: "esm", platform: "browser", write: false }).then(result => result.outputFiles[0].text);
}

async function fixture() {
  const provider: ProviderRequest[] = [];
  const native = new Miniflare({ modules: true, script: await bundledWorker(), compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], log: new Log(LogLevel.ERROR), outboundService: async request => {
      provider.push({ method: request.method, length: request.headers.get("content-length"),
        transferEncoding: request.headers.get("transfer-encoding"), bytes: Array.from(new Uint8Array(await request.arrayBuffer())) });
      return new Response(null, { status: request.method === "DELETE" ? 204 : 200 });
    } });
  try {
    const db = await native.getD1Database("DB");
    await db.batch([
      db.prepare("CREATE TABLE qualification_runtime(id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)))"),
      db.prepare("CREATE TABLE qualification_claims(id TEXT PRIMARY KEY,runtime_id INTEGER NOT NULL REFERENCES qualification_runtime(id),owner TEXT NOT NULL,incarnation TEXT NOT NULL,expires_at TEXT NOT NULL)"),
      db.prepare("INSERT INTO qualification_runtime VALUES(1,1)"),
      db.prepare("INSERT INTO qualification_claims VALUES('operation',1,'original-owner','original-incarnation','2099-01-01T00:00:00.000Z')"),
    ]);
    const invoke = async (input: unknown): Promise<GuardResult> => {
      const response = await native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify(input),
        signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(200);
      return response.json() as Promise<GuardResult>;
    };
    return { db, invoke, provider, dispose: () => native.dispose() };
  } catch (error) { await native.dispose(); throw error; }
}

describe("S3 request lifecycle guards in native workerd", () => {
  it("cancels and unlocks FixedLengthStream sources when final approval rejects or throws, without provider I/O", async () => {
    const f = await fixture();
    try {
      for (const guard of ["deny", "throw", "truthy"]) {
        const result = await f.invoke({ guard });
        expect(result).toMatchObject({ initiallyAllowed: true, cancelled: 1, locked: false,
          error: { name: "ByteVerificationError", phase: "destination", reason: "unavailable" },
          guards: [{ method: "PUT", key: "native.bin" }], providerRequests: [] });
        expect(result.events).toEqual(["caller-check", "signing-clock", "request-guard"]);
        expect(JSON.stringify(result)).not.toContain("private lifecycle failure");
      }
      // No automatic retry or compensating DELETE escapes through another path.
      expect(f.provider).toEqual([]);
    } finally { await f.dispose(); }
  }, 30_000);

  it("streams approved known-length and empty PUT bodies through the signed native Request", async () => {
    const f = await fixture();
    try {
      for (const [chunks, byteSize] of [[ ["one", "", "二", "three"], 11 ], [[], 0]] as const) {
        const result = await f.invoke({ guard: "allow", chunks, byteSize });
        expect(result).toMatchObject({ error: null, cancelled: 0, locked: false,
          guards: [{ method: "PUT", key: "native.bin" }], providerRequests: ["PUT"] });
        expect(result.events).toEqual(["caller-check", "signing-clock", "request-guard", "provider-request"]);
      }
      expect(f.provider).toEqual([
        { method: "PUT", length: "11", transferEncoding: null, bytes: Array.from(new TextEncoder().encode("one二three")) },
        { method: "PUT", length: "0", transferEncoding: null, bytes: [] },
      ]);
    } finally { await f.dispose(); }
  }, 30_000);

  it("rereads primary D1 and blocks stale PUT/DELETE after execution pause, claim replacement or lease expiry", async () => {
    const f = await fixture();
    try {
      for (const method of ["PUT", "DELETE"]) {
        for (const change of ["paused", "reclaimed", "expired"]) {
          const result = await f.invoke({ method, guard: "database", change });
          expect(result).toMatchObject({ initiallyAllowed: true, providerRequests: [], guards: [{ method, key: "native.bin" }],
            constraints: ["first-primary", "first-primary"], locked: false });
          if (method === "PUT") expect(result).toMatchObject({ cancelled: 1,
            error: { name: "ByteVerificationError", phase: "destination", reason: "unavailable" } });
          else expect(result).toMatchObject({ result: { outcome: "unavailable" }, error: null });
        }
      }
      expect(f.provider).toEqual([]);
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      expect(await f.db.prepare("SELECT count(*) n FROM qualification_claims").first()).toEqual({ n: 1 });
    } finally { await f.dispose(); }
  }, 30_000);
});
