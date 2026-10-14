import { afterAll, afterEach, expect } from 'vitest';
import { WORKER_V5_ORIGINAL_ISSUE_OBSERVER_SOURCE } from './worker-v5-original-issue-observer.qualification-support';
import { chmod, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { statfsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, stop } from 'esbuild';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { Request as MiniflareRequest } from 'miniflare';
import { unstable_splitSqlQuery as splitSql } from 'wrangler';
import { recoveryTableSnapshotSql } from '../../shared/contracts/system-recovery-image';
import type { ExportSchemaObject } from '../../shared/contracts/export';
import { stripReviewedCurrentCloudflarePlatformSchema } from '../../shared/contracts/cloudflare-platform-schema';
import { checkedPortableApplicationSchemaV26 } from '../../shared/contracts/export-portable-runtime-v26';
import { checkedPortableApplicationSchemaV28 } from '../../shared/contracts/export-portable-runtime-v28';
import { PORTABLE_RUNTIME_RECOVERY_TABLES as V28_TABLES } from '../../shared/contracts/portable-runtime-v28-recovery-catalog';
import { PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS } from '../../shared/contracts/portable-runtime-v26-recovery-catalog';
import { canonicalFileObject, canonicalFilePrivateOrigin, closeCanonicalFileClient, closeCanonicalFileProbe,
  consumeCanonicalFileClient, fetchCanonicalFileClient, type CanonicalFileFixtureOwner } from '../collaboration/current-v28-canonical-comment-file.qualification-support';

type HttpBody = string | ArrayBuffer | Uint8Array<ArrayBuffer>;
type NativeR2 = Awaited<ReturnType<Miniflare['getR2Bucket']>>;
type NativeD1 = Awaited<ReturnType<Miniflare['getD1Database']>>;
interface NativeDatabaseConsistency {
  checkedTables: string[]; observedSchemaSha256: string; foreignKeyCheckRows: 0; originalInstallationId?: string;
}
interface ClosedDatabaseConsistency {
  schema: "genuine-closed-original-d1-consistency/1"; originalDatabaseFile: string;
  observedSchemaSha256: string; databaseSha256Before: string; databaseSha256After: string;
  nativeCheckedTables: string[]; nativeForeignKeyCheckRows: 0;
  closedFileFullIntegrityCheck: "ok"; closedFileForeignKeyCheckRows: 0;
  originalRuntimeDisposeAndListenerRefusalAcknowledged: true;
}
interface PairOwner {
  client: CanonicalFileFixtureOwner; originalWork: Promise<unknown>[]; outbound: Promise<unknown>[];
  runtime?: Miniflare; jwks?: Server; jwksPort?: number; origin?: string;
  closing?: Promise<void>; accepting: boolean; closed: boolean;
  persistedD1?: string; nativeDatabaseConsistency?: NativeDatabaseConsistency;
  closedDatabaseConsistency?: ClosedDatabaseConsistency;
  recoveryTarget?: { consistency?: NativeDatabaseConsistency; closed?: ClosedDatabaseConsistency };
  plannedRecoveryTarget?: { consistency?: NativeDatabaseConsistency; closed?: ClosedDatabaseConsistency };
  stopOriginalIssueObservers?: () => Promise<void>;
  originalAckDelivery?: OriginalAckDeliveryOwner;
}
interface OriginalAckDeliveryGate {
  readonly id: string; readonly kind: WorkerV5OriginalIssueGate;
  acceptedRequests: number; acknowledgedResponses: number; released: boolean;
  deliveryAttempted: boolean;
  administratorRevokeAcknowledged: boolean;
  acceptedAt: number | null; responseFinishedAt: number | null; response?: ServerResponse;
}
interface OriginalAckDeliveryOwner {
  readonly nonce: string; readonly gates: Map<string, OriginalAckDeliveryGate>;
  readonly requests: Promise<void>[]; readonly failures: unknown[];
  outboundCalls: number; diagnosticEvents: number;
  accepting: boolean; server?: Server; port?: number; origin?: string;
  listening?: Promise<void>; stopping?: Promise<void>;
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
type OriginalAckOutboundStage = 'entered' | 'ack-identity' | 'ack-admission' | 'ack-fetch' | 'ack-body' | 'ack-return'
  | 'jwks-admission' | 'jwks-fetch' | 'jwks-body';
/** Optional fixture observation only. Never expose request URL/header values or
 * arbitrary error text, and never replace the original outbound result/error. */
function observeOriginalAckOutbound(owner: PairOwner, delivery: OriginalAckDeliveryOwner | undefined,
  request: MiniflareRequest, issuer: string, call: number, stage: OriginalAckOutboundStage, error?: unknown, response?: { readonly status: number }): void {
  // Reserve the bounded observations for the armed original gate; earlier
  // ordinary JWKS calls still count but cannot consume its diagnostic budget.
  if (!delivery || delivery.gates.size === 0) return;
  try {
    if (delivery.diagnosticEvents >= 32) return;
    delivery.diagnosticEvents++;
    const id = request.headers.get('x-original-native-gate');
    let errorKind = 'NONE', nativeCode = 'NONE', mentionsLoopback = false, mentionsPrivateAddress = false;
    if (error !== undefined) {
      errorKind = 'UNKNOWN'; nativeCode = 'CODE_UNAVAILABLE';
      if (error && typeof error === 'object') {
        const name = Reflect.get(error, 'name'), code = Reflect.get(error, 'code'), cause = Reflect.get(error, 'cause');
        if (typeof name === 'string' && ['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'FetchError'].includes(name)) errorKind = name;
        const causeCode = cause && typeof cause === 'object' ? Reflect.get(cause, 'code') : undefined;
        const codes = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT',
          'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'ERR_INVALID_URL'];
        const actualCode = typeof code === 'string' ? code : causeCode;
        if (typeof actualCode === 'string' && codes.includes(actualCode)) nativeCode = actualCode;
        const message = Reflect.get(error, 'message');
        if (typeof message === 'string') {
          const bounded = message.slice(0, 8192).toLowerCase();
          mentionsLoopback = bounded.includes('loopback') || bounded.includes('localhost') || bounded.includes('127.0.0.1');
          mentionsPrivateAddress = bounded.includes('private address') || bounded.includes('private ip');
        }
      }
    }
    console.error('Original ACK private Node outbound observation', {
      call, stage, status: response?.status ?? null, errorKind, nativeCode, mentionsLoopback, mentionsPrivateAddress,
      exactAckUrl: request.url === `${delivery.origin}/__original_native_ack_delivery`,
      exactJwksUrl: request.url === `${issuer}/cdn-cgi/access/certs`, methodGet: request.method === 'GET',
      nonceMatched: request.headers.get('x-original-native-control') === delivery.nonce,
      knownGate: Boolean(id && delivery.gates.has(id)), pairAdmitting: owner.accepting, deliveryAdmitting: delivery.accepting,
      acceptedRequests: id ? delivery.gates.get(id)?.acceptedRequests ?? 0 : 0,
    });
  } catch { /* Preserve the original outbound work and exact error. */ }
}
function releaseOriginalAckDelivery(gate: OriginalAckDeliveryGate): void {
  gate.released = true;
  if (!gate.response || gate.deliveryAttempted) return;
  gate.deliveryAttempted = true;
  const body = 'original-native-ack-delivery/1';
  try {
    gate.response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    gate.response.end(body);
  } catch (error) {
    gate.response.destroy(error instanceof Error ? error : new Error('Original ACK delivery HTTP response failed'));
    throw error;
  }
}
/** An unacknowledged administrator revoke must not resume authorized business
 * work. Reject this exact pending HTTP delivery; retain the original stop error
 * and make its first terminal delivery immune to later fallback release. */
function rejectOriginalAckDelivery(gate: OriginalAckDeliveryGate, failure: unknown): void {
  gate.released = true;
  if (gate.deliveryAttempted) return;
  gate.deliveryAttempted = true;
  gate.response?.destroy(failure instanceof Error ? failure : new Error('Original ACK delivery administrator revoke unproven'));
}
/** Stop admission and release actual accepted HTTP ACKs synchronously before
 * joining SDK work/outbound calls. Cache this first stop before native cleanup;
 * failed responses/listener close are retained and never retried. */
function stopOriginalAckDelivery(owner: PairOwner): Promise<void> | undefined {
  const delivery = owner.originalAckDelivery;
  if (!delivery) return undefined;
  if (delivery.stopping) return delivery.stopping;
  delivery.accepting = false;
  delivery.stopping = Promise.resolve().then(async () => {
    if (delivery.listening) try { await delivery.listening; } catch (error) { delivery.failures.push(error); }
    if (delivery.server?.listening) {
      try {
        await new Promise<void>((yes, no) => delivery.server!.close(error => error ? no(error) : yes()));
        ensure(delivery.port); await refused(delivery.port);
      } catch (error) { delivery.failures.push(error); }
    }
    const accepted = await Promise.allSettled(delivery.requests);
    for (const result of accepted) if (result.status === 'rejected') delivery.failures.push(result.reason);
    if (delivery.failures.length) throw new AggregateError([...new Set(delivery.failures)], 'Original native ACK delivery HTTP first stop failed');
  });
  void delivery.stopping.catch(() => undefined);
  for (const gate of delivery.gates.values()) {
    if (gate.deliveryAttempted || !gate.response) continue;
    try {
      if (gate.administratorRevokeAcknowledged) releaseOriginalAckDelivery(gate);
      else {
        const failure = new Error('Original ACK delivery administrator revoke unproven');
        delivery.failures.push(failure); rejectOriginalAckDelivery(gate, failure);
      }
    } catch (error) { delivery.failures.push(error); }
  }
  return delivery.stopping;
}
async function openOriginalAckDelivery(owner: PairOwner, parent: string, nonce: string): Promise<OriginalAckDeliveryOwner> {
  // This observer-only listener and all accepted requests belong to the sole
  // existing pair owner before any listener/Miniflare constructor runs.
  assertPairReserve(parent);
  const delivery: OriginalAckDeliveryOwner = { nonce, gates: new Map(), requests: [], failures: [], outboundCalls: 0, diagnosticEvents: 0, accepting: true };
  owner.originalAckDelivery = delivery;
  delivery.server = createServer((request, response) => {
    let gate: OriginalAckDeliveryGate | undefined;
    const settlement = new Promise<void>((yes, no) => {
      const fail = (error: unknown) => { delivery.failures.push(error); no(error); };
      request.once('error', fail); request.once('aborted', () => fail(new Error('Original ACK delivery HTTP request aborted')));
      response.once('error', fail);
      response.once('close', () => { if (!response.writableFinished) fail(new Error('Original ACK delivery HTTP response closed before ACK')); });
      response.once('finish', () => {
        if (gate && response.statusCode === 200) { gate.acknowledgedResponses++; gate.responseFinishedAt = Date.now(); }
        yes();
      });
    });
    delivery.requests.push(settlement); void settlement.catch(() => undefined);
    try {
      const id = request.headers['x-original-native-gate'];
      if (!delivery.accepting || request.method !== 'GET' || request.url !== '/__original_native_ack_delivery'
        || request.headers['x-original-native-control'] !== delivery.nonce || typeof id !== 'string') { response.writeHead(404).end(); return; }
      gate = delivery.gates.get(id); ensure(gate && gate.acceptedRequests === 0);
      gate.acceptedRequests++; gate.acceptedAt = Date.now(); gate.response = response;
      // Headers and body stay in this exact real HTTP response until release.
      // No query value or product actor/claim predicate is produced here.
      if (gate.released) releaseOriginalAckDelivery(gate);
    } catch (error) { delivery.failures.push(error); response.destroy(error instanceof Error ? error : new Error('Original ACK delivery HTTP failed')); }
  });
  delivery.server.on('error', error => { delivery.failures.push(error); });
  delivery.listening = original(owner, () => new Promise<void>((yes, no) => {
    delivery.server!.once('error', no); delivery.server!.listen(0, '127.0.0.1', () => { delivery.server!.off('error', no); yes(); });
  }));
  await delivery.listening;
  const address = delivery.server.address(); ensure(address && typeof address !== 'string');
  delivery.port = address.port; delivery.origin = `http://127.0.0.1:${address.port}`;
  return delivery;
}
async function refused(port: number) {
  await new Promise<void>((yes, no) => {
    const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); no(new Error('Original pair listener still open')); });
    socket.once('timeout', () => { socket.destroy(); no(new Error('Original pair listener closure unknown')); });
    socket.once('error', error => { socket.destroy(); 'code' in error && error.code === 'ECONNREFUSED' ? yes() : no(error); });
  });
}
const schemaSql = "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name";
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function checkedNativeDatabaseSchema(schema: ExportSchemaObject[], v28 = false) {
  ensure(schema.length <= 2048 && Buffer.byteLength(JSON.stringify(schema)) <= 2 * 1024 * 1024);
  const platform = stripReviewedCurrentCloudflarePlatformSchema(schema);
  const admitted = { applicationObjects: await (v28 ? checkedPortableApplicationSchemaV28 : checkedPortableApplicationSchemaV26)(platform.applicationObjects), ledgerPresent: platform.ledgerPresent };
  const names = admitted.applicationObjects.filter(row => row.type === 'table').map(row => row.name).sort();
  expect(names).toEqual((v28 ? V28_TABLES : PORTABLE_RUNTIME_RECOVERY_TABLES).map(row => row.name).sort());
  const checkedTables = ['sqlite_schema', ...names, ...(admitted.ledgerPresent ? ['d1_migrations'] : [])].sort();
  ensure(checkedTables.every(name => /^[a-z][a-z0-9_]*$/.test(name)) && new Set(checkedTables).size === checkedTables.length);
  return { checkedTables, observedSchemaSha256: sha256(JSON.stringify(schema)) };
}
async function verifyNativeDatabaseConsistency(database: NativeD1, v28 = false, bindInstallation = false): Promise<NativeDatabaseConsistency> {
  const schema = await database.prepare(schemaSql).all<ExportSchemaObject>(); ensure(schema.success);
  const observed = await checkedNativeDatabaseSchema(schema.results, v28);
  const foreignKeys = await database.prepare('PRAGMA foreign_key_check').all(); ensure(foreignKeys.success);
  expect(foreignKeys.results).toEqual([]);
  // The installed workerd caps one statement's compiler opcodes. Each admitted
  // table and its indexes get a sequential native check; whole quick_check is
  // reserved for the original physical file after the original runtime closes.
  for (const name of observed.checkedTables) {
    const check = await database.prepare(`PRAGMA quick_check("${name}")`).all();
    ensure(check.success); expect(check.results, `Original D1 table/index quick_check: ${name}`).toEqual([{ quick_check: 'ok' }]);
  }
  let originalInstallationId: string | undefined;
  if(bindInstallation){const identity=await database.prepare("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1").first<{installation_id:string}>();
    ensure(identity&&/^[a-f0-9]{32}$/.test(identity.installation_id));originalInstallationId=identity.installation_id;}
  return { ...observed, foreignKeyCheckRows: 0,...(originalInstallationId===undefined?{}:{originalInstallationId}) };
}
async function verifyClosedOriginalDatabase(owner: PairOwner, v28 = false, planned = false): Promise<ClosedDatabaseConsistency> {
  const consistency = planned ? owner.plannedRecoveryTarget?.consistency : v28 ? owner.recoveryTarget?.consistency : owner.nativeDatabaseConsistency;
  ensure(owner.persistedD1 && consistency);
  const files = (await readdir(owner.persistedD1, { recursive: true })).filter((file): file is string =>
    typeof file === 'string' && file.endsWith('.sqlite') && !file.endsWith('metadata.sqlite'));
  expect(files).toHaveLength(owner.plannedRecoveryTarget ? 3 : owner.recoveryTarget ? 2 : 1);
  const matching: string[] = [];
  for (const name of files) {
    const path = join(owner.persistedD1, name), database = new DatabaseSync(path, { readOnly: true });
    try { if (sha256(JSON.stringify(database.prepare(schemaSql).all())) === consistency.observedSchemaSha256
      &&(consistency.originalInstallationId===undefined||database.prepare("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1").get()?.installation_id===consistency.originalInstallationId)) matching.push(path); }
    finally { database.close(); }
  }
  expect(matching).toHaveLength(1);
  const originalDatabaseFile = matching[0]!;
  const databaseSha256Before = sha256(readFileSync(originalDatabaseFile));
  const exactNative = new DatabaseSync(originalDatabaseFile, { readOnly: true });
  let observed: Awaited<ReturnType<typeof checkedNativeDatabaseSchema>> | undefined;
  try {
    // Read only the exact persisted native file, after original dispose ACK.
    // Complete schema identity prevents substituting a metadata DB or catalog.
    observed = await checkedNativeDatabaseSchema(exactNative.prepare(schemaSql).all() as unknown as ExportSchemaObject[], v28);
    expect(observed).toEqual({ checkedTables: consistency.checkedTables,
      observedSchemaSha256: consistency.observedSchemaSha256 });
    if(consistency.originalInstallationId!==undefined)expect(exactNative.prepare("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1").get()?.installation_id).toBe(consistency.originalInstallationId);
    expect(exactNative.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    expect(exactNative.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { exactNative.close(); }
  ensure(observed);
  const databaseSha256After = sha256(readFileSync(originalDatabaseFile));
  expect(databaseSha256After).toBe(databaseSha256Before);
  return { schema: 'genuine-closed-original-d1-consistency/1', originalDatabaseFile,
    observedSchemaSha256: observed.observedSchemaSha256, databaseSha256Before, databaseSha256After,
    nativeCheckedTables: observed.checkedTables, nativeForeignKeyCheckRows: 0,
    closedFileFullIntegrityCheck: 'ok', closedFileForeignKeyCheckRows: 0,
    originalRuntimeDisposeAndListenerRefusalAcknowledged: true };
}
function close(owner: PairOwner): Promise<void> {
  if (owner.closing) return owner.closing;
  owner.accepting = false;
  owner.closing = (async () => {
    const failures: unknown[] = [];
    // Deny new observer I/O immediately. Revoke the original live Worker
    // administrator before releasing accepted ACKs, so teardown cannot resume
    // a still-authorized request in the gap between delivery and revocation.
    if (owner.originalAckDelivery) owner.originalAckDelivery.accepting = false;
    // Stop only this optional fixture observer before joining its original held ACK.
    // A rejected stop remains failed; no cleanup retry or database removal.
    if (owner.stopOriginalIssueObservers) {
      try { await owner.stopOriginalIssueObservers(); } catch (error) { failures.push(error); }
    }
    const originalAckDeliveryStopped = stopOriginalAckDelivery(owner);
    const work = await Promise.allSettled(owner.originalWork);
    for (const result of work) if (result.status === 'rejected') failures.push(result.reason);
    const clients = await Promise.allSettled([...owner.client.clients].map(client => closeCanonicalFileClient(owner.client, client)));
    for (const result of clients) if (result.status === 'rejected') failures.push(result.reason);
    if (owner.client.probe) try { await closeCanonicalFileProbe(owner.client); } catch (error) { failures.push(error); }
    let runtimeClosed = false;
    if (owner.runtime) {
      try { await owner.runtime.dispose(); if (owner.origin) await refused(Number(new URL(owner.origin).port)); runtimeClosed = true; }
      catch (error) { failures.push(error); }
    }
    const outbound = await Promise.allSettled(owner.outbound);
    for (const result of outbound) if (result.status === 'rejected') failures.push(result.reason);
    if (originalAckDeliveryStopped) try { await originalAckDeliveryStopped; } catch (error) { failures.push(error); }
    if (owner.jwks) {
      try {
        await new Promise<void>((yes, no) => { owner.jwks!.close(error => error ? no(error) : yes()); });
        if (owner.jwksPort) await refused(owner.jwksPort);
      } catch (error) { failures.push(error); }
    }
    if (owner.nativeDatabaseConsistency) {
      try { ensure(runtimeClosed); owner.closedDatabaseConsistency = await verifyClosedOriginalDatabase(owner); }
      catch (error) { failures.push(error); }
    }
    if (owner.recoveryTarget?.consistency) {
      try { ensure(runtimeClosed); owner.recoveryTarget.closed = await verifyClosedOriginalDatabase(owner, true); }
      catch (error) { failures.push(error); }
    }
    if(owner.plannedRecoveryTarget?.consistency){
      try{ensure(runtimeClosed);owner.plannedRecoveryTarget.closed=await verifyClosedOriginalDatabase(owner,true,true);}
      catch(error){failures.push(error);}
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

export type WorkerV5OriginalIssueGate = 'namespace-actor' | 'profile-actor' | 'held-original-ack';
export type WorkerV5OriginalIssueControl = 'stats' | 'arm' | 'revoke-administrator' | 'release' | 'restore-administrator';
export interface WorkerV5OriginalIssueObserver {
  /** Private fixture control, never a product route or public actor grant. */
  control(action: WorkerV5OriginalIssueControl, gate?: WorkerV5OriginalIssueGate): Promise<unknown>;
  /** Same SDK production fetch under this NEW observer's fixed 90s transport budget. */
  request: GenuineR2Pair['request'];
  /** Preserve exact original SDK outcome; this does not assert provider first-close. */
  scheduleOutcome(): Promise<string>;
}
export interface GenuineR2Pair {
  readonly root: string; readonly wranglerLedgerPresent: boolean;
  readonly sourceNamespaceInstallationId: string; readonly actor: string;
  request(path: string, method?: string, body?: HttpBody, headers?: Record<string, string>, identity?: 'admin' | 'reader' | 'none'):
    Promise<{ response: Response; value: unknown }>;
  /** Qualification readback only: no SQL mutation, authority/profile setup or runtime grant. */
  readRows(sql: string, bindings?: readonly (string | number | null)[]): Promise<Record<string, unknown>[]>;
  legacyMode(): Promise<unknown>;
  uploadReceipt(requestId: string): Promise<unknown>;
  typedSourceRows(): Promise<Record<string, { rowid: string | null; cells: string }[]>>;
  readObject(key: string): Promise<{ bytes: ArrayBuffer; byteSize: number }>;
  listObjects(): ReturnType<NativeR2['list']>;
  verifyNativeDatabaseConsistency(): Promise<void>;
  closedDatabaseConsistency(): ClosedDatabaseConsistency;
  schedule(): Promise<void>;
  close(): Promise<void>;
  readonly originalIssueObserver?: WorkerV5OriginalIssueObserver;
  readonly plannedRecoveryTarget?: GenuineR2Pair["recoveryTarget"];
  readonly recoveryTarget?: {
    readonly id: string;
    readonly originalIssueObserver?: WorkerV5OriginalIssueObserver;
    request: GenuineR2Pair["request"];
    readRows: GenuineR2Pair["readRows"];
    schedule(): Promise<void>;
    verifyNativeDatabaseConsistency(): Promise<void>;
    closedDatabaseConsistency(): ClosedDatabaseConsistency;
  };
}
export interface GenuineR2PairOptions { fileEvidenceOperator?: boolean; recoveryTargetId?: string; originalIssueObserver?: true; plannedRecoveryTargetId?: string }
export async function prepareGenuineCurrentV26R2Pair(parent: string, options: GenuineR2PairOptions = {}): Promise<GenuineR2Pair> {
  const owner: PairOwner = { client: { clients: new Set(), quarantined: false }, originalWork: [], outbound: [], accepting: true, closed: false };
  owners.add(owner);
  let failed = false, failure: unknown;
  try {
    assertPairReserve(parent);
    const root = await original(owner, () => mkdtemp(join(parent, options.recoveryTargetId===undefined?'.current-v26-r2-node-pair-':'.native-v5-target-')));
    await original(owner, () => chmod(root, 0o700));
    console.info('Retained genuine V26 R2 pair fixture:', root);
    const source = fileURLToPath(new URL('../../', import.meta.url));
    const observerLoader: 'ts' = 'ts';
    const bundled = await original(owner, async () => {
      let result: Awaited<ReturnType<typeof build>> | undefined, failed = false, failure: unknown;
      try { result = await build({ absWorkingDir: source,
        ...(options.originalIssueObserver === true
          ? { stdin: { contents: WORKER_V5_ORIGINAL_ISSUE_OBSERVER_SOURCE, resolveDir: join(source, 'worker'), loader: observerLoader } }
          : { entryPoints: [join(source, 'worker/index.ts')] }),
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
    ensure(options.plannedRecoveryTargetId===undefined||options.recoveryTargetId!==undefined);
    const sourceDatabaseId = randomUUID(), targetDatabaseId = randomUUID(), plannedDatabaseId=options.plannedRecoveryTargetId===undefined?undefined:randomUUID();
    const observerNonce = options.originalIssueObserver === true ? randomUUID() : undefined;
    const originalAckDelivery = observerNonce === undefined ? undefined : await openOriginalAckDelivery(owner, parent, observerNonce);
    const nativeOptions = { modules: true, script, compatibilityDate: '2026-07-20', host: '127.0.0.1', port: Number(new URL(origin).port),
      d1Databases: { DB: sourceDatabaseId }, d1Persist: join(root, 'd1'), r2Buckets: { ASSETS: bucketName }, r2Persist: join(root, 'r2'),
      bindings: { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, ALLOWED_EMAILS: `${actor},${reader}`, SYSTEM_ADMIN_EMAILS: actor,
        ...(options.fileEvidenceOperator === true ? { FILE_EVIDENCE_OPERATOR_EMAILS: actor } : {}),
        ...(observerNonce === undefined ? {} : { V5_QUALIFICATION_CONTROL_NONCE: observerNonce,
          V5_QUALIFICATION_ACK_DELIVERY_ORIGIN: originalAckDelivery!.origin! }),
        R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: 'local-r2', installationId: sourceNamespaceInstallationId, bucketName }) },
      log: new Log(LogLevel.ERROR), outboundService(request: MiniflareRequest) {
        let call = 0;
        if (originalAckDelivery) try { call = ++originalAckDelivery.outboundCalls; } catch { /* Observation only. */ }
        let stage: OriginalAckOutboundStage = 'entered';
        observeOriginalAckOutbound(owner, originalAckDelivery, request, issuer, call, stage);
        const work = (async () => {
          try {
            if (originalAckDelivery && request.url === `${originalAckDelivery.origin}/__original_native_ack_delivery`) {
              stage = 'ack-identity';
              const id = request.headers.get('x-original-native-gate');
              ensure(request.method === 'GET' && request.headers.get('x-original-native-control') === originalAckDelivery.nonce
                && id && originalAckDelivery.gates.has(id));
              // A real private Node HTTP request remains outstanding. Its 90s
              // transport ceiling matches this optional observer's existing one;
              // it does not alter the product's 60000ms kernel deadline.
              stage = 'ack-admission';
              ensure(owner.accepting && originalAckDelivery.accepting);
              stage = 'ack-fetch';
              observeOriginalAckOutbound(owner, originalAckDelivery, request, issuer, call, stage);
              const response = await fetch(request.url, { redirect: 'error', headers: {
                'x-original-native-control': originalAckDelivery.nonce, 'x-original-native-gate': id }, signal: AbortSignal.timeout(90_000) });
              stage = 'ack-body';
              observeOriginalAckOutbound(owner, originalAckDelivery, request, issuer, call, stage, undefined, response);
              const body = await response.arrayBuffer();
              observeOriginalAckOutbound(owner, originalAckDelivery, request, issuer, call, 'ack-return', undefined, response);
              return new Response(body, { status: response.status, headers: response.headers });
            }
            stage = 'jwks-admission';
            ensure(request.url === `${issuer}/cdn-cgi/access/certs` && request.method === 'GET');
            stage = 'jwks-fetch';
            const response = await fetch(request.url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
            stage = 'jwks-body';
            return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
          } catch (error) {
            observeOriginalAckOutbound(owner, originalAckDelivery, request, issuer, call, stage, error);
            throw error;
          }
        })(); owner.outbound.push(work); void work.catch(() => undefined); return work;
      } };
    let sourceWorkerName: string | undefined;
    if (options.recoveryTargetId === undefined) owner.runtime = new Miniflare(nativeOptions);
    else {
      ensure(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(options.recoveryTargetId));
      sourceWorkerName = 'original-v5-public-source'; owner.recoveryTarget = {};
      if(options.plannedRecoveryTargetId!==undefined){ensure(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(options.plannedRecoveryTargetId)&&options.plannedRecoveryTargetId!==options.recoveryTargetId&&plannedDatabaseId);owner.plannedRecoveryTarget={};}
      const { host, port, d1Persist, r2Persist, log, ...workerOptions } = nativeOptions;
      owner.runtime = new Miniflare({ host, port, d1Persist, r2Persist, log, workers: [
        { ...workerOptions, name: sourceWorkerName, d1Databases: { DB: sourceDatabaseId, RECOVERY_DB: targetDatabaseId },
          bindings: { ...workerOptions.bindings, RECOVERY_TARGET_ID: options.recoveryTargetId } },
        { ...workerOptions, name: 'original-v5-public-restored', d1Databases: { DB: targetDatabaseId,...(plannedDatabaseId===undefined?{}:{RECOVERY_DB:plannedDatabaseId}) },
          bindings:{...workerOptions.bindings,...(options.plannedRecoveryTargetId===undefined?{}:{RECOVERY_TARGET_ID:options.plannedRecoveryTargetId})} },
        ...(plannedDatabaseId===undefined?[]:[{...workerOptions,name:'original-v5-public-planned-fresh',d1Databases:{DB:plannedDatabaseId}}]),
      ] });
    }
    expect((await original(owner, () => owner.runtime!.ready)).origin).toBe(origin);
    const database = await original(owner, () => owner.runtime!.getD1Database('DB', sourceWorkerName));
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
    const bucket = await original(owner, () => owner.runtime!.getR2Bucket('ASSETS', sourceWorkerName));
    const worker = await original(owner, () => owner.runtime!.getWorker(sourceWorkerName));
    owner.persistedD1 = join(root, 'd1');
    async function request(path: string, method = 'GET', body?: HttpBody, headers: Record<string, string> = {}, identity: 'admin' | 'reader' | 'none' = 'admin') {
      ensure(owner.accepting);
      const response = await fetchCanonicalFileClient(owner.client, `${origin}${path}`, { method,
        headers: { ...headers, ...(identity === 'none' ? {} : { 'cf-access-jwt-assertion': identity === 'admin' ? adminToken : readerToken }) },
        ...(body === undefined ? {} : { body }), redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const value = await consumeCanonicalFileClient(response.client, 'arrayBuffer'); ensure(value instanceof ArrayBuffer);
      return { response: response.response, value };
    }
    const targetDatabase = owner.recoveryTarget ? await original(owner, () => owner.runtime!.getD1Database('DB', 'original-v5-public-restored')) : undefined;
    const targetWorker = owner.recoveryTarget ? await original(owner, () => owner.runtime!.getWorker('original-v5-public-restored')) : undefined;
    const plannedDatabase=owner.plannedRecoveryTarget?await original(owner,()=>owner.runtime!.getD1Database('DB','original-v5-public-planned-fresh')):undefined;
    const plannedWorker=owner.plannedRecoveryTarget?await original(owner,()=>owner.runtime!.getWorker('original-v5-public-planned-fresh')):undefined;
    const observerStops: (() => Promise<void>)[] = [];
    function issueObserver(originalWorker: typeof worker): WorkerV5OriginalIssueObserver | undefined {
      if (observerNonce === undefined) return undefined;
      ensure(originalAckDelivery);
      let originalIoGate: OriginalAckDeliveryGate | undefined;
      const controlFetch = async (action: WorkerV5OriginalIssueControl | 'stop-observer', gate?: WorkerV5OriginalIssueGate) => {
        const response = await originalWorker.fetch('https://original-v5-observer.invalid/__original_native_qualification/' + action,
          { method: action === 'stats' ? 'GET' : 'POST', headers: { 'x-original-native-control': observerNonce,
            ...(action === 'arm' && originalIoGate ? { 'x-original-native-gate': originalIoGate.id } : {}) },
            ...(gate === undefined ? {} : { body: gate }), signal: AbortSignal.timeout(5000) });
        expect(response.status).toBe(200); return JSON.parse(await response.text()) as unknown;
      };
      let originalStop: Promise<void> | undefined;
      observerStops.push(() => originalStop ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        let revoked = false;
        try { await controlFetch('stop-observer'); revoked = true; } catch (error) { failures.push(error); }
        try {
          if (originalIoGate) {
            if (revoked) { originalIoGate.administratorRevokeAcknowledged = true; releaseOriginalAckDelivery(originalIoGate); }
            else rejectOriginalAckDelivery(originalIoGate, failures[0]);
          }
        } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Original issue observer revoke and HTTP ACK release failed');
      }));
      return Object.freeze({
        control: (action: WorkerV5OriginalIssueControl, gate?: WorkerV5OriginalIssueGate) => original(owner, async () => {
          if (action === 'arm') {
            ensure(gate && (!originalIoGate || originalIoGate.released) && originalAckDelivery.accepting);
            originalIoGate = { id: randomUUID(), kind: gate, acceptedRequests: 0, acknowledgedResponses: 0, released: false,
              deliveryAttempted: false, administratorRevokeAcknowledged: false, acceptedAt: null, responseFinishedAt: null };
            originalAckDelivery.gates.set(originalIoGate.id, originalIoGate);
          }
          if (action === 'release' && originalIoGate) releaseOriginalAckDelivery(originalIoGate);
          const value = await controlFetch(action, gate);
          if (action !== 'stats') return value;
          ensure(value && typeof value === 'object' && !Array.isArray(value));
          return { ...value, deliveryIo: originalIoGate ? { schema: 'original-native-ack-delivery-http-io/1',
            acceptedRequests: originalIoGate.acceptedRequests, acknowledgedResponses: originalIoGate.acknowledgedResponses,
            released: originalIoGate.released, acceptedAt: originalIoGate.acceptedAt, responseFinishedAt: originalIoGate.responseFinishedAt } : null };
        }),
        request: (path: string, method = 'GET', body?: HttpBody, headers: Record<string, string> = {}, identity: 'admin' | 'reader' | 'none' = 'admin') => original(owner, async () => {
          const response = await originalWorker.fetch('https://original-v5-observer.invalid' + path, { method,
            headers: { ...headers, ...(identity === 'none' ? {} : { 'cf-access-jwt-assertion': identity === 'admin' ? adminToken : readerToken }) },
            ...(body === undefined ? {} : { body }), redirect: 'manual', signal: AbortSignal.timeout(90_000) });
          const value = await response.arrayBuffer();
          return { response: new Response(value, { status: response.status, headers: response.headers }), value };
        }),
        scheduleOutcome: () => original(owner, async () => {
          const value = await originalWorker.scheduled({ scheduledTime: new Date(), cron: '*/2 * * * *' });
          return value.outcome;
        }),
      });
    }
    const originalIssueObserver = issueObserver(worker), targetIssueObserver = targetWorker ? issueObserver(targetWorker) : undefined,plannedIssueObserver=plannedWorker?issueObserver(plannedWorker):undefined;
    if (observerStops.length) {
      let firstStop: Promise<void> | undefined;
      owner.stopOriginalIssueObservers = () => firstStop ??= (async () => {
        const outcomes = await Promise.allSettled(observerStops.map(stopObserver => stopObserver()));
        const failures = outcomes.flatMap(value => value.status === 'rejected' ? [value.reason as unknown] : []);
        if (failures.length) throw new AggregateError(failures, 'Original issue observer first stop failed');
      })();
    }
    const recoveryTarget = owner.recoveryTarget && targetDatabase && targetWorker && options.recoveryTargetId ? {
      id: options.recoveryTargetId, originalIssueObserver: targetIssueObserver,
      request: (path: string, method = 'GET', body?: HttpBody, headers: Record<string, string> = {}, identity: 'admin' | 'reader' | 'none' = 'admin') => original(owner, async () => {
        // Same original compiled production handler, actual target D1/R2 bindings
        // and signed Access middleware. No actor setter or authority callback.
        const response = await targetWorker.fetch('https://original-v5-restored.invalid' + path, { method,
          headers: { ...headers, ...(identity === 'none' ? {} : { 'cf-access-jwt-assertion': identity === 'admin' ? adminToken : readerToken }) },
          ...(body === undefined ? {} : { body }), redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const value = await response.arrayBuffer();
        return { response: new Response(value, { status: response.status, headers: response.headers }), value };
      }),
      readRows: (sql: string, bindings: readonly (string | number | null)[] = []) => original(owner, async () => {
        ensure(!/[;]|--|\/\*/.test(sql) && /^SELECT\b/i.test(sql.trim()));
        const result = await targetDatabase.prepare(sql).bind(...bindings).all<Record<string, unknown>>();
        ensure(result.success); return result.results;
      }),
      async schedule() { const result = await original(owner, () => targetWorker.scheduled({ scheduledTime: new Date(), cron: '*/2 * * * *' })); expect(result.outcome).toBe('ok'); },
      verifyNativeDatabaseConsistency: () => original(owner, async () => { ensure(owner.recoveryTarget); owner.recoveryTarget.consistency = await verifyNativeDatabaseConsistency(targetDatabase, true,Boolean(owner.plannedRecoveryTarget)); }),
      closedDatabaseConsistency() { ensure(owner.closed && owner.recoveryTarget?.closed); return structuredClone(owner.recoveryTarget.closed); },
    } : undefined;
    const plannedRecoveryTarget=owner.plannedRecoveryTarget&&plannedDatabase&&plannedWorker&&options.plannedRecoveryTargetId?{
      id:options.plannedRecoveryTargetId,originalIssueObserver:plannedIssueObserver,
      request:(path:string,method='GET',body?:HttpBody,headers:Record<string,string>={},identity:'admin'|'reader'|'none'='admin')=>original(owner,async()=>{
        const response=await plannedWorker.fetch('https://original-v5-planned-fresh.invalid'+path,{method,
          headers:{...headers,...(identity==='none'?{}:{'cf-access-jwt-assertion':identity==='admin'?adminToken:readerToken})},
          ...(body===undefined?{}:{body}),redirect:'manual',signal:AbortSignal.timeout(5000)});
        const value=await response.arrayBuffer();return {response:new Response(value,{status:response.status,headers:response.headers}),value};
      }),
      readRows:(sql:string,bindings:readonly(string|number|null)[]=[])=>original(owner,async()=>{
        ensure(!/[;]|--|\/\*/.test(sql)&&/^SELECT\b/i.test(sql.trim()));const result=await plannedDatabase.prepare(sql).bind(...bindings).all<Record<string,unknown>>();
        ensure(result.success);return result.results;
      }),
      async schedule(){const result=await original(owner,()=>plannedWorker.scheduled({scheduledTime:new Date(),cron:'*/2 * * * *'}));expect(result.outcome).toBe('ok');},
      verifyNativeDatabaseConsistency:()=>original(owner,async()=>{ensure(owner.plannedRecoveryTarget);owner.plannedRecoveryTarget.consistency=await verifyNativeDatabaseConsistency(plannedDatabase,true,true);}),
      closedDatabaseConsistency(){ensure(owner.closed&&owner.plannedRecoveryTarget?.closed);return structuredClone(owner.plannedRecoveryTarget.closed);},
    }:undefined;
    return Object.freeze({ root, wranglerLedgerPresent, sourceNamespaceInstallationId, actor, request, recoveryTarget, plannedRecoveryTarget,originalIssueObserver,
      readRows: (sql: string, bindings: readonly (string | number | null)[] = []) => original(owner, async () => {
        ensure(!/[;]|--|\/\*/.test(sql) && (/^SELECT\b/i.test(sql.trim())
          || /^PRAGMA (?:foreign_key_check|integrity_check|defer_foreign_keys)$/i.test(sql.trim())));
        try {
          const result = await database.prepare(sql).bind(...bindings).all<Record<string, unknown>>();
          ensure(result.success); return result.results;
        } catch (cause) {
          // Only closed PRAGMA names or a source-query digest identify the read.
          // Never include SQL text, binding values, identity or request headers.
          const pragma = /^PRAGMA (foreign_key_check|integrity_check|defer_foreign_keys)$/i.exec(sql.trim());
          const operation = pragma ? `PRAGMA ${pragma[1]!.toLowerCase()}`
            : `SELECT sha256=${createHash('sha256').update(sql).digest('hex')}`;
          throw new Error(`Original genuine R2 pair readRows failed: ${operation}`, { cause });
        }
      }),
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
      verifyNativeDatabaseConsistency: () => original(owner, async () => {
        owner.nativeDatabaseConsistency = await verifyNativeDatabaseConsistency(database,false,Boolean(owner.plannedRecoveryTarget));
      }),
      closedDatabaseConsistency() {
        ensure(owner.closed && owner.closedDatabaseConsistency);
        return structuredClone(owner.closedDatabaseConsistency);
      },
      async schedule() { const result = await original(owner, () => worker.scheduled({ scheduledTime: new Date(), cron: '*/2 * * * *' })); expect(result.outcome).toBe('ok'); },
      close: () => close(owner) });
  } catch (error) { failed = true; failure = error; }
  try { await close(owner); } catch (cleanup) { throw new AggregateError(failed ? [failure, cleanup] : [cleanup], 'R2 pair setup and original first close failed'); }
  throw failure;
}
export function pairJson(value: unknown): Record<string, unknown> {
  ensure(value instanceof ArrayBuffer); return canonicalFileObject(JSON.parse(Buffer.from(value).toString('utf8')));
}
