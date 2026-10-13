import { afterAll, afterEach, expect } from 'vitest';
import { chmod, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, stop } from 'esbuild';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { Request as MiniflareRequest } from 'miniflare';
import { unstable_splitSqlQuery as splitSql } from 'wrangler';
import { recoveryTableSnapshotSql } from '../../shared/contracts/system-recovery-image';
import { PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS } from '../../shared/contracts/portable-runtime-v26-recovery-catalog';
import { canonicalFileObject, canonicalFilePrivateOrigin, closeCanonicalFileClient, closeCanonicalFileProbe,
  consumeCanonicalFileClient, fetchCanonicalFileClient, type CanonicalFileFixtureOwner } from '../collaboration/current-v28-canonical-comment-file.qualification-support';

type HttpBody = NonNullable<RequestInit['body']>;
type NativeR2 = Awaited<ReturnType<Miniflare['getR2Bucket']>>;
interface PairOwner {
  client: CanonicalFileFixtureOwner; originalWork: Promise<unknown>[]; outbound: Promise<unknown>[];
  runtime?: Miniflare; jwks?: Server; jwksPort?: number; origin?: string;
  closing?: Promise<void>; accepting: boolean; closed: boolean;
}
const owners = new Set<PairOwner>();
const RESERVE = 603_979_776n;
export function assertPairReserve(parent: string) {
  for (const path of [parent, tmpdir()]) {
    const free = statfsSync(path, { bigint: true });
    if (free.bavail * free.bsize < RESERVE) throw new Error('Original R2 pair pre-Native reserve unavailable');
  }
}
function ensure(value: unknown): asserts value { if (!value) throw new Error('Original genuine R2 pair owner unavailable'); }
function original<T>(owner: PairOwner, work: () => Promise<T>): Promise<T> {
  ensure(owner.accepting);
  let promise: Promise<T>;
  try { promise = work(); } catch (error) { promise = Promise.reject(error); }
  owner.originalWork.push(promise); void promise.catch(() => undefined); return promise;
}
async function refused(port: number) {
  await new Promise<void>((yes, no) => {
    const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); no(new Error('Original pair listener still open')); });
    socket.once('timeout', () => { socket.destroy(); no(new Error('Original pair listener closure unknown')); });
    socket.once('error', error => { socket.destroy(); 'code' in error && error.code === 'ECONNREFUSED' ? yes() : no(error); });
  });
}
function close(owner: PairOwner): Promise<void> {
  if (owner.closing) return owner.closing;
  owner.accepting = false;
  owner.closing = (async () => {
    const failures: unknown[] = [];
    const work = await Promise.allSettled(owner.originalWork);
    for (const result of work) if (result.status === 'rejected') failures.push(result.reason);
    const clients = await Promise.allSettled([...owner.client.clients].map(client => closeCanonicalFileClient(owner.client, client)));
    for (const result of clients) if (result.status === 'rejected') failures.push(result.reason);
    if (owner.client.probe) try { await closeCanonicalFileProbe(owner.client); } catch (error) { failures.push(error); }
    if (owner.runtime) {
      try { await owner.runtime.dispose(); if (owner.origin) await refused(Number(new URL(owner.origin).port)); }
      catch (error) { failures.push(error); }
    }
    const outbound = await Promise.allSettled(owner.outbound);
    for (const result of outbound) if (result.status === 'rejected') failures.push(result.reason);
    if (owner.jwks) {
      try {
        await new Promise<void>((yes, no) => { owner.jwks!.close(error => error ? no(error) : yes()); });
        if (owner.jwksPort) await refused(owner.jwksPort);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Original genuine R2 pair work or first close failed');
    owner.closed = true; owners.delete(owner);
  })();
  void owner.closing.catch(() => undefined); return owner.closing;
}
afterEach(() => { if (owners.size) throw new Error('Original genuine R2 pair owner remains retained'); });
afterAll(async () => {
  const results = await Promise.allSettled([...owners].map(close));
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
  if (failures.length) throw new AggregateError(failures, 'Original R2 pair teardown remains unproven');
});

export interface GenuineR2Pair {
  readonly root: string; readonly wranglerLedgerPresent: boolean;
  readonly sourceNamespaceInstallationId: string; readonly actor: string;
  request(path: string, method?: string, body?: HttpBody, headers?: Record<string, string>, identity?: 'admin' | 'reader' | 'none'):
    Promise<{ response: Response; value: unknown }>;
  legacyMode(): Promise<unknown>;
  uploadReceipt(requestId: string): Promise<unknown>;
  typedSourceRows(): Promise<Record<string, { rowid: string | null; cells: string }[]>>;
  readObject(key: string): Promise<{ bytes: ArrayBuffer; byteSize: number }>;
  listObjects(): ReturnType<NativeR2['list']>;
  schedule(): Promise<void>;
  close(): Promise<void>;
}
export async function prepareGenuineCurrentV26R2Pair(parent: string): Promise<GenuineR2Pair> {
  const owner: PairOwner = { client: { clients: new Set(), quarantined: false }, originalWork: [], outbound: [], accepting: true, closed: false };
  owners.add(owner);
  let failed = false, failure: unknown;
  try {
    assertPairReserve(parent);
    const root = await original(owner, () => mkdtemp(join(parent, '.current-v26-r2-node-pair-')));
    await original(owner, () => chmod(root, 0o700));
    console.info('Retained genuine V26 R2 pair fixture:', root);
    const source = fileURLToPath(new URL('../../', import.meta.url));
    const bundled = await original(owner, async () => {
      let result: Awaited<ReturnType<typeof build>> | undefined, failed = false, failure: unknown;
      try { result = await build({ absWorkingDir: source, entryPoints: [join(source, 'worker/index.ts')],
        bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, logLevel: 'silent' }); }
      catch (error) { failed = true; failure = error; }
      // Stop belongs to the original compilation even if fixture admission was
      // stopped while it was pending. Close joins this SAME whole promise.
      try { await stop(); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], 'Original build and stop failed') : cleanup; }
      if (failed) throw failure; ensure(result); return result;
    }); // SDK stop ACK; outer original process/kernel closure remains separately required.
    expect(bundled.warnings).toEqual([]); ensure(bundled.outputFiles?.length === 1);
    const script = bundled.outputFiles[0]!.text;
    const keys = await original(owner, () => generateKeyPair('RS256'));
    const publicKey = { ...await original(owner, () => exportJWK(keys.publicKey)), kid: 'current-r2-node-pair', alg: 'RS256', use: 'sig' };
    const publicBytes = Buffer.from(JSON.stringify({ keys: [publicKey] }));
    ensure(owner.accepting);
    owner.jwks = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/cdn-cgi/access/certs') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': publicBytes.length });
      response.end(publicBytes);
    });
    await original(owner, () => new Promise<void>((yes, no) => {
      owner.jwks!.once('error', no); owner.jwks!.listen(0, '127.0.0.1', () => { owner.jwks!.off('error', no); yes(); });
    }));
    const address = owner.jwks.address(); ensure(address && typeof address !== 'string'); owner.jwksPort = address.port;
    const issuer = `http://127.0.0.1:${address.port}`, audience = `current-r2-pair-${randomUUID()}`;
    const actor = 'current-r2-administrator@pair.invalid', reader = 'current-r2-reader@pair.invalid';
    const token = (email: string) => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'current-r2-node-pair' })
      .setIssuer(issuer).setAudience(audience).setSubject(`fixture:${email}`).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const adminToken = await original(owner, () => token(actor)), readerToken = await original(owner, () => token(reader));
    const origin = await original(owner, () => canonicalFilePrivateOrigin(owner.client)); owner.origin = origin;
    const sourceNamespaceInstallationId = randomUUID(), bucketName = `current-r2-pair-${randomUUID().replaceAll('-', '')}`;
    ensure(owner.accepting);
    owner.runtime = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-20', host: '127.0.0.1', port: Number(new URL(origin).port),
      d1Databases: { DB: randomUUID() }, d1Persist: join(root, 'd1'), r2Buckets: { ASSETS: bucketName }, r2Persist: join(root, 'r2'),
      bindings: { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, ALLOWED_EMAILS: `${actor},${reader}`, SYSTEM_ADMIN_EMAILS: actor,
        R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: 'local-r2', installationId: sourceNamespaceInstallationId, bucketName }) },
      log: new Log(LogLevel.ERROR), outboundService(request: MiniflareRequest) {
        const work = (async () => {
          ensure(request.url === `${issuer}/cdn-cgi/access/certs` && request.method === 'GET');
          const response = await fetch(request.url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
          return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
        })(); owner.outbound.push(work); void work.catch(() => undefined); return work;
      } });
    expect((await original(owner, () => owner.runtime!.ready)).origin).toBe(origin);
    const database = await original(owner, () => owner.runtime!.getD1Database('DB'));
    const migrationDirectory = join(source, 'migrations');
    const names = (await original(owner, () => readdir(migrationDirectory))).filter(name => name.endsWith('.sql')).sort();
    expect(names).toEqual(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.map(migration => migration.name));
    for (const migration of PORTABLE_RUNTIME_RECOVERY_MIGRATIONS) {
      const sql = await original(owner, () => readFile(join(migrationDirectory, migration.name), 'utf8'));
      expect(createHash('sha256').update(sql).digest('hex')).toBe(migration.sha256);
      const result = await original(owner, () => database.batch(splitSql(sql).map(statement => database.prepare(statement))));
      expect(result.every(item => item.success)).toBe(true);
    } // Original reviewed D1 bootstrap only. No business/profile/authority/ledger SQL is seeded.
    const wranglerLedgerPresent = Boolean(await original(owner, () => database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='d1_migrations'").first()));
    const bucket = await original(owner, () => owner.runtime!.getR2Bucket('ASSETS'));
    const worker = await original(owner, () => owner.runtime!.getWorker());
    async function request(path: string, method = 'GET', body?: HttpBody, headers: Record<string, string> = {}, identity: 'admin' | 'reader' | 'none' = 'admin') {
      ensure(owner.accepting);
      const response = await fetchCanonicalFileClient(owner.client, `${origin}${path}`, { method,
        headers: { ...headers, ...(identity === 'none' ? {} : { 'cf-access-jwt-assertion': identity === 'admin' ? adminToken : readerToken }) },
        ...(body === undefined ? {} : { body }), redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const value = await consumeCanonicalFileClient(response.client, 'arrayBuffer'); ensure(value instanceof ArrayBuffer);
      return { response: response.response, value };
    }
    return Object.freeze({ root, wranglerLedgerPresent, sourceNamespaceInstallationId, actor, request,
      legacyMode: () => original(owner, () => database.prepare('SELECT mode FROM file_authority_control WHERE singleton=1').first()),
      uploadReceipt: (requestId: string) => original(owner, () => database.prepare('SELECT actor_email,ingress,purpose,request_scope,status FROM r2_upload_requests WHERE client_request_id=?').bind(requestId).first()),
      async typedSourceRows() {
        const specs = PORTABLE_RUNTIME_RECOVERY_TABLES.filter(spec => !spec.local);
        const results = await original(owner, () => database.batch(specs.map(spec => database.prepare(recoveryTableSnapshotSql(spec)))));
        ensure(results.length === specs.length && results.every(result => result.success));
        return Object.fromEntries(specs.map((spec, index) => [spec.name, results[index]!.results.map(row => {
          const value = canonicalFileObject(row); ensure((value.rowid === null || typeof value.rowid === 'string') && typeof value.cells === 'string');
          return { rowid: value.rowid, cells: value.cells };
        })]));
      },
      readObject: (key: string) => original(owner, async () => {
        const object = await bucket.get(key); ensure(object);
        // The returned original body belongs to this read even if admission
        // stops meanwhile. EOF/cancellation cannot be skipped before dispose.
        const bytes = await object.arrayBuffer(); return { bytes, byteSize: object.size };
      }),
      listObjects: () => original(owner, () => bucket.list()),
      async schedule() { const result = await original(owner, () => worker.scheduled({ scheduledTime: new Date(), cron: '*/2 * * * *' })); expect(result.outcome).toBe('ok'); },
      close: () => close(owner) });
  } catch (error) { failed = true; failure = error; }
  try { await close(owner); } catch (cleanup) { throw new AggregateError(failed ? [failure, cleanup] : [cleanup], 'R2 pair setup and original first close failed'); }
  throw failure;
}
export function pairJson(value: unknown): Record<string, unknown> {
  ensure(value instanceof ArrayBuffer); return canonicalFileObject(JSON.parse(Buffer.from(value).toString('utf8')));
}
