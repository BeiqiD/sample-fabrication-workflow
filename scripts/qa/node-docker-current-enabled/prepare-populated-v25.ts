// QA-only historical fixture. Fixed V25 installer and real authenticated HTTP
// services populate it; this is not a supported end-user V25 install command.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_NODE_INSTALLATION_CATALOG as V25 } from "../../../server/installation-catalog";
import { admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog } from "../../../server/migrations";
import { createInstalledLocalIdentity } from "../../../server/auth/identity";
import { createPasswordHasher } from "../../../server/auth/passwords";
import { createNodeDevelopmentPrototype } from "../../../server/node-application";
import { acquireLinuxWriterLease, type LinuxWriterLease } from "../../../server/operations/writer-lease";
import { createSqliteCapability, type SqliteCapability } from "../../../server/sqlite";
import { originalWitnessFilesClosed, retainOriginalV25Witness } from "./upgrade-preservation";

const databasePath = "/var/lib/sample/state/application.sqlite";
const origin = "http://127.0.0.1:14227";
const policy = Object.freeze({ absoluteLifetimeMs: 12 * 3600_000, idleLifetimeMs: 1800_000,
  loginWindowMs: 60_000, loginAttempts: 5, throttleBuckets: 1000 });
type Prototype = Awaited<ReturnType<typeof createNodeDevelopmentPrototype>>;
interface BodyOwner { fetchAttempted?: true; fetchError?: unknown; originalFetch?: Promise<Response>; originalRead?: Promise<Uint8Array[]>;
  cancelAttempted?: true; originalCancel?: Promise<void>; cancelAcknowledged?: true; cancelError?: unknown;
  readerAttempted?: true; readerError?: unknown; reader?: ReadableStreamDefaultReader<Uint8Array>;
  releaseAttempted: boolean; released: boolean; releaseError?: unknown }
interface Owner {
  setup?: Promise<void>; acquisition?: Promise<LinuxWriterLease>; lease?: LinuxWriterLease;
  nativeAttempted?: true; native?: DatabaseSync; nativeError?: unknown; database?: SqliteCapability;
  originalNativeClose?: () => void; nativeFirstAcknowledged?: () => boolean;
  compositionAttempted?: true; composition?: Promise<Prototype>; compositionError?: unknown; prototype?: Prototype;
  identity?: Awaited<ReturnType<typeof createInstalledLocalIdentity>>;
  bodies: Set<BodyOwner>; listenerFailure?: unknown;
  setupError?: unknown; close?: Promise<void>; closeError?: unknown;
}
const retained = new Set<Owner>();
function nativeFirstClose(owner: Owner, native: DatabaseSync): void {
  const original = native.close.bind(native); let attempted = false, acknowledged = false, reason: unknown;
  const close = () => {
    if (attempted) { if (!acknowledged) throw reason; return; }
    attempted = true;
    try { original(); acknowledged = true; } catch (error) { reason = error; throw error; }
  };
  native.close = close; owner.originalNativeClose = close;
  owner.nativeFirstAcknowledged = () => attempted && acknowledged && !native.isOpen;
}
function closeOwner(owner: Owner): Promise<void> {
  if (owner.close) return owner.close;
  owner.close = (async () => {
    if (owner.setup) await owner.setup.then(() => undefined, () => undefined);
    if (owner.acquisition) owner.lease = await owner.acquisition;
    for (const body of owner.bodies) {
      if (body.fetchAttempted && !body.originalFetch) throw body.fetchError;
      await body.originalFetch?.then(() => undefined, () => undefined);
      if (body.originalRead) await body.originalRead.then(() => undefined, () => undefined);
      if (body.originalCancel) await body.originalCancel.then(() => undefined, () => undefined);
      if (body.cancelAttempted && !body.cancelAcknowledged) throw body.cancelError;
      if (body.readerAttempted && !body.reader) throw body.readerError;
      if (body.releaseAttempted && !body.released) throw body.releaseError;
      if (body.reader && !body.releaseAttempted) throw new Error("Original response first release was not observed");
    }
    if (!originalWitnessFilesClosed()) throw new Error("Original private witness file close is unproven");
    if (owner.listenerFailure !== undefined) throw owner.listenerFailure;
    if (owner.compositionAttempted) {
      if (!owner.prototype) throw owner.compositionError;
      await owner.prototype.close(); // Same original cached application/body/native/lease close.
    } else {
      await owner.lease?.stopAdmissionAndDrain();
      if (owner.nativeAttempted && !owner.native) throw owner.nativeError;
      if (owner.database) owner.database.close(); else owner.originalNativeClose?.();
      if (owner.native && !owner.nativeFirstAcknowledged?.()) throw new Error("Original native first close is unproven");
      await owner.lease?.release();
    }
    if (owner.native && !owner.nativeFirstAcknowledged?.()) throw new Error("Original application native first close is unproven");
    retained.delete(owner);
  })().catch(error => { owner.closeError = error; throw error; });
  owner.close.then(() => undefined, () => undefined); return owner.close;
}
async function privateInput(): Promise<{ username: string; password: string }> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; assert.ok(length <= 16384); chunks.push(Buffer.from(chunk)); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const fields = value as Record<string, unknown>; assert.deepEqual(Object.keys(fields).sort(), ["password", "username"]);
  assert.equal(typeof fields.username, "string"); assert.match(fields.username as string, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.equal(typeof fields.password, "string"); assert.ok((fields.password as string).length >= 16 && (fields.password as string).length <= 256);
  return fields as { username: string; password: string };
}
async function main(): Promise<void> {
  const input = await privateInput(); assert.equal(process.getuid?.(), 1000);
  const owner: Owner = { bodies: new Set() }; retained.add(owner); // Before first acquire/constructor await.
  let cookie = "", csrf = "", originalTableCount = 0;
  async function request(path: string, status: number, method = "GET", value?: unknown, extra: Record<string, string> = {}) {
    const bodyOwner: BodyOwner = { releaseAttempted: false, released: false }; owner.bodies.add(bodyOwner);
    bodyOwner.fetchAttempted = true;
    try { bodyOwner.originalFetch = fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { origin, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-sfw-csrf": csrf } : {}),
        ...(value === undefined ? {} : { "content-type": "application/json" }), ...extra },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) }); }
    catch (error) { bodyOwner.fetchError = error; throw error; }
    bodyOwner.originalFetch.then(() => undefined, () => undefined);
    const response = await bodyOwner.originalFetch; const chunks: Uint8Array[] = [];
    if (response.body) {
      bodyOwner.readerAttempted = true;
      try { bodyOwner.reader = response.body.getReader(); }
      catch (error) { bodyOwner.readerError = error; throw error; }
      const reader = bodyOwner.reader;
      bodyOwner.originalRead = (async () => {
        let count = 0;
        while (true) { const next = await reader.read(); if (next.done) break; count += next.value.byteLength;
          assert.ok(count <= 131_072); chunks.push(next.value); }
        return chunks;
      })(); bodyOwner.originalRead.then(() => undefined, () => undefined);
      let failed = false, reason: unknown;
      try { await bodyOwner.originalRead; } catch (error) { failed = true; reason = error; }
      const closeErrors: unknown[] = [];
      if (failed) {
        bodyOwner.cancelAttempted = true;
        try { bodyOwner.originalCancel = reader.cancel(); bodyOwner.originalCancel.then(() => undefined, () => undefined);
          await bodyOwner.originalCancel; bodyOwner.cancelAcknowledged = true; }
        catch (error) { bodyOwner.cancelError = error; closeErrors.push(error); }
      }
      try { bodyOwner.releaseAttempted = true; reader.releaseLock(); bodyOwner.released = true; }
      catch (error) { bodyOwner.releaseError = error; closeErrors.push(error); }
      if (closeErrors.length) {
        if (failed) throw new AggregateError([reason, ...closeErrors], "Original body and first cancel/release failed");
        throw closeErrors[0];
      }
      if (failed) throw reason;
    }
    assert.equal(response.status, status);
    const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
    return { response, json: text ? JSON.parse(text) as Record<string, unknown> : null };
  }
  owner.setup = (async () => {
    owner.acquisition = acquireLinuxWriterLease({ databasePath, filesystemRootOwnerUid: 0 });
    owner.acquisition.then(() => undefined, () => undefined); const lease = owner.lease = await owner.acquisition;
    owner.nativeAttempted = true;
    try { owner.native = new DatabaseSync(databasePath, { allowExtension: false, enableForeignKeyConstraints: true }); nativeFirstClose(owner, owner.native); }
    catch (error) { owner.nativeError = error; throw error; }
    const native = owner.native, database = owner.database = createSqliteCapability(native); lease.bind(database, native);
    await lease.withWriter(() => {
      assert.equal(native.prepare("SELECT count(*) AS count FROM sqlite_schema").get()?.count, 0);
      installReviewedSqliteCatalog(native, V25); // Sole immutable code-owned historical fixture catalog.
    });
    const admission = admitInstallationRecoverySource(native, V25);
    assert.equal(assertInstallationAdmission(native, admission).checkpointId, "portable-runtime/v25");
    owner.identity = await createInstalledLocalIdentity({ database, nativeDatabase: native, admission, hasher: createPasswordHasher(), policy });
    await lease.withWriter(() => owner.identity!.offline(lease).bootstrap({ username: input.username, password: input.password, now: Date.now() }));
    owner.compositionAttempted = true;
    owner.composition = createNodeDevelopmentPrototype({ writerLease: lease, nativeDatabase: native, database, admission,
      hasher: createPasswordHasher(), identityPolicy: policy, now: Date.now, publicOrigin: origin, clientDirectory: "/opt/sample/client" });
    owner.composition.then(() => undefined, () => undefined);
    try { owner.prototype = await owner.composition; } catch (error) { owner.compositionError = error; throw error; }
    const server = owner.prototype.server;
    server.on("error", error => { owner.listenerFailure = error; });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.removeListener("listening", listening); reject(error); };
      const listening = () => { server.removeListener("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", listening); server.listen(14227, "127.0.0.1");
    });
    await request("/api/ready", 401);
    const login = await request("/api/auth/login", 200, "POST", { username: input.username, password: input.password });
    const cookies = login.response.headers.getSetCookie(); assert.equal(cookies.length, 1); assert.ok(cookies[0]!.includes("HttpOnly"));
    cookie = cookies[0]!.split(";", 1)[0]!; assert.ok(login.json && typeof login.json.csrf === "string"); csrf = login.json.csrf;
    assert.deepEqual((await request("/api/ready", 200)).json, { ok: true });
    const code = "V25-" + randomUUID().slice(0, 8).toUpperCase();
    const created = await request("/api/samples", 201, "POST", { code, title: "Historical upgrade original Sample" });
    assert.ok(created.json && typeof created.json.id === "string");
    const sample = await request("/api/samples/" + encodeURIComponent(created.json.id), 200); assert.ok(sample.json);
    await request("/api/samples/" + encodeURIComponent(created.json.id), 200, "PATCH", {
      expectedUpdatedAt: sample.json.updatedAt, title: "Historical upgrade persisted Sample" });
    const list = await request("/api/projects", 200); const subject = list.response.headers.get("x-sfw-project-creation-subject");
    assert.ok(subject && /^[a-f0-9]{64}$/.test(subject));
    const project = { id: "upgrade-" + randomUUID(), title: "Historical upgrade persisted Project", operationId: randomUUID() };
    const accepted = await request("/api/projects", 201, "POST", project, { "x-sfw-project-creation-subject": subject });
    const replay = await request("/api/projects", 200, "POST", project, { "x-sfw-project-creation-subject": subject });
    assert.ok(accepted.json && replay.json); assert.equal(accepted.json.replayed, false); assert.equal(replay.json.replayed, true);
    assert.deepEqual(replay.json.project, accepted.json.project);
    await request("/api/auth/logout", 204, "POST"); await request("/api/ready", 401);
    originalTableCount = await lease.withWriter(() => retainOriginalV25Witness(native));
  })(); owner.setup.then(() => undefined, () => undefined);
  let failed = false, reason: unknown;
  try { await owner.setup; } catch (error) { failed = true; reason = owner.setupError = error; }
  try { await closeOwner(owner); }
  catch (error) { if (failed) throw new AggregateError([reason, error], "Original historical setup and first close failed"); throw error; }
  finally { input.password = ""; cookie = csrf = ""; }
  if (failed) throw reason;
  assert.equal(retained.size, 0);
  process.stdout.write(JSON.stringify({ status: "PASS", checkpoint: "portable-runtime/v25", originalTables: originalTableCount,
    realHttpMetadataPopulated: true, noDomainSqlSeed: true, originalBodiesAndWitnessFilesClosed: true,
    originalApplicationNativeAndPhysicalFirstAck: true }) + "\n");
}
main().catch(() => {
  process.stdout.write(JSON.stringify({ status: "FAIL", originalOwnerRetained: retained.size !== 0,
    originalWitnessFileCloseUnproven: !originalWitnessFilesClosed() }) + "\n"); process.exitCode = 1;
});
