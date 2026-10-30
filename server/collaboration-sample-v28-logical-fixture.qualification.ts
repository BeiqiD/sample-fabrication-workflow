import { afterAll, afterEach, expect } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeSync } from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createInstalledLocalIdentity } from "./auth/identity";
import { createPasswordHasher, type PasswordHasher } from "./auth/passwords";
import { createSampleOnlyV28HostCandidate, SAMPLE_ONLY_V28_ROUTES } from "./collaboration/sample-only-v28-host-candidate";
import { V26_NODE_INSTALLATION_CATALOG } from "./installation-catalog-v26";
import { V27_INERT_NODE_INSTALLATION_CATALOG_CANDIDATE } from "./installation-catalog-v27-candidate";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "./installation-catalog-v28-candidate";
import { admitInstallationRecoverySource, installReviewedSqliteCatalog } from "./migrations";
import { executeCollaborationV28OperatorCandidate, type CollaborationOperatorV28Command } from "./operations/collaboration-v28-operator-candidate";
import { executeV28OrdinaryAccountOperatorCandidate, parseV28OrdinaryAccountOperatorCommand, v28OrdinaryAccountOperatorProcessState } from "./operations/ordinary-account-v28-candidate";
import { acquireLinuxWriterLease } from "./operations/writer-lease";
import { createSqliteCapability } from "./sqlite";

// SOURCE-ONLY UNRUN. Positive grants come exclusively from explicit stopped
// named enrollment/root/control operators. Direct SQL below is only a deliberate
// negative revocation/control fault, never a positive authority fixture.
export const password = "Synthetic genuine V28 ordinary account qualification password";
export const graph = readFileSync(new URL("../worker/fixtures/reference-graph.sql", import.meta.url), "utf8");
export const policy = Object.freeze({ absoluteLifetimeMs: 120000, idleLifetimeMs: 30000, loginWindowMs: 1000, loginAttempts: 5, throttleBuckets: 100 });
const cleanups: Array<() => Promise<void>> = [], scopes = new AsyncLocalStorage<Set<() => Promise<void>>>();
export let rootOwnerUid: number;
export let adminId: string, aliceId: string, bobId: string;
export function retain(close: () => Promise<void>) {
  let done = false, closing: Promise<void> | undefined;
  const owner = () => done ? Promise.resolve() : closing ?? (closing = (async () => { await close(); done = true; })());
  const outer = scopes.getStore(); if (outer) outer.add(owner); else cleanups.push(owner);
  return owner; // A rejected FIRST cleanup is retained, never reset or retried.
}
export function original<T>(run: () => Promise<T>): Promise<T> {
  const scope = new Set<() => Promise<void>>(); let pending: Promise<T> | undefined;
  retain(async () => {
    if (pending) { try { await pending; } catch { /* Preserve the original case error. */ } }
    const errors: unknown[] = [];
    for (const owner of [...scope].reverse()) { try { await owner(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Original Sample-only V28 owners remain unproven");
  });
  pending = scopes.run(scope, async () => run()); return pending;
}
async function drain() {
  const errors: unknown[] = [];
  for (const owner of cleanups.slice().reverse()) {
    try { await owner(); const index = cleanups.indexOf(owner); if (index !== -1) cleanups.splice(index, 1); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Sample-only V28 original cleanup remains unproven");
}
afterEach(drain); afterAll(drain);

export async function privateCopy(source?: string) {
  const directory = await mkdtemp("/workspace/.group-sample-v28-"); await chmod(directory, 0o700);
  console.info("Retained Sample-only V28 fixture:", directory);
  const path = join(directory, "application.sqlite");
  if (source) { await copyFile(source, path); await chmod(path, 0o600); }
  else await writeFile(path, "", { flag: "wx", mode: 0o600 });
  await writeFile(`${path}.writer-lock`, "", { flag: "wx", mode: 0o600 }); return path;
}
export async function nativeOwner(path: string) {
  let lease: Awaited<ReturnType<typeof acquireLinuxWriterLease>> | undefined;
  let native: DatabaseSync | undefined, database: ReturnType<typeof createSqliteCapability> | undefined;
  let setup: Promise<unknown> | undefined;
  let nativeAttempted = false, nativeConstructionFailed = false, nativeConstructionFailure: unknown;
  const close = retain(async () => {
    if (setup) { try { await setup; } catch { /* The exact original acquisition settled. */ } }
    if (lease) await lease.stopAdmissionAndDrain();
    if (nativeAttempted && !native) {
      if (nativeConstructionFailed) throw nativeConstructionFailure;
      throw new Error("Original native constructor custody is unproven");
    }
    if (database) database.close(); else if (native?.isOpen) native.close();
    if (native?.isOpen) throw new Error("Original native close is unproven");
    if (lease) await lease.release();
  });
  const operation = (async () => {
    lease = await acquireLinuxWriterLease({ databasePath: path, filesystemRootOwnerUid: rootOwnerUid });
    nativeAttempted = true;
    try { native = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { nativeConstructionFailed = true; nativeConstructionFailure = error; throw error; }
    database = createSqliteCapability(native); lease.bind(database, native);
    return { path, native, database, lease, close };
  })(); setup = operation;
  try { return await operation; }
  catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Native setup and custody failed"); } throw error; }
}
export async function inspect<T>(path: string, read: (native: DatabaseSync) => T) {
  const f = await nativeOwner(path);
  let workFailed = false, workError: unknown;
  try { return await f.lease.withWriter(() => { admitInstallationRecoverySource(f.native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE); return read(f.native); }); }
  catch (error) { workFailed = true; workError = error; throw error; }
  finally {
    try { await f.close(); } // The same first close still precedes physical release.
    catch (closeError) {
      if (workFailed) throw new AggregateError([workError, closeError], "Logical Sample inspection and original close failed");
      throw closeError;
    }
  }
}
type WithoutOperatorPaths<T> = T extends unknown ? Omit<T, "databasePath" | "filesystemRootOwnerUid"> : never;
export const operator = (path: string, selected: WithoutOperatorPaths<CollaborationOperatorV28Command>) =>
  executeCollaborationV28OperatorCandidate({ ...selected, databasePath: path, filesystemRootOwnerUid: rootOwnerUid } as CollaborationOperatorV28Command);
export const provision = (path: string, username: string, secret = password) => executeV28OrdinaryAccountOperatorCandidate({
  kind: "provision-account", databasePath: path, filesystemRootOwnerUid: rootOwnerUid, username,
}, secret);
export function child(path: string, sql: string, ...bindings: SQLInputValue[]) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {DatabaseSync} from 'node:sqlite'; let db;
    try { db=new DatabaseSync(process.argv[1],{allowExtension:false,enableForeignKeyConstraints:true}); db.exec('PRAGMA busy_timeout=20');
      const r=db.prepare(process.argv[2]).run(...JSON.parse(process.argv[3]));process.stdout.write(String(r.changes)); }
    catch(e){if(e.errcode===5)process.stdout.write('busy');else throw e;}
    finally{if(db?.isOpen)db.close();}
  `, path, sql, JSON.stringify(bindings)], { encoding: "utf8", timeout: 3000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); return result.stdout;
}
export function counts(native: DatabaseSync) {
  return Object.fromEntries(["samples", "events", "collaboration_members", "collaboration_identities", "collaboration_resources", "collaboration_grants"]
    .map(table => [table, native.prepare(`SELECT count(*) n FROM ${table}`).get()!.n]));
}
async function configuredPort() {
  const reservation = createServer(); let pending: Promise<unknown> | undefined;
  const close = retain(async () => { if (pending) { try { await pending; } catch { /* Original listen settled. */ } }
    if (reservation.listening) await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve())); });
  const operation = (async () => { reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const address = reservation.address(); if (!address || typeof address === "string") throw new Error("Numeric listener missing"); return address.port; })();
  pending = operation; try { return await operation; } finally { await close(); }
}
export async function host(path: string, hasher: PasswordHasher = createPasswordHasher()) {
  let lease: Awaited<ReturnType<typeof acquireLinuxWriterLease>> | undefined, native: DatabaseSync | undefined;
  let database: ReturnType<typeof createSqliteCapability> | undefined, candidate: Awaited<ReturnType<typeof createSampleOnlyV28HostCandidate>> | undefined;
  let setup: Promise<unknown> | undefined, constructionStarted = false, setupFailure: unknown;
  const close = retain(async () => {
    if (setup) { try { await setup; } catch (error) { setupFailure = error; } }
    if (candidate) { await candidate.close(); return; }
    if (constructionStarted) throw setupFailure ?? new Error("Original host constructor custody is unproven");
    if (lease) await lease.stopAdmissionAndDrain();
    if (database) database.close(); else if (native?.isOpen) native.close();
    if (native?.isOpen) throw new Error("Pre-construction native close is unproven");
    if (lease) await lease.release();
  });
  const operation = (async () => {
    const port = await configuredPort(), origin = `http://127.0.0.1:${port}`;
    lease = await acquireLinuxWriterLease({ databasePath: path, filesystemRootOwnerUid: rootOwnerUid });
    native = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true });
    database = createSqliteCapability(native); lease.bind(database, native);
    const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
    constructionStarted = true;
    candidate = await createSampleOnlyV28HostCandidate({ database, nativeDatabase: native, writerLease: lease, admission, hasher, identityPolicy: policy, publicOrigin: origin });
    candidate.server.listen(port, "127.0.0.1"); await once(candidate.server, "listening");
    return { path, origin, native, database, lease, candidate, close,
      async request(route: string, method = "GET", value?: unknown, session?: { cookie: string; csrf: string }) {
        const response = await fetch(origin + route, { method, headers: {
          ...(session ? { cookie: session.cookie } : {}), ...(method === "GET" ? {} : { origin, "content-type": "application/json", ...(session ? { "x-sfw-csrf": session.csrf } : {}) }),
        }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(5000) });
        const text = await response.text(); return { status: response.status, text, headers: response.headers, value: text ? JSON.parse(text) as Record<string, unknown> : null };
      },
    };
  })(); setup = operation;
  try { return await operation; }
  catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Host setup and custody failed"); } throw error; }
}
export type Host = Awaited<ReturnType<typeof host>>;
export async function login(f: Host, username: string) {
  const result = await f.request("/api/auth/login", "POST", { username, password }); expect(result.status).toBe(200);
  expect(result.value !== null && Object.hasOwn(result.value, "token")).toBe(false); const cookie = result.headers.get("set-cookie");
  expect(cookie?.includes("HttpOnly")).toBe(true); expect(cookie?.includes("SameSite=Strict")).toBe(true);
  const csrf = result.value?.csrf; expect(typeof csrf).toBe("string");
  return { cookie: cookie!.split(";")[0]!, csrf: csrf as string };
}
export async function enroll(path: string) {
  const alice = await operator(path, { kind: "enroll-local-member", principalId: aliceId, displayName: "Alice", workspaceRole: "membershipAdministrator", canCreateSamples: true, expectedControlRevision: 1 });
  const bob = await operator(path, { kind: "enroll-local-member", principalId: bobId, displayName: "Bob", workspaceRole: "member", canCreateSamples: false, expectedControlRevision: 1 });
  await operator(path, { kind: "enroll-local-member", principalId: adminId, displayName: "System operator", workspaceRole: "member", canCreateSamples: false, expectedControlRevision: 1 });
  await operator(path, { kind: "allocate-sample-root", principalId: aliceId, sampleId: "reference-sample-a", visibility: "restricted", expectedControlRevision: 1 });
  await operator(path, { kind: "allocate-sample-root", principalId: bobId, sampleId: "reference-sample-b", visibility: "restricted", expectedControlRevision: 1 });
  const enabled = await operator(path, { kind: "set-enforcement", enforcement: "enabled", expectedControlRevision: 1 });
  expect(enabled.controlRevision).toBe(2); return { alice: alice.memberId!, bob: bob.memberId! };
}


export async function configureLogicalFixture() {
  const pin = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID;
  if (!pin || !/^(0|[1-9][0-9]*)$/.test(pin) || !Number.isSafeInteger(Number(pin)) || Number(pin) > 0xffff_ffff) throw new Error("Configure explicit fixture root owner");
  rootOwnerUid = Number(pin); expect((await lstat("/", { bigint: true })).uid).toBe(BigInt(rootOwnerUid));
}
export function setFixtureIdentityReferences(value: { administrator: string; alice: string; bob: string }) {
  adminId = value.administrator; aliceId = value.alice; bobId = value.bob;
}
export { createInstalledLocalIdentity, createPasswordHasher, createSampleOnlyV28HostCandidate, SAMPLE_ONLY_V28_ROUTES,
  V26_NODE_INSTALLATION_CATALOG, V27_INERT_NODE_INSTALLATION_CATALOG_CANDIDATE, V28_NODE_INSTALLATION_CATALOG_CANDIDATE,
  admitInstallationRecoverySource, installReviewedSqliteCatalog, parseV28OrdinaryAccountOperatorCommand, v28OrdinaryAccountOperatorProcessState,
  acquireLinuxWriterLease, writeSync };
export type { PasswordHasher };
