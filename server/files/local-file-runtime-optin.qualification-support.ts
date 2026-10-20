import { startNodeDevelopmentRuntime } from "../node-runtime";
import { loadNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { PROJECT_CREATE_INSERT_SQL } from "../../worker/projects/create-sql";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { lstatSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll as registerBeforeAll, it as registerCase, vi } from "vitest";
import { canonicalLocalVolumeNamespace } from "../../shared/contracts/local-volume-profile";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import { createInstalledLocalIdentity } from "../auth/identity";
import { createPasswordHasher } from "../auth/passwords";
import { hashRecipeManifest } from "../../shared/content-addressing";
import { hashSessionToken } from "../auth/tokens";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26";
import { admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog } from "../migrations";
import { acquireLinuxWriterLease } from "../operations/writer-lease";
import { createSqliteCapability, type SqliteCapability } from "../sqlite";
import { shutdownQuiescedSqliteDatabase } from "../sqlite-backup";
import { createOfflineLocalFileInitialization } from "../storage/local-file-initialization";
import { createLocalVolumeProfileLifecycle } from "../storage/local-volume-profile-lifecycle";
import { createLocalVolumeProfileOpening, type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening";

// Genuine operational Runtime controls. Trusted fixture provisioning settles
// and closes BEFORE production startNodeDevelopmentRuntime acquires its own
// sole native/core/physical owners. The real runtime creates no profile or grant.
const fixtureParent = process.env.NODE_PROTOTYPE_FIXTURE_PARENT ?? process.cwd();
const rootUid = lstatSync("/").uid;
const password = "actual local File Execution policy offline operator password";
const policy = { absoluteLifetimeMs: 120_000, idleLifetimeMs: 60_000, loginWindowMs: 1000,
  loginAttempts: 5, throttleBuckets: 100 };
const id = (part: number, slot = 1) => `${part.toString().padStart(8, "0")}-0000-4000-8000-${slot.toString().padStart(12, "0")}`;
const volumes = [1, 2].map(slot => {
  const namespace = Object.freeze({ kind: "local-volume" as const, volumeId: id(81, slot),
    rootId: id(82, slot), namespaceRevision: 1 as const });
  const digest = createHash("sha256").update(canonicalLocalVolumeNamespace(namespace)).digest("hex");
  return Object.freeze({ namespace, profileId: `storage-profile:local:${digest}`,
    id: id(83, slot), rootBindingId: id(84, slot) });
});
type Lease = Awaited<ReturnType<typeof acquireLinuxWriterLease>>;
interface RetainedCleanup { close(): Promise<void>; original?: Promise<void> }
const cleanups = new Set<RetainedCleanup>();
const operationOwners = new AsyncLocalStorage<Set<RetainedCleanup>>();
const cleanupRegistrations = new WeakMap<RetainedCleanup, Set<RetainedCleanup>>();
let directory: string, template: string, actor: string, sequence = 0;
interface NativeClose { run(): void; acknowledged(): boolean }
/** Retain the actual bound native first close outcome, including close-then-throw.
 * Every caller and the parent barrier share this same cached acknowledgement. */
function cacheNativeClose(native: DatabaseSync): NativeClose {
  const original = native.close.bind(native); let attempted = false, failed = false, error: unknown;
  const close = () => {
    if (attempted) { if (failed) throw error; return; }
    attempted = true;
    try { original(); }
    catch (reason) { failed = true; error = reason; throw reason; }
  };
  native.close = close;
  return { run: close, acknowledged: () => attempted && !failed };
}
function retain(close: () => Promise<void>): RetainedCleanup {
  const value = { close }, owners = operationOwners.getStore() ?? cleanups;
  owners.add(value); cleanupRegistrations.set(value, owners); return value;
}
function removeRegistration(cleanup: RetainedCleanup): void { cleanupRegistrations.get(cleanup)?.delete(cleanup); }
async function settleCleanup(cleanup: RetainedCleanup): Promise<void> {
  if (!cleanup.original) {
    try { cleanup.original = cleanup.close(); } catch (error) { cleanup.original = Promise.reject(error); }
    cleanup.original.then(() => undefined, () => undefined);
  }
  await cleanup.original; removeRegistration(cleanup);
}
// Whole original hook/case is registered BEFORE its first filesystem await;
// nested late setup owners belong only to its one active ALS root.
function retainOriginalOperation<T>(run: () => Promise<T>): Promise<T> {
  const owners = new Set<RetainedCleanup>();
  let original: Promise<T> | undefined, closing: Promise<void> | undefined;
  const root: RetainedCleanup = { close() {
    if (!closing) {
      closing = (async () => {
        if (original) await original.then(() => undefined, () => undefined);
        for (const cleanup of [...owners].reverse()) await settleCleanup(cleanup);
        cleanups.delete(root);
      })();
      closing.then(() => undefined, () => undefined);
    }
    return closing;
  } };
  cleanups.add(root);
  original = operationOwners.run(owners, async () => run());
  original.then(() => undefined, () => undefined); return original;
}
function beforeAll(body: () => Promise<void>, timeout: number): void {
  registerBeforeAll(() => retainOriginalOperation(body), timeout);
}
export function it(name: string, body: () => Promise<void>): void { registerCase(name, () => retainOriginalOperation(body)); }
async function drainFixtures(): Promise<void> {
  for (const cleanup of [...cleanups].reverse()) await settleCleanup(cleanup);
}
beforeAll(async () => {
  directory = await mkdtemp(join(fixtureParent, ".node-local-file-runtime-optin-"));
  template = join(directory, "installed-template.sqlite");
  let originalSetup: Promise<void> | undefined, originalNativeClose: Promise<void> | undefined;
  // Capture exactly one original close before it executes. A checkpoint/native
  // close failure stays rejected even if native.isOpen later becomes false.
  function closeTemplateNative(close: () => unknown): Promise<void> {
    if (!originalNativeClose) {
      originalNativeClose = Promise.resolve().then(close).then(() => undefined);
      originalNativeClose.then(() => undefined, () => undefined);
    }
    return originalNativeClose;
  }
  const owned: { lease?: Lease; native?: DatabaseSync; database?: SqliteCapability;
    originalAcquire?: ReturnType<typeof acquireLinuxWriterLease>; nativeConstructionAttempted?: true;
    nativeConstructionFailure?: unknown; closeNative?: NativeClose } = {};
  const templateCleanup = retain(async () => {
    if (originalSetup) await originalSetup.catch(() => undefined);
    // Await the same acquisition even if it rejected before returning a handle.
    // Missing returned native construction never proves physical cleanup.
    if (owned.originalAcquire) owned.lease = await owned.originalAcquire;
    await owned.lease?.stopAdmissionAndDrain();
    if (owned.nativeConstructionAttempted && !owned.native) throw owned.nativeConstructionFailure;
    await closeTemplateNative(() => { if (owned.database) owned.database.close(); else owned.closeNative?.run(); });
    if (owned.native && !owned.closeNative?.acknowledged()) throw new Error("Template native first close acknowledgement is unavailable");
    if (owned.native?.isOpen) throw new Error("Template native owner remains open");
    await owned.lease?.release();
  });
  const setup = async () => {
    await writeFile(template, "", { flag: "wx", mode: 0o600 });
    await writeFile(`${template}.writer-lock`, "", { flag: "wx", mode: 0o600 });
    owned.originalAcquire = acquireLinuxWriterLease({ databasePath: template, filesystemRootOwnerUid: rootUid });
    owned.originalAcquire.then(() => undefined, () => undefined);
    const lease = owned.lease = await owned.originalAcquire;
    owned.nativeConstructionAttempted = true;
    let native: DatabaseSync;
    try {
      native = owned.native = new DatabaseSync(template, { allowExtension: false });
      owned.closeNative = cacheNativeClose(native);
    } catch (error) { owned.nativeConstructionFailure = error; throw error; }
    const database = owned.database = createSqliteCapability(native); lease.bind(database, native);
    await lease.withWriter(async () => {
      installReviewedSqliteCatalog(native, V26_NODE_INSTALLATION_CATALOG);
      const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
      const identity = await createInstalledLocalIdentity({ nativeDatabase: native, database, admission,
        hasher: createPasswordHasher(), policy });
      actor = (await identity.offline(lease).bootstrap({ username: "execution.operator", password, now: Date.now() })).actor;
      await closeTemplateNative(() => shutdownQuiescedSqliteDatabase(native));
    });
  };
  originalSetup = setup(); originalSetup.then(() => undefined, () => undefined);
  let setupFailure: unknown;
  try { await originalSetup; } catch (error) { setupFailure = error; }
  // Never await the active outer beforeAll root from inside its own body.
  try { await settleCleanup(templateCleanup); } catch (cleanupFailure) {
    if (setupFailure) throw new AggregateError([setupFailure, cleanupFailure], "Execution template setup and cleanup failed");
    throw cleanupFailure;
  }
  if (setupFailure) throw setupFailure;
}, 20_000); // Existing genuine schema/KDF setup boundary; cases keep default5s.
afterEach(async () => { try { await drainFixtures(); } finally { vi.restoreAllMocks(); } });
afterAll(async () => {
  await drainFixtures();
  console.info("Retained explicitly configured Node File application fixture evidence:", { directory });
});
export function count(native: DatabaseSync, table: string, condition = "1"): number {
  return configurationSqlInteger(native.prepare(`SELECT count(*) n FROM ${table} WHERE ${condition}`).get()!.n, "Execution native count");
}
type Runtime = Awaited<ReturnType<typeof startNodeDevelopmentRuntime>>;
export interface ClientReply { readonly status: number; readonly value: unknown; readonly headers: Headers }
interface Generation {
  originalAcquire?: ReturnType<typeof acquireLinuxWriterLease>;
  lease?: Lease; native?: DatabaseSync; database?: SqliteCapability; closeNative?: NativeClose;
  nativeConstructionAttempted?: true; nativeConstructionFailure?: unknown;
  opening?: LocalVolumeProfileOpening; openingAttempted?: true;
  runtime?: Runtime; runtimeAttempted?: true;
  originalConstruction?: Promise<Runtime>; originalSetup?: Promise<void>;
  originalClose?: Promise<void>;
  children: Set<() => Promise<void>>;
  sealed: boolean;
}

/** Every original generation, client body and first close remains owned.
 * The genuine operational runtime is the sole final native/lease owner after
 * its constructor is attempted; the fixture has no internal runtime handle. */
export async function fixture(input: { enableLocalFile?: unknown; omitVolumeDescriptors?: boolean } = { enableLocalFile: true }) {
  const root = join(directory, `case-${++sequence}`), data = join(root, "data"), path = join(data, "application.sqlite");
  const generations: Generation[] = [], clients = new Set<Promise<ClientReply>>();
  let current: Generation | undefined, originalSetup: Promise<void> | undefined;
  let reservation: ReturnType<typeof createServer> | undefined, reservationClose: Promise<void> | undefined;
  let origin = "", port = 0, cookie = "", csrf = "", tokenHash = "", sealed = false;
  let configuration: LoadedNodeRuntimeConfiguration;
  const configurationPath = join(root, "runtime.json");
  const closeReservation = () => reservationClose ??= (async () => {
    if (reservation?.listening) await new Promise<void>((resolve, reject) => reservation!.close(error => error ? reject(error) : resolve()));
  })();
  function closeGeneration(value: Generation): Promise<void> {
    if (value.originalClose) return value.originalClose;
    value.sealed = true;
    value.originalClose = (async () => {
      if (value.originalSetup) await value.originalSetup.then(() => undefined, () => undefined);
      if (value.originalAcquire) value.lease = await value.originalAcquire;
      // Every registered secondary must acknowledge its ORIGINAL first close
      // before the sole application owner may release the physical writer FD.
      for (const closeChild of [...value.children].reverse()) await closeChild();
      if (value.runtimeAttempted) {
        if (value.originalConstruction) await value.originalConstruction;
        if (!value.runtime) throw new Error("Original Node runtime construction ownership was not returned");
        await value.runtime.close();
      } else {
        if (value.openingAttempted && !value.opening) throw new Error("Original initialization opening ownership was not returned");
        await value.opening?.close();
        await value.lease?.stopAdmissionAndDrain();
        if (value.nativeConstructionAttempted && !value.native) throw value.nativeConstructionFailure;
        if (value.database) value.database.close(); else value.closeNative?.run();
        if (value.native && (!value.closeNative?.acknowledged() || value.native.isOpen))
          throw new Error("Original Node fixture native first close is unproven");
        await value.lease?.release();
      }
      // Observe the exact bound native close outcome even after isOpen=false.
      value.closeNative?.run();
      if (value.native && (!value.closeNative?.acknowledged() || value.native.isOpen))
        throw new Error("Original Node application native first close is unproven");
    })();
    value.originalClose.then(() => undefined, () => undefined); return value.originalClose;
  }
  const retained = retain(async () => {
    sealed = true;
    if (originalSetup) await originalSetup.then(() => undefined, () => undefined);
    await closeReservation();
    // Exact fetch AND full original Response.text consumption remain strong;
    // a rejected or uncertain client lifetime cannot be erased by bodyUsed.
    for (const original of clients) await original;
    for (const generation of [...generations].reverse()) await closeGeneration(generation);
  });
  function client(method: string, pathname: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ClientReply> {
    if (sealed || !current || current.sealed) throw new Error("Original Node fixture client admission is closed");
    const original = Promise.resolve().then(async () => {
      const response = await fetch(`${origin}${pathname}`, { method,
        headers: { cookie, origin, "x-sfw-csrf": csrf, "content-type": "application/json", connection: "close", ...extraHeaders },
        ...(body === undefined ? {} : { body: body instanceof ReadableStream || body instanceof Uint8Array ? body : JSON.stringify(body), duplex: "half" }) } as RequestInit);
      const text = await response.text();
      const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      return { status: response.status, headers: response.headers,
        value: text ? (type === "application/json" ? JSON.parse(text) as unknown : text) : null };
    });
    clients.add(original); original.then(() => clients.delete(original), () => undefined); return original;
  }
  async function mountedLogin(): Promise<void> {
    const answer = await client("POST", "/api/auth/login", { username: "execution.operator", password });
    const value = answer.value, setCookie = answer.headers.get("set-cookie");
    if (answer.status !== 200 || !value || typeof value !== "object" || !("csrf" in value)
      || typeof value.csrf !== "string" || !setCookie?.startsWith("sfw_dev_session="))
      throw new Error("Actual mounted Node authentication handshake is required");
    cookie = setCookie.split(";", 1)[0]!; csrf = value.csrf;
    tokenHash = hashSessionToken(cookie.slice("sfw_dev_session=".length));
  }
  async function construct(value: Generation): Promise<void> {
    value.runtimeAttempted = true;
    value.originalConstruction = startNodeDevelopmentRuntime(configuration);
    value.originalConstruction.then(() => undefined, () => undefined);
    value.runtime = await value.originalConstruction;
    await mountedLogin();
  }
  async function nativeOwner(value: Generation): Promise<void> {
    value.originalAcquire = acquireLinuxWriterLease({ databasePath: path, filesystemRootOwnerUid: rootUid });
    value.originalAcquire.then(() => undefined, () => undefined);
    const lease = value.lease = await value.originalAcquire;
    value.nativeConstructionAttempted = true;
    try {
      value.native = new DatabaseSync(path, { allowExtension: false }); value.closeNative = cacheNativeClose(value.native);
    } catch (error) { value.nativeConstructionFailure = error; throw error; }
    value.database = createSqliteCapability(value.native); lease.bind(value.database, value.native);
  }
  const newGeneration = () => {
    const value: Generation = { children: new Set(), sealed: false };
    generations.push(value); current = value; return value;
  };
  const setup = async () => {
    await mkdir(root, { mode: 0o700 }); await mkdir(data, { mode: 0o700 }); await copyFile(template, path);
    await writeFile(`${path}.writer-lock`, "", { flag: "wx", mode: 0o600 });
    const descriptors = [];
    for (const volume of volumes) {
      const bytesRoot = join(root, volume.id); await mkdir(bytesRoot, { mode: 0o700 });
      for (const child of ["objects", "staging"]) await mkdir(join(bytesRoot, child), { mode: 0o700 });
      await writeFile(join(bytesRoot, "namespace.json"), JSON.stringify({ format: "local-byte-namespace-v1", namespace: {
        volumeId: volume.namespace.volumeId, rootId: volume.namespace.rootId, profileId: volume.profileId, namespaceRevision: 1,
      } }), { flag: "wx", mode: 0o600 });
      descriptors.push({ id: volume.id, root: bytesRoot, rootBindingId: volume.rootBindingId, namespace: volume.namespace });
    }
    await mkdir(join(root, "client"), { mode: 0o700 });
    // This is an API/socket fixture, not a frontend build or producer proof.
    await writeFile(join(root, "client", "index.html"), "<!doctype html><title>API fixture</title>", { flag: "wx", mode: 0o600 });
    reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const address = reservation.address(); if (!address || typeof address === "string") throw new Error("Actual loopback port required");
    port = address.port; origin = `http://127.0.0.1:${port}`; await closeReservation();
    const value = newGeneration();
    // Assign the full original generation setup before asynchronous acquisition.
    value.originalSetup = (async () => {
      await nativeOwner(value);
      const native = value.native!, database = value.database!, lease = value.lease!;
      const admission = await lease.withWriter(() => admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG));
      const identity = await createInstalledLocalIdentity({ database, nativeDatabase: native, admission, hasher: createPasswordHasher(), policy });
      const session = await lease.withWriter(() => identity.login({ username: "execution.operator", password,
        sourceKey: "actual-node-file-initialization", now: Date.now() }));
      value.openingAttempted = true;
      const opening = value.opening = createLocalVolumeProfileOpening({ database, nativeDatabase: native, admission,
        writerLease: lease, descriptors, filesystemRootOwnerUid: rootUid, async authorizeAdministrator(selected) {
          const principal = await identity.authenticate(session.token, Date.now());
          return principal?.actor === selected && principal.capabilities.systemAdministrator;
        } });
      const lifecycle = createLocalVolumeProfileLifecycle(opening);
      for (const [index, volume] of volumes.entries()) {
        await opening.register({ operationId: id(85, index + 1), volumeDescriptorId: volume.id }, actor);
        await lifecycle.probeAndBind({ operationId: id(86, index + 1), checkId: id(87, index + 1),
          volumeDescriptorId: volume.id, access: "read_write", expectedBindingRevision: null }, actor);
        await lifecycle.activate({ operationId: id(88, index + 1), volumeDescriptorId: volume.id, expectedBindingRevision: 1 }, actor);
      }
      const manifestHash = await hashRecipeManifest([]);
      await lease.withWriter(() => {
        const at = new Date().toISOString();
        native.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('execution-family','Current genuine Execution family','process',?)").run(at);
        native.prepare(`INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at)
          VALUES('execution-template','execution-family','Current genuine Execution template','process',1,?,'{}',?)`).run(manifestHash, at);
        native.prepare(`INSERT INTO samples(id,code,title,status,created_by,updated_by,created_at,updated_at)
          VALUES('execution-sample','Execution-S1','Current genuine Execution sample','stored',?,?,?,?)`).run(actor, actor, at, at);
        native.prepare(`INSERT INTO runs(id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,
          template_name_snapshot,template_type_snapshot,template_version_snapshot,status,created_at,run_kind,created_by)
          VALUES('execution-run','execution-sample','execution-family','execution-template',1,'execution-group',
            'Current genuine Execution template','process',1,'active',?,'process',?)`).run(at, actor);
        native.prepare(`INSERT INTO run_steps(id,run_id,position,origin,plan_status,title,status,entry_kind,updated_by,created_at,updated_at)
          VALUES('execution-step','execution-run',1000,'ad_hoc','current','Original current Execution step','pending','fabrication',?,?,?)`).run(actor, at, at);
        native.prepare(PROJECT_CREATE_INSERT_SQL).run("project-source", "Actual local Project workspace", "initial-project", actor, actor, at, at);
      });
      const epoch = configurationSqlInteger(native.prepare("SELECT epoch FROM file_shadow_control WHERE singleton=1").get()!.epoch, "Actual Node File initialization epoch");
      await createOfflineLocalFileInitialization(opening).initialize({ requestId: id(89), expectedEpoch: epoch,
        internalProfileId: volumes[0]!.profileId, originalsProfileId: volumes[1]!.profileId }, actor);
      // Preserve the real destination bootstrap administrator required by the
      // operational runtime. Trusted profile initialization is fixture-only.
      await opening.close();
      await writeFile(configurationPath, JSON.stringify({ format: "node-loopback-development-v1", dataDirectory: data,
        expectedInstallationId: assertInstallationAdmission(native, admission).installationId, publicOrigin: origin, clientDirectory: join(root, "client"), localVolumes: input.omitVolumeDescriptors ? [] : descriptors,
        ...(Object.hasOwn(input, "enableLocalFile") ? { enableLocalFile: input.enableLocalFile } : {}) }),
        { flag: "wx", mode: 0o600 });
      configuration = loadNodeRuntimeConfiguration(configurationPath, { filesystemRootOwnerUid: rootUid });
    })();
    value.originalSetup.then(() => undefined, () => undefined); await value.originalSetup;
    // Await the full trusted preparation before its cached original close.
    await closeGeneration(value);
    const running = newGeneration();
    running.originalSetup = construct(running);
    running.originalSetup.then(() => undefined, () => undefined); await running.originalSetup;
  };
  originalSetup = setup(); originalSetup.then(() => undefined, () => undefined);
  try { await originalSetup; }
  catch (setupFailure) {
    try { await settleCleanup(retained); }
    catch (cleanupFailure) { throw new AggregateError([setupFailure, cleanupFailure], "Original Node File application setup and cleanup failed"); }
    throw setupFailure;
  }
  return {
    path, root, origin, configurationPath,
    get tokenHash() { return tokenHash; }, request: client,
    secondary() {
      const parent = current!;
      if (sealed || parent.sealed) throw new Error("Original secondary admission is closed");
      const child: { native?: DatabaseSync; closeNative?: NativeClose; constructionFailure?: unknown } = {};
      let original: Promise<void> | undefined;
      const childClose = () => original ??= (async () => {
        if (!child.closeNative) throw child.constructionFailure;
        child.closeNative.run();
        if (!child.closeNative.acknowledged() || child.native?.isOpen) throw new Error("Original secondary first close is unproven");
        parent.children.delete(childClose);
      })();
      parent.children.add(childClose);
      try { child.native = new DatabaseSync(path, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true });
        child.closeNative = cacheNativeClose(child.native); }
      catch (error) { child.constructionFailure = error; throw error; }
      child.native.exec("PRAGMA busy_timeout=0"); return child.native;
    },
    // This calls the real operational runtime drain before waiting for client delivery;
    // its exact original API/body promise is owned by the prototype itself.
    stopAndDrainApplication() { return closeGeneration(current!); },
    async restart() {
      const previous = current!; await closeGeneration(previous);
      if (sealed) throw new Error("Original fixture restart admission is closed");
      const value = newGeneration();
      value.originalSetup = construct(value);
      value.originalSetup.then(() => undefined, () => undefined); await value.originalSetup;
    },
    async stoppedRows(table: "files" | "assets" | "file_usable_publications" | "node_migrations") {
      await closeGeneration(current!); // Exact production first ACK before readonly inspection.
      const owned: { native?: DatabaseSync; closeNative?: NativeClose; attempted?: true; failure?: unknown } = {};
      const inspection = retain(async () => {
        if (!owned.closeNative) { if (owned.attempted) throw owned.failure; return; }
        owned.closeNative.run();
        if (!owned.closeNative.acknowledged() || owned.native?.isOpen) throw new Error("Original stopped inspection first close is unproven");
      });
      owned.attempted = true;
      try {
        owned.native = new DatabaseSync(path, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true });
        owned.closeNative = cacheNativeClose(owned.native);
      } catch (error) { owned.failure = error; throw error; }
      let failed = false, failure: unknown, result: unknown;
      try { const query = owned.native.prepare(`SELECT * FROM ${table} ORDER BY 1`); query.setReadBigInts(true); result = query.all(); }
      catch (error) { failed = true; failure = error; }
      try { await settleCleanup(inspection); }
      catch (cleanupFailure) { if (failed) throw new AggregateError([failure, cleanupFailure], "Stopped inspection and cleanup failed"); throw cleanupFailure; }
      if (failed) throw failure;
      return result;
    },
    close: () => settleCleanup(retained),
  };
}
export { actor, volumes };
