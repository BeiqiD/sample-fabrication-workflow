import type { DatabaseSync } from "node:sqlite";
import type { OfflineWriterFence } from "../auth/identity";
import { localUploadV28PreparationOwner, type LocalUploadExecution } from "../files/local-upload-execution";
import type { ByteReadResult } from "../../worker/files/byte-reader";
import type { ByteWriteInput } from "../../worker/files/byte-writer";
import { ByteVerificationError } from "../../worker/files/byte-verification.ts";
import { StorageProfileCleanupError, type FileByteOperation, type OpenedStorageProfile, type RegisteredStorageProfile,
  type StorageProfileOpeningCapabilities } from "../../worker/files/storage-profile-opening.ts";
import { createLocalProfileRegistration } from "../../worker/storage/local-profile-registration.ts";
import { assertInstallationAdmission, type ReviewedInstallationAdmission, type ReviewedInstallationCatalog } from "../migrations.ts";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http.ts";
import { captureInstalledIdentityExecutionOwnerV28Candidate, createInstalledIdentityExecutionGuardGroupV28Candidate,
  type InstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate.ts";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease.ts";
import { asJobSqlDatabase, type SqliteBatchAdmission, type SqliteCapability, type SqliteStatement } from "../sqlite.ts";
import { asAdmittedFileAuthoritySqlDatabase, asFileAuthoritySqlDatabase, asLocalUploadV28FileAuthoritySqlDatabase, assertNativeFileAuthoritySqlOwner,
  type NativeFileAuthoritySqlDatabase } from "../file-authority-sql.ts";
import type { FileAuthoritySqlStatement } from "../../worker/runtime/file-authority-sql";
import { createOwnedLocalProfileRegistrationSql } from "./local-profile-registration-sql.ts";
import { captureLocalVolumeDescriptor, type CapturedLocalVolumeDescriptor, type TrustedLocalVolumeDescriptor } from "./local-volume-descriptor.ts";
import { openLocalByteStorage, type LocalByteStorage } from "./local-byte-storage.ts";
import { nodeSha256 } from "./node-sha256.ts";
import { LOCAL_VOLUME_PROFILE_SOURCE_COLUMNS, LOCAL_VOLUME_PROFILE_SOURCE_SQL, localVolumeProfileSourceBindings,
  readLocalVolumeProfileSource, type LocalVolumeProfileSource } from "./local-volume-profile-source.ts";

export interface LocalVolumeProfileOwnerOptions {
  readonly database: SqliteCapability;
  readonly nativeDatabase: DatabaseSync;
  readonly admission: ReviewedInstallationAdmission;
  readonly writerLease: LinuxWriterLease;
  readonly filesystemRootOwnerUid: number;
  readonly descriptors: readonly TrustedLocalVolumeDescriptor[];
  /** Current request/session authority supplied by the actual local auth owner.
   * A true result is additionally checked against current SQL admin grants. */
  authorizeAdministrator(actor: string): boolean | Promise<boolean>;
}
export interface LocalVolumeProfileOpening {
  readonly capabilities: StorageProfileOpeningCapabilities<"local">;
  register(raw: unknown, actor: string): ReturnType<ReturnType<typeof createLocalProfileRegistration>["registerLocalProfile"]>;
  close(): Promise<void>;
}
/** Internal shared lifecycle context, issued only with a genuine lease/native/
 * admission tuple. Routes cannot construct it from namespace or JSON rows. */
export interface LocalVolumeProfileOwner {
  readonly database: SqliteCapability;
  readonly nativeDatabase: DatabaseSync;
  readonly writerLease: LinuxWriterLease;
  readonly installationId: string;
  readonly installationCheckpointId: string;
  descriptor(id: string): Readonly<CapturedLocalVolumeDescriptor>;
  assertCurrent(): void;
  assertAdministrator(actor: string): void;
  authorizeAdministrator(actor: string): Promise<void>;
  captureProfileAuthority(profile: Readonly<{ profileId: string; configurationRevision: number }>, access: "read" | "write"): LocalVolumeProfileAuthority;
}
/** Immutable metadata carried by an in-process issued snapshot. A copied
 * descriptor or imported history cannot satisfy the private ownership map. */
export interface LocalVolumeProfileAuthority {
  readonly profile: RegisteredStorageProfile;
  readonly access: "read" | "write";
}
interface ProfileAuthorityOwner {
  readonly owner: LocalVolumeProfileOwner;
  readonly descriptor: CapturedLocalVolumeDescriptor;
  readonly profile: RegisteredStorageProfile;
  readonly access: "read" | "write";
  readonly captured: LocalVolumeProfileSource;
  assertCurrent(): void;
}
const profileAuthorities = new WeakMap<LocalVolumeProfileAuthority, ProfileAuthorityOwner>();
const authorityDatabases = new WeakMap<NativeFileAuthoritySqlDatabase, ReadonlySet<LocalVolumeProfileAuthority>>();
const owners = new WeakMap<LocalVolumeProfileOpening, LocalVolumeProfileOwner>();
const physicalAssertions = new WeakMap<LocalVolumeProfileOpening, () => void>();
const preparationAssertions = new WeakMap<LocalVolumeProfileOpening, () => void>();
declare const v28FileScopeBrand: unique symbol;
export interface LocalUploadV28FileAuthorityScope { readonly [v28FileScopeBrand]: true }
const v28FileScopes = new WeakMap<LocalUploadV28FileAuthorityScope, Readonly<{
  opening: LocalVolumeProfileOpening; execution: LocalUploadExecution;
  database: SqliteCapability; fullFence: OfflineWriterFence;
  preparation: ReturnType<typeof localUploadV28PreparationOwner>;
}>>();
/** Only this concrete factory mints the opaque scope. Generic views and views
 * from another execution can never acquire or rebind preparation eligibility. */
export function createAdmittedLocalUploadV28FileAuthorityDatabase(opening: LocalVolumeProfileOpening,
  authorities: readonly LocalVolumeProfileAuthority[] | undefined, admission: SqliteBatchAdmission,
  execution: LocalUploadExecution): NativeFileAuthoritySqlDatabase {
  const owner = ownedLocalVolumeProfileContext(opening), preparation = localUploadV28PreparationOwner(execution, opening);
  if (!preparation.matchesCore(owner.database)) unavailable();
  let selected: Set<LocalVolumeProfileAuthority> | undefined;
  let fullFence: OfflineWriterFence = preparation.fullFence;
  if (authorities !== undefined) {
    if (!Array.isArray(authorities) || !authorities.length || authorities.length > MAX_VOLUME_DESCRIPTORS) unavailable();
    selected = new Set(authorities);
    const records = [...selected].map(authority => {
      const record = profileAuthority(authority); if (record.owner !== owner) unavailable(); return record;
    });
    fullFence = Object.freeze({ assertHeld() {
      owner.assertCurrent(); for (const record of records) record.assertCurrent();
      return preparation.fullFence.assertHeld();
    } });
  }
  const scope = Object.freeze({}) as LocalUploadV28FileAuthorityScope;
  v28FileScopes.set(scope, Object.freeze({ opening, execution, database: owner.database, fullFence, preparation }));
  const view = asLocalUploadV28FileAuthoritySqlDatabase(scope, execution, opening, admission);
  if (selected) authorityDatabases.set(view, selected); return view;
}
/** Exact private issuance accessor; no raw scope, callback bag, generic view or
 * replacement execution can stand in for the originally captured frame. */
export function ownedLocalUploadV28FileAuthorityScope(scope: LocalUploadV28FileAuthorityScope,
  execution: LocalUploadExecution, opening: LocalVolumeProfileOpening) {
  const original = v28FileScopes.get(scope);
  if (!original || original.execution !== execution || original.opening !== opening) unavailable();
  original.preparation.assertHeld(); return original;
}
interface V28IdentityOwner {
  readonly owner: LocalVolumeProfileOwner;
  readonly authentication: object;
  readonly auth: ReturnType<typeof localAuthenticationIdentityAuthority>;
  readonly admission: ReviewedInstallationAdmission;
  readonly identity: Readonly<InstalledIdentityExecutionOwnerV28Candidate>;
}
const v28IdentityOwners = new WeakMap<LocalVolumeProfileOpening, Readonly<V28IdentityOwner>>();
function unavailable(): never { throw new Error("Local volume profile is unavailable"); }
const MAX_OPEN_ADAPTERS = 32;
const MAX_VOLUME_DESCRIPTORS = 32;
type Source = LocalVolumeProfileSource;
interface RecordOwner {
  disposed: boolean;
  bytes?: LocalByteStorage;
  pending: Set<Promise<unknown>>;
  cancel: Set<() => Promise<void>>;
  cleanupFailures: Set<unknown>;
  close?: Promise<void>;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function ownedLocalVolumeProfileContext(opening: LocalVolumeProfileOpening): LocalVolumeProfileOwner {
  const owner = owners.get(opening); if (!owner) unavailable(); return owner;
}
function profileAuthority(authority: LocalVolumeProfileAuthority): ProfileAuthorityOwner {
  const record = profileAuthorities.get(authority); if (!record) unavailable(); record.assertCurrent(); return record;
}
export function captureLocalVolumeProfileAuthority(opening: LocalVolumeProfileOpening,
  profile: Readonly<{ profileId: string; configurationRevision: number }>, access: "read" | "write"): LocalVolumeProfileAuthority {
  return ownedLocalVolumeProfileContext(opening).captureProfileAuthority(profile, access);
}
/** The one actual native mixed-batch view carries all captured physical pins
 * through its synchronous assertion immediately before BEGIN IMMEDIATE. */
export function createLocalVolumeFileAuthorityDatabase(opening: LocalVolumeProfileOpening,
  authorities: readonly LocalVolumeProfileAuthority[]): NativeFileAuthoritySqlDatabase {
  return localVolumeFileAuthorityDatabase(opening, authorities);
}
/** Request-bound issued admission is additional to all original local source
 * and physical pins; imported metadata or a token alone cannot select bytes. */
export function createAdmittedLocalVolumeFileAuthorityDatabase(opening: LocalVolumeProfileOpening,
  authorities: readonly LocalVolumeProfileAuthority[], admission: SqliteBatchAdmission,
  executionLifetime?: OfflineWriterFence): NativeFileAuthoritySqlDatabase {
  return localVolumeFileAuthorityDatabase(opening, authorities, admission, executionLifetime);
}
function localVolumeFileAuthorityDatabase(opening: LocalVolumeProfileOpening,
  authorities: readonly LocalVolumeProfileAuthority[], admission?: SqliteBatchAdmission,
  executionLifetime?: OfflineWriterFence): NativeFileAuthoritySqlDatabase {
  const owner = ownedLocalVolumeProfileContext(opening);
  if (!Array.isArray(authorities) || !authorities.length || authorities.length > MAX_VOLUME_DESCRIPTORS) unavailable();
  const selected = new Set(authorities), records = [...selected].map(authority => {
    const record = profileAuthority(authority); if (record.owner !== owner) unavailable(); return record;
  });
  const assertExecutionHeld = executionLifetime?.assertHeld.bind(executionLifetime);
  const physical = { assertHeld() {
    owner.assertCurrent(); for (const record of records) record.assertCurrent();
    // An extra execution fence only denies a closed original lifetime. The
    // native view also rejects asynchronous assertions; no source/lease or
    // provider proof is replaced by this optional caller restriction.
    return assertExecutionHeld?.();
  } };
  const port = admission ? asAdmittedFileAuthoritySqlDatabase(owner.database, admission, physical)
    : asFileAuthoritySqlDatabase(owner.database, physical);
  authorityDatabases.set(port, selected); return port;
}
/** Reuse exactly the opening query and its entire selected tuple, in the same
 * native transaction as publication and its accepted business receipt. A valid
 * replacement binding cannot satisfy an earlier pre-I/O authority snapshot. */
export function prepareLocalVolumeProfileAuthorityFence(authority: LocalVolumeProfileAuthority,
  database: NativeFileAuthoritySqlDatabase): FileAuthoritySqlStatement {
  const record = profileAuthority(authority);
  if (!authorityDatabases.get(database)?.has(authority)) unavailable();
  assertNativeFileAuthoritySqlOwner(database, record.owner.database);
  return database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM (${LOCAL_VOLUME_PROFILE_SOURCE_SQL}) current
    WHERE ${LOCAL_VOLUME_PROFILE_SOURCE_COLUMNS.map(column => `current.${column} IS ?`).join(" AND ")})
    THEN 1 ELSE json('Captured local File authority changed') END`)
    .bind(...localVolumeProfileSourceBindings(record.owner.installationId, record.profile, record.descriptor, record.access),
      ...LOCAL_VOLUME_PROFILE_SOURCE_COLUMNS.map(column => record.captured[column]));
}

/** A background Job batch can fence the same privately issued profile tuple
 * on its exact original core. This admits no new provider, role or mutation;
 * the caller still owns separate installed Job and scheduled-source guards. */
export function prepareLocalVolumeProfileSqliteFence(authority: LocalVolumeProfileAuthority,
  database: SqliteCapability): SqliteStatement {
  const record = profileAuthority(authority);
  if (database !== record.owner.database) unavailable();
  return database.prepare(`SELECT 1 AS admitted FROM (${LOCAL_VOLUME_PROFILE_SOURCE_SQL}) current
    WHERE ${LOCAL_VOLUME_PROFILE_SOURCE_COLUMNS.map(column => `current.${column} IS ?`).join(" AND ")}`)
    .bind(...localVolumeProfileSourceBindings(record.owner.installationId, record.profile, record.descriptor, record.access),
      ...LOCAL_VOLUME_PROFILE_SOURCE_COLUMNS.map(column => record.captured[column]));
}

/** Actual Node composition only; registered metadata alone never opens bytes.
 * Catalog/schema stay immutable for this lifetime. Current installation sentinel,
 * exact primary binding/probe/activation rows and physical pins are rechecked
 * for each operation. Migration/recovery requires closing and a fresh owner. */
export function createLocalVolumeProfileOpening(options: LocalVolumeProfileOwnerOptions): LocalVolumeProfileOpening {
  return createCatalogLocalVolumeProfileOpening(options, V26_NODE_INSTALLATION_CATALOG, "portable-runtime/v26");
}
/** Trusted V28 composition only. Its actual installed identity and complete
 * code-owned V28 ledger owner are captured before any byte owner can issue.
 * It creates no member/root grant, activation, profile or provider receipt. */
export function createLocalVolumeProfileOpeningV28(options: LocalVolumeProfileOwnerOptions & { authentication: object }): LocalVolumeProfileOpening {
  if (Object.keys(options).sort().join(",") !== "admission,authentication,authorizeAdministrator,database,descriptors,filesystemRootOwnerUid,nativeDatabase,writerLease") unavailable();
  const { authentication, admission, database, nativeDatabase, writerLease } = options;
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identity = captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity, database, nativeDatabase, admission);
  const opening = createCatalogLocalVolumeProfileOpening(options, V28_NODE_INSTALLATION_CATALOG_CANDIDATE, "portable-runtime/v28", identity);
  const owner = ownedLocalVolumeProfileContext(opening);
  if (owner.database !== database || owner.nativeDatabase !== nativeDatabase || owner.writerLease !== writerLease
    || options.authentication !== authentication || options.admission !== admission) unavailable();
  v28IdentityOwners.set(opening, Object.freeze({ owner, authentication, auth, admission, identity }));
  return opening;
}
function v28IdentityOwner(opening: LocalVolumeProfileOpening, authentication: object,
  admission: ReviewedInstallationAdmission): Readonly<V28IdentityOwner> {
  const selected = v28IdentityOwners.get(opening), owner = ownedLocalVolumeProfileContext(opening);
  if (!selected || selected.owner !== owner || selected.authentication !== authentication
    || selected.auth !== localAuthenticationIdentityAuthority(authentication) || selected.admission !== admission
    || owner.installationCheckpointId !== "portable-runtime/v28") unavailable();
  return selected;
}
/** Consume only the actual opening-issued owner and its original auth/admission
 * tuple. A copied opening, different authentication or new admission cannot
 * substitute a remembered inspection success for this live capability. */
export function ownedLocalVolumeIdentityV28Candidate(opening: LocalVolumeProfileOpening,
  authentication: object, admission: ReviewedInstallationAdmission): Readonly<InstalledIdentityExecutionOwnerV28Candidate> {
  const selected = v28IdentityOwner(opening, authentication, admission);
  selected.owner.assertCurrent(); return selected.identity;
}
/** Pure statement construction only. This private opening/core/Native/lease
 * tuple cannot issue SQL or substitute for the full current execution proof. */
export function assertLocalVolumeIdentityPreparationV28Candidate(opening: LocalVolumeProfileOpening,
  authentication: object, admission: ReviewedInstallationAdmission): void {
  v28IdentityOwner(opening, authentication, admission);
  const preparation = preparationAssertions.get(opening); if (!preparation) unavailable(); preparation();
}
/** No caller callback enters this closed all-read guard. Actual opening state
 * and physical/native binding remain current, while equivalent registered
 * identity owners share one fresh original schema/ledger proof per invocation. */
export function createLocalVolumeIdentityGuardV28Candidate(opening: LocalVolumeProfileOpening,
  authentication: object, admission: ReviewedInstallationAdmission,
  issued: readonly InstalledIdentityExecutionOwnerV28Candidate[]): Readonly<{ assertCurrent(): void }> {
  const selected = v28IdentityOwner(opening, authentication, admission);
  const physical = physicalAssertions.get(opening); if (!physical) unavailable();
  const group = createInstalledIdentityExecutionGuardGroupV28Candidate([selected.identity, ...issued]);
  return Object.freeze({ assertCurrent() { physical(); group.assertCurrent(); } });
}
export function assertLocalVolumeProfileOpeningV28(opening: LocalVolumeProfileOpening): LocalVolumeProfileOwner {
  const owner = ownedLocalVolumeProfileContext(opening);
  if (owner.installationCheckpointId !== "portable-runtime/v28") unavailable();
  owner.assertCurrent(); return owner;
}
function createCatalogLocalVolumeProfileOpening(options: LocalVolumeProfileOwnerOptions,
  catalog: ReviewedInstallationCatalog, expectedCheckpoint: "portable-runtime/v26" | "portable-runtime/v28",
  installedIdentity?: Readonly<{ assertCurrent(): void }>): LocalVolumeProfileOpening {
  const { database, nativeDatabase, admission, writerLease, filesystemRootOwnerUid } = options;
  const authorize = options.authorizeAdministrator.bind(options);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const installation = assertInstallationAdmission(nativeDatabase, admission);
  const checkpoint = catalog.migrations.at(-1)?.checkpoint;
  if (!checkpoint || checkpoint.id !== expectedCheckpoint || installation.checkpointId !== checkpoint.id
    || installation.catalogId !== catalog.id || installation.schemaSha256 !== checkpoint.schemaSha256
    || installation.appliedMigrations !== catalog.migrations.length) unavailable();
  if (!Array.isArray(options.descriptors) || options.descriptors.length > MAX_VOLUME_DESCRIPTORS) unavailable();
  const descriptors = options.descriptors.map(raw => captureLocalVolumeDescriptor(raw, filesystemRootOwnerUid));
  const byId = new Map(descriptors.map(item => [item.id, item])), byProfile = new Map(descriptors.map(item => [item.profileId, item]));
  if (byId.size !== descriptors.length || byProfile.size !== descriptors.length) unavailable();
  let closed = false, closing: Promise<void> | undefined;
  const records = new Set<RecordOwner>();
  function assertPreparing() {
    if (closed) unavailable();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase); database.primary();
  }
  function assertPhysicalCurrent() {
    if (closed) unavailable();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    database.primary();
    const row = nativeDatabase.prepare("SELECT installation_id,catalog_id,schema_checkpoint,schema_sha256,created_at FROM node_installation WHERE singleton=1").get();
    if (!row || row.installation_id !== installation.installationId || row.catalog_id !== installation.catalogId
      || row.schema_checkpoint !== installation.checkpointId || row.schema_sha256 !== installation.schemaSha256
      || row.created_at !== installation.createdAt) unavailable();
  }
  function assertCurrent() {
    if (closed) unavailable();
    installedIdentity?.assertCurrent();
    assertPhysicalCurrent();
  }
  function assertAdministrator(actor: string) {
    assertCurrent();
    if (typeof actor !== "string" || !/^local-account:local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(actor)
      || !nativeDatabase.prepare("SELECT 1 FROM local_accounts a JOIN local_admin_grants g ON g.principal_id=a.principal_id WHERE a.principal_id=? AND a.enabled=1")
        .get(actor.slice("local-account:".length))) unavailable();
  }
  const owner: LocalVolumeProfileOwner = Object.freeze({ database, nativeDatabase, writerLease, installationId: installation.installationId,
    installationCheckpointId: installation.checkpointId,
    descriptor(id: string) { assertCurrent(); const value = byId.get(id); if (!value) unavailable(); value.assertCurrent(); return value; },
    assertCurrent, assertAdministrator,
    async authorizeAdministrator(actor: string) { assertAdministrator(actor); if (await authorize(actor) !== true) unavailable(); assertAdministrator(actor); },
    captureProfileAuthority(frozen: Readonly<{ profileId: string; configurationRevision: number }>, access: "read" | "write") {
      assertCurrent();
      if (!frozen || typeof frozen.profileId !== "string" || !frozen.profileId || frozen.profileId.length > 256
        || frozen.profileId.includes("\0") || frozen.configurationRevision !== 1 || (access !== "read" && access !== "write")) unavailable();
      const descriptor = byProfile.get(frozen.profileId); if (!descriptor) unavailable();
      const runtime = nativeDatabase.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?").get(descriptor.profileId);
      if (!runtime || (runtime.state !== "read_only" && runtime.state !== "read_write")) unavailable();
      const profile: RegisteredStorageProfile = Object.freeze({ profileId: descriptor.profileId, configurationRevision: 1,
        adapterType: "local", namespaceIdentity: descriptor.namespaceIdentity, runtimeState: runtime.state });
      const captured = source(profile, descriptor, access);
      const authority: LocalVolumeProfileAuthority = Object.freeze({ profile, access });
      profileAuthorities.set(authority, Object.freeze({ owner, descriptor, profile, access, captured, assertCurrent() {
        if (JSON.stringify(source(profile, descriptor, access)) !== JSON.stringify(captured)) unavailable();
      } }));
      return authority;
    },
  });
  function track<T>(record: RecordOwner, operation: () => T | Promise<T>): Promise<T> {
    if (record.disposed || closed) return Promise.reject(new Error("Local volume profile is unavailable"));
    const promise = writerLease.withWriter(operation); record.pending.add(promise);
    void promise.then(() => record.pending.delete(promise), () => record.pending.delete(promise)); return promise;
  }
  function dispose(record: RecordOwner): Promise<void> {
    if (record.close) return record.close;
    record.disposed = true;
    record.close = Promise.resolve().then(async () => {
      const cancelled = await Promise.allSettled([...record.cancel].map(cancel => cancel()));
      for (const result of cancelled) if (result.status === "rejected") record.cleanupFailures.add(result.reason);
      await Promise.allSettled([...record.pending]);
      // A rejected original body cancellation cannot authorize closing its
      // parent byte adapter. Keep the same record and cached rejection.
      if (record.cleanupFailures.size) throw new AggregateError([...record.cleanupFailures], "Local volume cleanup is incomplete");
      if (record.bytes) { try { await record.bytes.close(); } catch (error) { record.cleanupFailures.add(error); } }
      if (record.cleanupFailures.size) throw new AggregateError([...record.cleanupFailures], "Local volume cleanup is incomplete");
      records.delete(record);
    });
    return record.close;
  }
  function source(profile: RegisteredStorageProfile, descriptor: CapturedLocalVolumeDescriptor, access: "read" | "write"): Readonly<Source> {
    assertCurrent(); descriptor.assertCurrent();
    if (profile.adapterType !== "local" || profile.profileId !== descriptor.profileId || profile.configurationRevision !== 1
      || profile.namespaceIdentity !== descriptor.namespaceIdentity) unavailable();
    return readLocalVolumeProfileSource(nativeDatabase, installation.installationId, profile, descriptor, access);
  }
  const capabilities: StorageProfileOpeningCapabilities<"local"> = Object.freeze({ database: asJobSqlDatabase(database),
    isCurrent() { try { assertCurrent(); return true; } catch { return false; } },
    async openProvider(profile: RegisteredStorageProfile, access: "read" | "write",
      lifecycle: Parameters<StorageProfileOpeningCapabilities<"local">["openProvider"]>[2]) {
      assertCurrent();
      const descriptor = byProfile.get(profile.profileId); if (!descriptor || records.size >= MAX_OPEN_ADAPTERS) unavailable();
      // Capture binding revision and all authority rows before the first await.
      const captured = source(profile, descriptor, access), record: RecordOwner = { disposed: false, pending: new Set(), cancel: new Set(), cleanupFailures: new Set() };
      records.add(record);
      const current = () => {
        if (record.disposed || lifecycle.signal?.aborted || JSON.stringify(source(profile, descriptor, access)) !== JSON.stringify(captured)) unavailable();
      };
      const request = async (operation: FileByteOperation) => {
        current(); if (await lifecycle.beforeRequest(Object.freeze({ ...operation })) !== true) unavailable(); current(); return true;
      };
      try {
        record.bytes = await track(record, () => openLocalByteStorage(descriptor.bytes, {
          beforeMutation: request, assertCurrent: current,
        }));
        current(); const bytes = record.bytes;
        const opened: OpenedStorageProfile<"local"> = { storage: Object.freeze({ profileId: profile.profileId, configurationRevision: 1,
          adapterType: "local", namespaceIdentity: descriptor.namespaceIdentity }), createHash: nodeSha256, dispose: () => dispose(record),
          reader: {
            stat(key) { return track(record, async () => { await request({ method: "HEAD", key }); const result = await bytes.reader.stat(key); current(); return result; })
              .catch(() => ({ outcome: "unavailable" } as const)); },
            read(key): Promise<ByteReadResult> {
              const delivered = deferred<ByteReadResult>();
              const operation = track(record, async () => {
                await request({ method: "GET", key }); const result = await bytes.reader.read(key);
                try { current(); } catch (error) {
                  if (result.outcome === "available") {
                    try { await result.body.cancel(); }
                    catch (cleanup) {
                      const original = error === cleanup ? error : new AggregateError([error, cleanup], "Local volume read and body cleanup failed");
                      record.cleanupFailures.add(original); throw original;
                    }
                  }
                  throw error;
                }
                if (result.outcome !== "available") { delivered.resolve(result); return; }
                const input = result.body.getReader(), ended = deferred<void>(); let ending: Promise<void> | undefined;
                const abort = () => { void finish().catch(() => undefined); };
                const finish = () => ending ??= Promise.resolve().then(async () => {
                  let released = false;
                  try { await input.cancel(); input.releaseLock(); released = true; }
                  catch (error) { record.cleanupFailures.add(error); throw error; }
                  finally {
                    lifecycle.signal?.removeEventListener("abort", abort);
                    // Settle read bookkeeping even on cleanup failure, but
                    // retain the failed cancellation closure and adapter owner.
                    if (released) record.cancel.delete(finish); ended.resolve();
                  }
                });
                record.cancel.add(finish);
                lifecycle.signal?.addEventListener("abort", abort, { once: true });
                const body = new ReadableStream<Uint8Array>({ async pull(controller) {
                  try { current(); const next = await input.read(); current();
                    if (next.done) { await finish(); controller.close(); } else controller.enqueue(next.value as Uint8Array);
                  } catch (error) {
                    try { await finish(); }
                    catch (cleanup) {
                      const original = error === cleanup ? error : new AggregateError([error, cleanup], "Local volume body and cleanup failed");
                      record.cleanupFailures.add(original); controller.error(original); return;
                    }
                    controller.error(new Error("Local volume profile is unavailable", { cause: error }));
                  }
                }, cancel: finish }, { highWaterMark: 0 });
                delivered.resolve({ ...result, body }); await ended.promise;
              });
              void operation.catch(() => delivered.resolve({ outcome: "unavailable" }));
              return delivered.promise;
            },
          },
          ...(access === "write" ? {
            writer: { accepts: "both" as const, write(input: ByteWriteInput) { return track(record, async () => {
              await request({ method: "PUT", key: input.key }); await bytes.writer.write(input); current();
            }).catch(error => { if (error instanceof ByteVerificationError) throw error; throw new ByteVerificationError("destination", "unavailable", { cause: error }); }); } },
            deleter: { delete(key: string) { return track(record, async () => {
              await request({ method: "DELETE", key }); const result = await bytes.deleter.delete(key); current(); return result;
            }).catch(() => ({ outcome: "unavailable" } as const)); } },
          } : {}),
        };
        return opened;
      } catch (validationCause) {
        if (validationCause instanceof StorageProfileCleanupError) {
          // A failed constructor has already attempted its original cleanup.
          // Keep this exact owner/outcome in the same profile record; absence
          // of a returned byte adapter is never proof that cleanup succeeded.
          record.cleanupFailures.add(validationCause);
          void dispose(record).catch(() => undefined);
          throw validationCause;
        }
        const cleanup = () => dispose(record);
        try { await cleanup(); }
        catch (cleanupCause) { throw new StorageProfileCleanupError(validationCause, cleanupCause, { owner: record, dispose: cleanup }); }
        return unavailable();
      }
    },
  });
  const opening: LocalVolumeProfileOpening = Object.freeze({ capabilities,
    register(raw: unknown, actor: string) { return writerLease.withWriter(async () => {
      assertCurrent();
      // Each operation captures its own actor. No mutable actor slot is shared
      // across concurrent requests; current SQL grant is checked at native BEGIN.
      const registration = createLocalProfileRegistration({ database: () => {
        assertCurrent(); return createOwnedLocalProfileRegistrationSql(database, { assertHeld() { assertAdministrator(actor); } });
      }, authorizeAdministrator: async current => { await owner.authorizeAdministrator(current); return true; },
      isCurrent: capabilities.isCurrent, resolveVolumeDescriptor: id => owner.descriptor(id) });
      return registration.registerLocalProfile(raw, actor);
    }); },
    close() { if (closing) return closing; closed = true;
      closing = (async () => { await Promise.all([...records].map(dispose)); })(); return closing;
    },
  });
  owners.set(opening, owner); physicalAssertions.set(opening, assertPhysicalCurrent);
  preparationAssertions.set(opening, assertPreparing); return opening;
}
