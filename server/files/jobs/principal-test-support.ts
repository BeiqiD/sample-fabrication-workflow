import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from "../../operational-installation-catalog";
import { admitInstallationRecoverySource, installReviewedSqliteCatalog } from "../../migrations";
import { createSqliteCapability, asJobSqlDatabase } from "../../sqlite";
import { shutdownQuiescedSqliteDatabase } from "../../sqlite-backup";
import { acquireLinuxWriterLease } from "../../operations/writer-lease";
import { SqlFileJobRepository } from "../../../worker/files/jobs/sql-repository";
import { createInstalledJobPrincipalAuthority } from "./principal-authority";
import { createOwnedNodeFileJobPort } from "./repository";

export const principalId = "local_10000000-0000-4000-8000-000000000001";
export const otherId = "local_20000000-0000-4000-8000-000000000002";
export const actor = `local-account:${principalId}`, otherActor = `local-account:${otherId}`;
export const incarnation = "actual-node-job-principal-fixture";
export const bytes = new TextEncoder().encode("actual original write 验证");
const sha = createHash("sha256").update(bytes).digest("hex");
function captureFixtureFilesystem() {
  if (process.platform !== "linux" || typeof process.geteuid !== "function") throw new Error("Job fixture Linux filesystem is unavailable");
  const owner = BigInt(process.geteuid()), root = lstatSync("/", { bigint: true });
  const filesystemRootOwnerUid = Number(root.uid), rootOwnerInput = process.env.NODE_JOB_PRINCIPAL_FILESYSTEM_ROOT_OWNER_UID;
  if (!Number.isSafeInteger(filesystemRootOwnerUid) || filesystemRootOwnerUid < 0 || filesystemRootOwnerUid > 0xffff_ffff
    || rootOwnerInput !== undefined && (!/^(0|[1-9][0-9]*)$/.test(rootOwnerInput) || Number(rootOwnerInput) !== filesystemRootOwnerUid)) {
    throw new Error("Job fixture root owner differs from the actual filesystem");
  }
  const suppliedParent = process.env.NODE_JOB_PRINCIPAL_FIXTURE_PARENT, parent = suppliedParent ?? process.cwd();
  if (!parent || parent.length > 4000 || parent.includes("\0") || !isAbsolute(parent) || resolve(parent) !== parent
    || realpathSync(parent) !== parent) throw new Error("Job fixture parent is not a canonical existing directory");
  const directories: { path: string; stat: BigIntStats }[] = [];
  for (let path = parent; ; path = dirname(path)) {
    const stat = lstatSync(path, { bigint: true }), atRoot = dirname(path) === path;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n
      || atRoot && (stat.dev !== root.dev || stat.ino !== root.ino || stat.gid !== root.gid || stat.mode !== root.mode)
      || (atRoot ? stat.uid !== root.uid : stat.uid !== owner && stat.uid !== 0n)
      || path === parent && (stat.uid !== owner || suppliedParent !== undefined && (stat.mode & 0o7777n) !== 0o700n)) {
      throw new Error("Job fixture parent ancestry is not privately owned");
    }
    directories.push({ path, stat }); if (atRoot) break;
  }
  const assertCurrent = () => {
    if (realpathSync(parent) !== parent) throw new Error("Job fixture parent changed");
    for (const { path, stat: before } of directories) {
      const current = lstatSync(path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || current.uid !== before.uid || current.gid !== before.gid || current.mode !== before.mode) {
        throw new Error("Job fixture parent or root ownership changed");
      }
    }
  };
  return Object.freeze({ parent, filesystemRootOwnerUid, assertCurrent });
}
type PrincipalTemplate = Readonly<{ directory: string; template: string; filesystemRootOwnerUid: number;
  assertFilesystem(): void; close(): Promise<void> }>;
type CloseOwner = () => Promise<void>;
interface NativeClose { run(): void; acknowledged(): boolean }
interface TemplateOwner { setup?: Promise<PrincipalTemplate>; directory?: string; native?: DatabaseSync;
  core?: ReturnType<typeof createSqliteCapability>; closeNative?: NativeClose; sealed: boolean;
  children: Set<CloseOwner>; close?: CloseOwner; nativeConstructionAttempted?: true; setupFailure?: unknown }
const templateOwners = new Set<TemplateOwner>();
const ownerClosures = new Set<CloseOwner>();
const retainedFailedOwners = new Set<CloseOwner>();
const operationOwners = new AsyncLocalStorage<Set<CloseOwner>>();
let admissionStopped = false, draining: Promise<void> | undefined;

/** Keep the actual native object and original first close result, including a
 * close-then-throw. A later isOpen=false never replaces its missing ACK. */
function cacheNativeClose(native: DatabaseSync, beforeClose?: () => void): NativeClose {
  const original = native.close.bind(native); let attempted = false, failed = false, error: unknown;
  const close = () => {
    if (attempted) { if (failed) throw error; return; }
    attempted = true;
    try { beforeClose?.(); original(); }
    catch (reason) { failed = true; error = reason; throw reason; }
  };
  native.close = close; // All actual caller/native/core paths share this one ACK.
  return { run: close, acknowledged: () => attempted && !failed };
}
function retainClose(close: CloseOwner) {
  const scope = operationOwners.getStore();
  if (scope) scope.add(close); else ownerClosures.add(close);
}
/** Register the whole original beforeAll/case before the first filesystem or
 * acquire continuation. Inner owners are registered only in that ALS scope. */
export function retainOriginalPrincipalOperation<T>(run: () => Promise<T>): Promise<T> {
  if (admissionStopped) throw new Error("Original Job fixture admission is stopped");
  const owners = new Set<CloseOwner>(); let original: Promise<T> | undefined, closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    if (original) await original.then(() => undefined, () => undefined);
    for (const child of [...owners].reverse()) {
      try { await child(); owners.delete(child); }
      catch (error) { retainedFailedOwners.add(child); throw error; }
    }
    ownerClosures.delete(close); retainedFailedOwners.delete(close);
  })();
  // Waiting for original work is separate from closing children: explicit
  // fixture.close() inside its own case must never wait for that same case.
  const settle = () => original?.then(() => undefined, () => undefined) ?? Promise.resolve();
  originalOperations.set(close, settle); ownerClosures.add(close);
  original = operationOwners.run(owners, async () => run());
  return original;
}
const originalOperations = new Map<CloseOwner, () => Promise<void>>();
export async function settleOriginalPrincipalOperations(): Promise<void> {
  admissionStopped = true;
  for (const settle of originalOperations.values()) await settle();
}
export function drainOriginalPrincipalOwners(): Promise<void> {
  if (draining) return draining;
  const original = (async () => {
    await settleOriginalPrincipalOperations();
    for (const close of [...ownerClosures].reverse()) {
      try { await close(); originalOperations.delete(close); }
      catch (error) { retainedFailedOwners.add(close); throw error; }
    }
    if (retainedFailedOwners.size) throw new Error("Original Job fixture owners remain retained");
    admissionStopped = false;
  })();
  draining = original;
  void original.then(() => { if (draining === original) draining = undefined; }, () => {
    // Preserve the first rejected drain and every exact failed owner; no retry.
  });
  return original;
}
export async function closePrincipalTemplates(): Promise<void> {
  await settleOriginalPrincipalOperations();
  for (const owner of templateOwners) await owner.close!();
}
export function createPrincipalTemplate(): Promise<PrincipalTemplate> {
  const owner: TemplateOwner = { sealed: false, children: new Set() }; templateOwners.add(owner);
  let closing: Promise<void> | undefined;
  owner.close = (): Promise<void> => closing ??= (async () => {
    owner.sealed = true;
    if (owner.setup) await owner.setup.then(() => undefined, error => { owner.setupFailure = error; });
    if (owner.nativeConstructionAttempted && !owner.native) throw owner.setupFailure;
    for (const close of [...owner.children].reverse()) await close();
    owner.core?.close(); owner.closeNative?.run();
    if (owner.native && !owner.closeNative?.acknowledged()) throw new Error("Original Job template native close is unproven");
    if (owner.directory) await rm(owner.directory, { recursive: true, force: true });
    templateOwners.delete(owner);
  })();
  const originalSetup = (async (): Promise<PrincipalTemplate> => {
    // Default to one new private leaf in the actual checkout. An explicit parent
    // must already be private700; this helper never provisions system directories.
    const filesystem = captureFixtureFilesystem(); filesystem.assertCurrent();
    const directory = owner.directory = await mkdtemp(join(filesystem.parent, ".private-fixtures-job-principal-")); await chmod(directory, 0o700);
    filesystem.assertCurrent();
    const template = join(directory, "closed-operational-v26.sqlite");
    owner.nativeConstructionAttempted = true;
    const native = owner.native = new DatabaseSync(template, { enableForeignKeyConstraints: true, allowExtension: false });
    owner.closeNative = cacheNativeClose(native);
    await chmod(template, 0o600); const core = owner.core = createSqliteCapability(native);
    let workFailed = false, workFailure: unknown;
    try { installReviewedSqliteCatalog(native, OPERATIONAL_NODE_INSTALLATION_CATALOG); shutdownQuiescedSqliteDatabase(native); }
    catch (error) { workFailed = true; workFailure = error; throw error; }
    finally {
      try { core.close(); }
      catch (error) {
        if (workFailed) throw new AggregateError([workFailure, error], "Original Job template setup and first native close failed");
        throw error;
      }
    }
    // A successful core close cannot erase an earlier native close rejection.
    owner.closeNative.run();
    const result: PrincipalTemplate = Object.freeze({ directory, template, filesystemRootOwnerUid: filesystem.filesystemRootOwnerUid,
      assertFilesystem: filesystem.assertCurrent, close: owner.close! });
    templateRegistrations.set(result, owner); return result;
  })();
  owner.setup = originalSetup; return originalSetup;
}
const templateRegistrations = new WeakMap<PrincipalTemplate, TemplateOwner>();
export function principalFixture(template: PrincipalTemplate) {
  const parent = templateRegistrations.get(template);
  if (!parent || parent.sealed) throw new Error("Original Job template is unavailable or closing");
  const owner: { setup?: Promise<unknown>; directory?: string; lease?: Awaited<ReturnType<typeof acquireLinuxWriterLease>>;
    native?: DatabaseSync; core?: ReturnType<typeof createSqliteCapability>; authority?: ReturnType<typeof createInstalledJobPrincipalAuthority>;
    closePrimary?: NativeClose; children: Set<NativeClose>; sealed: boolean;
    originalAcquire?: ReturnType<typeof acquireLinuxWriterLease>; nativeConstructionAttempted?: true; setupFailure?: unknown } = { sealed: false, children: new Set() };
  let closing: Promise<void> | undefined;
  const closeChildren = () => { owner.sealed = true; for (const child of owner.children) child.run(); };
  const close = (): Promise<void> => closing ??= (async () => {
    owner.sealed = true;
    if (owner.setup) await owner.setup.then(() => undefined, error => { owner.setupFailure = error; });
    // Preserve the exact acquisition/constructor rejection. No absent handle or
    // isOpen observation proves cleanup of an attempt that never returned.
    if (owner.originalAcquire) owner.lease = await owner.originalAcquire;
    if (owner.nativeConstructionAttempted && !owner.native) throw owner.setupFailure;
    // An actual Host may already have completed its first native/lease close.
    // Only its original successful native close ACK avoids a second drain call;
    // open/closed observations never discharge a rejected close.
    if (owner.lease && !owner.closePrimary?.acknowledged()) await owner.lease.stopAdmissionAndDrain();
    closeChildren(); owner.authority?.close(); owner.core?.close(); owner.closePrimary?.run();
    if (owner.native && !owner.closePrimary?.acknowledged()) throw new Error("Original Job fixture native close is unproven");
    if (owner.lease) await owner.lease.release();
    if (owner.directory) await rm(owner.directory, { recursive: true, force: true });
    parent.children.delete(close); ownerClosures.delete(close); retainedFailedOwners.delete(close);
  })();
  // Strong slots and cached cleanup exist before filesystem work/acquire/bind.
  parent.children.add(close); retainClose(close);
  const originalSetup = (async () => {
    template.assertFilesystem(); const { filesystemRootOwnerUid } = template;
    if ((await lstat("/", { bigint: true })).uid !== BigInt(filesystemRootOwnerUid)) throw new Error("Job fixture root owner changed");
    const directory = owner.directory = await mkdtemp(join(template.directory, "case-")); await chmod(directory, 0o700);
    const path = join(directory, "application.sqlite"); await copyFile(template.template, path); await chmod(path, 0o600);
    await writeFile(`${path}.writer-lock`, "", { flag: "wx", mode: 0o600 });
    owner.originalAcquire = acquireLinuxWriterLease({ databasePath: path, filesystemRootOwnerUid });
    const lease = owner.lease = await owner.originalAcquire;
    owner.nativeConstructionAttempted = true;
    const native = owner.native = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
    owner.closePrimary = cacheNativeClose(native, closeChildren);
    const core = owner.core = createSqliteCapability(native); lease.bind(core, native);
    // Construct a migration-seeded historical File/job state, NOT a claim that
    // Node File-authority activation or provider composition exists. Exact
    // production guards are all restored before admission or tested operations.
    const triggers = native.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all().map(row => {
      if (typeof row.name !== "string" || typeof row.sql !== "string") throw new Error("Stored fixture DDL is unavailable");
      return { name: row.name, sql: row.sql };
    });
    native.exec("BEGIN IMMEDIATE");
    try {
      for (const t of triggers) native.exec(`DROP TRIGGER "${t.name.replaceAll('"', '""')}"`);
      const at = new Date().toISOString();
      for (const [id, name] of [[principalId, "migration.operator"], [otherId, "cleanup.operator"]] as const) {
        native.prepare("INSERT INTO local_accounts VALUES(?,?,?,1,1,0)").run(id, name, "opaque protected fixture verifier");
        native.prepare("INSERT INTO local_admin_grants VALUES(?,0)").run(id);
      }
      native.prepare("INSERT INTO local_identity_installation VALUES(1,?,'local-identity-v1',0)").run(principalId);
      native.prepare("UPDATE file_authority_control SET mode='active',activated_at=?,updated_at=?").run(at, at);
      native.prepare("UPDATE file_authority_runtime_guard SET incarnation='fixture-file-authority',enabled=1,enabled_by='fixture',updated_at=?").run(at);
      native.prepare("UPDATE file_job_runtime_guard SET enabled=1,incarnation=?").run(incarnation);
      for (const profile of ["source", "target"]) {
        native.prepare(`INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
          VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)`).run(profile,
          JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: `principal-fixture-${profile}` }), at);
        native.prepare("INSERT INTO storage_profile_runtime VALUES(?,'read_write',?,?,NULL)").run(profile, at, at);
      }
      native.prepare(`INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
        VALUES('file','embedded_content','system',?,?,'unresolved',?)`).run(bytes.length, sha, at);
      native.prepare(`INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
        VALUES('source-location','file','source','original/source','unresolved',?)`).run(at);
      native.prepare("INSERT INTO file_location_publications VALUES('source-location','file','source','original/source',?,?,'full_read_sha256','historical-fixture',?,?)").run(bytes.length, sha, at, at);
      native.prepare("INSERT INTO file_publications VALUES('file','embedded_content','system',?,?,'source-location','ready',?,NULL)").run(bytes.length, sha, at);
      for (const t of triggers) native.exec(t.sql);
      native.exec("COMMIT");
    } catch (error) { native.exec("ROLLBACK"); throw error; }
    const admission = admitInstallationRecoverySource(native, OPERATIONAL_NODE_INSTALLATION_CATALOG);
    const authority = owner.authority = createInstalledJobPrincipalAuthority({ database: core, nativeDatabase: native, admission, writerLease: lease });
    const port = createOwnedNodeFileJobPort({ authority, incarnation });
    // This direct trusted fixture repository persists accepted history. It is
    // not a Node HTTP handler; port.accept/control/requestCleanup stay CLOSED.
    const original = new SqlFileJobRepository(asJobSqlDatabase(core), () => new Date(), randomUUID);
    if (owner.sealed) throw new Error("Original Job fixture secondary admission is stopped");
    const child: { native?: DatabaseSync; closeNative?: NativeClose; constructionFailure?: unknown } = {};
    const childClose: NativeClose = { run: () => {
      if (!child.closeNative) throw child.constructionFailure;
      child.closeNative.run();
    }, acknowledged: () => child.closeNative?.acknowledged() ?? false };
    owner.children.add(childClose); // Capture before the actual secondary constructor.
    let second: DatabaseSync;
    try {
      second = child.native = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
      child.closeNative = cacheNativeClose(second);
    } catch (error) { child.constructionFailure = error; throw error; }
    second.exec("PRAGMA busy_timeout=0");
    return { path, directory, filesystemRootOwnerUid, native, core, second, lease, authority, admission, port, original,
      input: { requestId: randomUUID(), fileIds: ["file"], target: { profileId: "target", configurationRevision: 1 } }, close,
    };
  })();
  owner.setup = originalSetup; return originalSetup;
}
/** A reopened inspection after the original Host's acknowledged release is a
 * separate actual Native owner, retained before construction and first close. */
export function openPrincipalFixtureInspection(path: string): DatabaseSync {
  const owner: { native?: DatabaseSync; closeNative?: NativeClose; constructionAttempted?: true; constructionFailure?: unknown } = {};
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    if (owner.constructionAttempted && !owner.native) throw owner.constructionFailure;
    owner.closeNative?.run();
    if (owner.native && !owner.closeNative?.acknowledged()) throw new Error("Original reopened Job inspection native close is unproven");
    ownerClosures.delete(close); retainedFailedOwners.delete(close);
  })();
  retainClose(close);
  owner.constructionAttempted = true;
  try {
    const native = owner.native = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
    owner.closeNative = cacheNativeClose(native); return native;
  } catch (error) { owner.constructionFailure = error; throw error; }
}
export async function staged(f: Awaited<ReturnType<typeof principalFixture>>) {
  const job = await f.original.accept(f.input, actor, () => f.authority.authorizeAdministrator(actor));
  const claim = await f.port.repository.claim(incarnation, randomUUID(), f.port.authorizeAdministrator);
  if (!claim) throw new Error("Actual accepted fixture claim is unavailable");
  const item = await f.port.repository.nextItem(claim); if (!item) throw new Error("Actual frozen fixture selection is unavailable");
  const attempt = await f.port.repository.stage(claim, item); await f.port.repository.startWrite(claim, attempt);
  return { job, claim, item, attempt };
}
