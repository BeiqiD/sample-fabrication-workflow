import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, copyFile, lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createInstalledLocalIdentity, type IdentityPolicy } from "../../auth/identity";
import { createPasswordHasher } from "../../auth/passwords";
import { createLocalAuthentication, type LocalAuthEnvironment } from "../../auth/local-auth-http";
import { createLoopbackLocalAuthTransport } from "../../auth/local-auth-transport";
import { hashSessionToken } from "../../auth/tokens";
import { createNodeHttpServer, stopNodeHttpServerAndDrain } from "../../http";
import { admitInstallationRecoverySource, installReviewedSqliteCatalog } from "../../migrations";
import { acquireLinuxWriterLease } from "../../operations/writer-lease";
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from "../../operational-installation-catalog";
import { createSqliteCapability } from "../../sqlite";
import { shutdownQuiescedSqliteDatabase } from "../../sqlite-backup";
import { createInstalledJobPrincipalAuthority } from "./principal-authority";
import { createNodeFileJobHttpRoutes } from "./request-http";

// These actual fixtures remain UNRUN. Historical R2 publication metadata is
// explicitly synthetic; no provider, dispatcher or ordinary File grant exists.
const PASSWORD = "Synthetic original File job HTTP operator password";
const POLICY: IdentityPolicy = { absoluteLifetimeMs: 60_000, idleLifetimeMs: 30_000,
  loginWindowMs: 1000, loginAttempts: 5, throttleBuckets: 100 };
export const CONTENT = new TextEncoder().encode("Retained File job HTTP source bytes");
export const DIGEST = createHash("sha256").update(CONTENT).digest("hex");
export const JOB_TABLES = ["file_migration_jobs", "file_migration_items", "file_migration_attempts",
  "file_location_holds", "file_job_cleanup_grants"] as const;
const roots = new Set<() => Promise<void>>(), scopes = new AsyncLocalStorage<Set<() => Promise<void>>>();
function retain(close: () => Promise<void>) {
  const scope = scopes.getStore(); let original: Promise<void> | undefined;
  const cached = () => original ??= (async () => { await close(); (scope ?? roots).delete(cached); })();
  (scope ?? roots).add(cached); return cached;
}
export function originalOperation<T>(run: () => Promise<T>): Promise<T> {
  const scope = new Set<() => Promise<void>>(); let original: Promise<T> | undefined, closure: Promise<void> | undefined;
  const close = () => closure ??= (async () => {
    if (original) await original.then(() => undefined, () => undefined);
    // A child's first failure blocks its parent native close and physical ACK.
    for (const child of [...scope].reverse()) await child();
    roots.delete(close);
  })();
  roots.add(close); original = scopes.run(scope, run); return original;
}
export async function drainFixtures() { for (const close of [...roots].reverse()) await close(); }
let template: string, rootOwnerUid: number;
export let principalId: string, actor: string;
const hasher = createPasswordHasher();
export async function prepareTemplate() {
  const observed = await lstat("/", { bigint: true }); rootOwnerUid = Number(observed.uid);
  if (!Number.isSafeInteger(rootOwnerUid) || rootOwnerUid < 0 || rootOwnerUid > 0xffff_ffff
    || BigInt(rootOwnerUid) !== observed.uid) throw new Error("Actual filesystem root owner is unavailable");
  const parent = await realpath(process.cwd());
  if (parent !== process.cwd()) throw new Error("Canonical private checkout is required");
  const directory = await mkdtemp(join(parent, ".job-http-template-")); await chmod(directory, 0o700);
  template = join(directory, "closed-v26.sqlite");
  console.info("Retained actual Job HTTP template:", directory);
  let lease: Awaited<ReturnType<typeof acquireLinuxWriterLease>> | undefined;
  let native: DatabaseSync | undefined, core: ReturnType<typeof createSqliteCapability> | undefined;
  let setup: Promise<void> | undefined;
  const close = retain(async () => {
    if (setup) await setup.then(() => undefined, () => undefined);
    if (!lease) return;
    await lease.stopAdmissionAndDrain();
    if (native?.isOpen) { if (core) { shutdownQuiescedSqliteDatabase(native); core.close(); } else native.close(); }
    if (native?.isOpen) throw new Error("Original template native close is unproven");
    await lease.release();
  });
  setup = (async () => {
    await writeFile(template, "", { flag: "wx", mode: 0o600 });
    await writeFile(`${template}.writer-lock`, "", { flag: "wx", mode: 0o600 });
    lease = await acquireLinuxWriterLease({ databasePath: template, filesystemRootOwnerUid: rootOwnerUid });
    native = new DatabaseSync(template, { allowExtension: false, enableForeignKeyConstraints: true });
    core = createSqliteCapability(native); lease.bind(core, native);
    const ownedLease = lease, ownedNative = native, ownedCore = core;
    await ownedLease.withWriter(() => installReviewedSqliteCatalog(ownedNative, OPERATIONAL_NODE_INSTALLATION_CATALOG));
    const admission = admitInstallationRecoverySource(ownedNative, OPERATIONAL_NODE_INSTALLATION_CATALOG);
    const identity = await ownedLease.withWriter(() => createInstalledLocalIdentity({ nativeDatabase: ownedNative, database: ownedCore,
      admission, hasher, policy: POLICY }));
    const principal = await ownedLease.withWriter(() => identity.offline(ownedLease).bootstrap({ username: "job.operator", password: PASSWORD, now: Date.now() }));
    principalId = principal.id; actor = principal.actor;
  })();
  try { await setup; } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Original template setup and cleanup failed"); }
    throw error;
  }
  await close();
}
function seedHistoricalFile(native: DatabaseSync) {
  const triggers = native.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all().map(row => {
    if (typeof row.name !== "string" || typeof row.sql !== "string") throw new Error("Actual fixed fixture DDL is unavailable");
    return { name: row.name, sql: row.sql };
  });
  native.exec("BEGIN IMMEDIATE");
  try {
    for (const trigger of triggers) native.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    const at = new Date().toISOString();
    native.prepare("UPDATE file_authority_control SET mode='active',activated_at=?,updated_at=?").run(at, at);
    native.prepare("UPDATE file_authority_runtime_guard SET incarnation='historical-http-file',enabled=1,enabled_by='historical-fixture',updated_at=?").run(at);
    native.prepare("UPDATE file_job_runtime_guard SET enabled=1,incarnation='historical-http-jobs'").run();
    for (const profile of ["source", "target"]) {
      native.prepare(`INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
        VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)`).run(profile,
        JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: `historical-http-${profile}` }), at);
      native.prepare("INSERT INTO storage_profile_runtime VALUES(?,'read_write',?,?,NULL)").run(profile, at, at);
    }
    native.prepare(`INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
      VALUES('file','embedded_content','system',?,?,'unresolved',?)`).run(CONTENT.length, DIGEST, at);
    native.prepare(`INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
      VALUES('source-location','file','source','retained/source','unresolved',?)`).run(at);
    native.prepare("INSERT INTO file_location_publications VALUES('source-location','file','source','retained/source',?,?,'full_read_sha256','historical-fixture',?,?)")
      .run(CONTENT.length, DIGEST, at, at);
    native.prepare("INSERT INTO file_publications VALUES('file','embedded_content','system',?,?,'source-location','ready',?,NULL)").run(CONTENT.length, DIGEST, at);
    for (const trigger of triggers) native.exec(trigger.sql);
    native.exec("COMMIT");
  } catch (error) { native.exec("ROLLBACK"); throw error; }
}
export async function fixture() {
  let directory = "", path = "", lease: Awaited<ReturnType<typeof acquireLinuxWriterLease>> | undefined;
  let native: DatabaseSync | undefined, core: ReturnType<typeof createSqliteCapability> | undefined;
  let reservation: ReturnType<typeof createServer> | undefined, server: ReturnType<typeof createNodeHttpServer> | undefined;
  let component: ReturnType<typeof createNodeFileJobHttpRoutes> | undefined, authority: ReturnType<typeof createInstalledJobPrincipalAuthority> | undefined;
  let setup: Promise<unknown> | undefined, sealed = false;
  const children = new Set<() => Promise<void>>(), responses = new Set<() => Promise<void>>();
  const close = retain(async () => {
    sealed = true;
    if (setup) await setup.then(() => undefined, () => undefined);
    component?.stopAdmission();
    const httpDrain = server ? stopNodeHttpServerAndDrain(server) : Promise.resolve();
    const requestDrain = component ? component.drain() : Promise.resolve();
    // Retain both original drain promises; a rejection never starts a native fallback.
    const clientDrain = (async () => {
      while (responses.size) for (const responseClose of [...responses].reverse()) await responseClose();
    })();
    const settled = await Promise.allSettled([httpDrain, requestDrain, clientDrain]);
    const errors = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(r => r.reason), "Original Job HTTP host drain is unproven");
    if (reservation?.listening) await new Promise<void>((resolve, reject) => reservation!.close(error => error ? reject(error) : resolve()));
    if (!lease) return;
    await lease.stopAdmissionAndDrain();
    for (const child of [...children].reverse()) await child();
    authority?.close();
    if (native?.isOpen) { if (core) core.close(); else native.close(); }
    if (native?.isOpen) throw new Error("Original Job HTTP native close is unproven");
    await lease.release();
  });
  const originalSetup = async () => {
    directory = await mkdtemp(join(await realpath(process.cwd()), ".job-http-case-")); await chmod(directory, 0o700);
    console.info("Retained actual Job HTTP fixture:", directory);
    path = join(directory, "application.sqlite"); await copyFile(template, path); await chmod(path, 0o600);
    await writeFile(`${path}.writer-lock`, "", { flag: "wx", mode: 0o600 });
    lease = await acquireLinuxWriterLease({ databasePath: path, filesystemRootOwnerUid: rootOwnerUid });
    native = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true });
    core = createSqliteCapability(native); lease.bind(core, native);
    const ownedLease = lease, ownedNative = native, ownedCore = core;
    await ownedLease.withWriter(() => seedHistoricalFile(ownedNative));
    const admission = admitInstallationRecoverySource(ownedNative, OPERATIONAL_NODE_INSTALLATION_CATALOG);
    const identity = await ownedLease.withWriter(() => createInstalledLocalIdentity({ nativeDatabase: ownedNative, database: ownedCore,
      admission, hasher, policy: POLICY }));
    reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const address = reservation.address(); if (!address || typeof address === "string") throw new Error("Actual loopback port is unavailable");
    const origin = `http://127.0.0.1:${address.port}`, transport = createLoopbackLocalAuthTransport({ publicOrigin: origin });
    const auth = createLocalAuthentication({ identity, transport, now: Date.now });
    authority = createInstalledJobPrincipalAuthority({ nativeDatabase: ownedNative, database: ownedCore, admission, writerLease: ownedLease });
    component = createNodeFileJobHttpRoutes({ authority, authentication: auth, admission, writerLease: ownedLease });
    const app = new Hono<LocalAuthEnvironment>(); app.route("/api/auth", auth.routes);
    app.use("/api/files/*", auth.middleware); app.route("/api", component.routes);
    const ownedComponent = component;
    server = createNodeHttpServer(request => ownedLease.withWriter(() => app.fetch(request)),
      { publicOrigin: origin, requestAdmission: (request, incoming, actualServer) => transport.admit(request, incoming, actualServer) });
    await new Promise<void>((resolve, reject) => reservation!.close(error => error ? reject(error) : resolve()));
    server.listen(address.port, "127.0.0.1"); await once(server, "listening");
    const observedResponses = new WeakSet<Response>();
    function retainResponse(response: Response): void {
      if (observedResponses.has(response)) return;
      observedResponses.add(response);
      const consumptions = new Set<Promise<unknown>>();
      let cleanup: Promise<void> | undefined;
      const responseClose = () => cleanup ??= (async () => {
        // Each successful original full-body method is an observed EOF. A lock
        // without that owner never authorizes unlock, clone or a new reader.
        for (const original of consumptions) await original;
        if (!consumptions.size) {
          if (response.body?.locked) {
            const error = new Error("Original client response body ownership is uncertain");
            Object.defineProperty(error, "owner", { value: Object.freeze({ response, consumptions }) });
            throw error;
          }
          if (response.body) await response.body.cancel();
        }
        responses.delete(responseClose);
      })();
      responses.add(responseClose); // Strong owner precedes exposing any method.
      for (const name of ["arrayBuffer", "blob", "formData", "json", "text"] as const) {
        const method = response[name];
        Object.defineProperty(response, name, { configurable: true, writable: true,
          value: function(this: Response, ...args: unknown[]) {
            if (this !== response) return Reflect.apply(method, this, args);
            let original: Promise<unknown>;
            try { original = Reflect.apply(method, response, args) as Promise<unknown>; }
            catch (error) {
              original = Promise.reject(error); original.then(() => undefined, () => undefined);
              consumptions.add(original); throw error;
            }
            consumptions.add(original); original.then(() => undefined, () => undefined);
            return original; // Exact original json/text/etc Promise, never a DTO.
          } });
      }
    }
    const request = (route: string, input: RequestInit = {}): Promise<Response> => {
      if (sealed) throw new Error("Original client request admission is closed");
      let original: Promise<Response> | undefined, observation: Promise<void> | undefined, cleanup: Promise<void> | undefined;
      const requestClose = () => cleanup ??= (async () => {
        if (!original) throw new Error("Original client fetch ownership is unavailable");
        const delivered = await original;
        if (observation) await observation; else retainResponse(delivered);
        responses.delete(requestClose);
      })();
      responses.add(requestClose); // Register before the actual fetch starts.
      try { original = fetch(origin + route, { ...input, redirect: "manual" }); }
      catch (error) { original = Promise.reject(error); }
      // Registered before caller reactions: bind actual consumption ownership
      // on the exact original Response before exposing that same fetch result.
      observation = original.then(retainResponse);
      observation.then(() => undefined, () => undefined);
      return original;
    };
    const login = async () => {
      const response = await request("/api/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ username: "job.operator", password: PASSWORD }) });
      if (response.status !== 200) throw new Error("Actual Job HTTP login failed");
      const cookie = response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
      const value = await response.json() as { csrf: string; principal: { actor: string } };
      if (value.principal.actor !== actor) throw new Error("Actual Job HTTP actor changed");
      return { cookie, csrf: value.csrf, tokenHash: hashSessionToken(cookie.slice(cookie.indexOf("=") + 1)) };
    };
    function secondary() {
      if (sealed) throw new Error("Original secondary admission is closed");
      let child: DatabaseSync | undefined, original: Promise<void> | undefined;
      const dispose = () => original ??= (async () => { if (child?.isOpen) child.close();
        if (child?.isOpen) throw new Error("Original secondary native close is unproven"); children.delete(dispose); })();
      children.add(dispose); // Register before the actual constructor can throw.
      child = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true }); child.exec("PRAGMA busy_timeout=0");
      return child;
    }
    return { directory, path, native: ownedNative, core: ownedCore, lease: ownedLease, authority,
      admission, auth, app, component: ownedComponent, server, origin, request, retainResponse, login, secondary, close };
  };
  const original = originalSetup(); setup = original;
  try { return await original; }
  catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Original Job HTTP fixture setup and cleanup failed"); }
    throw error;
  }
}
