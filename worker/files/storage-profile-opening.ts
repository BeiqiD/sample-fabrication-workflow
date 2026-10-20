import type { ByteDeleter } from "./byte-deleter";
import type { ByteReader } from "./byte-reader";
import type { Sha256Factory } from "./byte-verification";
import type { ByteWriter } from "./byte-writer";
import type { JobSqlDatabase } from "./jobs/sql-repository";

export interface FrozenStorageProfile {
  profileId: string;
  configurationRevision: number;
}
export type FileByteOperation = Readonly<{ method: "GET" | "HEAD" | "PUT" | "DELETE"; key: string }>;
export interface StorageProfileLifecycle {
  signal?: AbortSignal;
  /** Optional immutable caller stage deadline; absent preserves original ports. */
  deadlineAt?: string;
  /** Additional restriction from an admitted original public Recovery claim. */
  systemRecoveryActor?: string;
  beforeRequest?: (operation: FileByteOperation) => Promise<boolean>;
  /** Recheck the caller's exact deletion claim immediately before transport.
   * False or an exception prevents I/O. This does not revoke an in-flight DELETE. */
  beforeDelete?: (key: string) => Promise<boolean>;
}
export type BoundStorageProfile<Adapter extends string> = Readonly<FrozenStorageProfile & {
  adapterType: Adapter;
  namespaceIdentity: string;
}>;
export interface OpenedStorageProfile<Adapter extends string> {
  storage: BoundStorageProfile<Adapter>;
  reader: ByteReader;
  writer?: ByteWriter;
  deleter?: ByteDeleter;
  createHash: Sha256Factory;
  /** Release this opening's transport ownership after all original operations
   * settle. Omitted by stateless providers; never releases installation lease. */
  dispose?: () => Promise<void>;
}
export type RegisteredStorageProfile = Readonly<FrozenStorageProfile & {
  adapterType: string;
  namespaceIdentity: string;
  runtimeState: "read_only" | "read_write";
}>;
export interface StorageProfileOpeningCapabilities<Adapter extends string> {
  /** Reuse the existing neutral SQL surface; every lookup observes primary. */
  database: Pick<JobSqlDatabase, "prepare" | "primary">;
  /** The captured database/provider composition still belongs to this runtime. */
  isCurrent(): boolean;
  /** Trusted provider composition must assert its exact immutable namespace,
   * registration/admission and transport bindings. Apply beforeRequest just
   * before each byte request. Returning a label alone never admits a provider. */
  openProvider(profile: RegisteredStorageProfile, access: "read" | "write",
    lifecycle: Readonly<{ signal?: AbortSignal; deadlineAt?: string; systemRecoveryActor?: string; beforeRequest: (operation: FileByteOperation) => Promise<boolean> }>): Promise<OpenedStorageProfile<Adapter>>;
}
export class ShadowProfileUnavailableError extends Error {
  constructor(options?: ErrorOptions) { super("The recorded File storage profile is unavailable", options); this.name = "ShadowProfileUnavailableError"; }
}
/** A failed opening still owns unresolved provider cleanup. This classification
 * retains actual in-process owners and exact causes for host quarantine; its
 * public message remains sanitized. The disposer is evidence, never retry
 * permission, and neither the descriptor nor opaque owner admits a capability. */
export class StorageProfileCleanupError extends ShadowProfileUnavailableError {
  declare readonly validationCause: unknown;
  declare readonly cleanupCause: unknown;
  declare readonly ownership: Readonly<{ owner: unknown; dispose: () => Promise<void> }>;
  constructor(validationCause: unknown, cleanupCause: unknown,
    ownership: Readonly<{ owner: unknown; dispose: () => Promise<void> }>) {
    super({ cause: new AggregateError([validationCause, cleanupCause], "Storage profile opening cleanup is incomplete") });
    this.name = "StorageProfileCleanupError";
    Object.defineProperties(this, {
      validationCause: { value: validationCause },
      cleanupCause: { value: cleanupCause },
      ownership: { value: Object.freeze({ owner: ownership.owner, dispose: ownership.dispose }) },
    });
  }
}

/** Open only an exact registered profile through a trusted runtime composer.
 * No profile/default/role mutation, retry, alternate adapter, or File admission
 * occurs here. Adapter-specific persisted authority remains the composer's job.
 * The generic adapter parameter supports a future Node composition without
 * declaring local profiles valid in the current application's schema/unions. */
export async function openStorageProfile<Adapter extends string>(
  capabilities: StorageProfileOpeningCapabilities<Adapter>,
  frozen: FrozenStorageProfile,
  access: "read" | "write",
  lifecycle: StorageProfileLifecycle = {},
): Promise<OpenedStorageProfile<Adapter>> {
  let dispose: (() => Promise<void>) | undefined;
  let providerOwner: unknown;
  try {
    if (!frozen || typeof frozen.profileId !== "string" || !frozen.profileId
      || frozen.profileId.length > 256 || frozen.profileId.includes("\0")
      || frozen.configurationRevision !== 1 || !["read", "write"].includes(access)) throw new Error();
    const target = Object.freeze({ profileId: frozen.profileId, configurationRevision: frozen.configurationRevision });
    const database = capabilities.database, isCurrent = capabilities.isCurrent.bind(capabilities),
      openProvider = capabilities.openProvider.bind(capabilities);
    const signal = lifecycle.signal, beforeRequest = lifecycle.beforeRequest, beforeDelete = lifecycle.beforeDelete;
    const deadlineAt = lifecycle.deadlineAt, deadline = deadlineAt === undefined ? null : Date.parse(deadlineAt);
    const localClock = () => deadline === null || Number.isFinite(deadline) && Date.now() < deadline;
    if (signal?.aborted || !isCurrent() || !localClock()) throw new Error();
    const row = await database.primary().prepare(`SELECT p.adapter_type, p.configuration_revision, p.namespace_identity, r.state
      FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
      WHERE p.id=?`).bind(target.profileId).first<{
        adapter_type: string; configuration_revision: number; namespace_identity: string; state: string;
      }>();
    if (!row || row.configuration_revision !== target.configurationRevision
      || typeof row.adapter_type !== "string" || !row.adapter_type || row.adapter_type.includes("\0")
      || typeof row.namespace_identity !== "string" || !row.namespace_identity || row.namespace_identity.length > 2048
      || row.namespace_identity.includes("\0") || !["read_only", "read_write"].includes(row.state)
      || access === "write" && row.state !== "read_write" || signal?.aborted || !isCurrent() || !localClock()) throw new Error();
    const profile: RegisteredStorageProfile = Object.freeze({ ...target, adapterType: row.adapter_type,
      namespaceIdentity: row.namespace_identity, runtimeState: row.state as "read_only" | "read_write" });
    const callerFence = async (operation: FileByteOperation) => {
      const request = Object.freeze({ method: operation.method, key: operation.key });
      if (signal?.aborted || !isCurrent() || !localClock()) return false;
      if (beforeRequest && await beforeRequest(request) !== true) return false;
      if (request.method === "DELETE" && beforeDelete && await beforeDelete(request.key) !== true) return false;
      return !signal?.aborted && isCurrent() && localClock();
    };
    const opened = await openProvider(profile, access, Object.freeze({ signal, beforeRequest: callerFence, ...(deadlineAt===undefined?{}:{deadlineAt}),
      ...(lifecycle.systemRecoveryActor===undefined?{}:{systemRecoveryActor:lifecycle.systemRecoveryActor}) }));
    providerOwner = opened;
    const disposeMethod = opened?.dispose;
    if (typeof disposeMethod === "function") dispose = disposeMethod.bind(opened);
    if (signal?.aborted || !isCurrent() || !localClock() || !opened || opened.storage.profileId !== target.profileId
      || opened.storage.configurationRevision !== target.configurationRevision || opened.storage.adapterType !== profile.adapterType
      || opened.storage.namespaceIdentity !== profile.namespaceIdentity || typeof opened.reader?.read !== "function"
      || typeof opened.reader.stat !== "function" || typeof opened.createHash !== "function"
      || access === "write" && (typeof opened.writer?.write !== "function" || typeof opened.deleter?.delete !== "function")) throw new Error();
    // Own the returned descriptor so a mutable provider result cannot retarget it.
    return { storage: Object.freeze({ ...target, adapterType: opened.storage.adapterType, namespaceIdentity: profile.namespaceIdentity }),
      reader: opened.reader, createHash: opened.createHash,
      ...(dispose ? { dispose } : {}),
      ...(access === "write" ? { writer: opened.writer, deleter: opened.deleter } : {}) };
  } catch (validationCause) {
    // Already-classified failed ownership has completed its one cleanup
    // attempt. Preserve it before considering another captured disposer.
    if (validationCause instanceof StorageProfileCleanupError) throw validationCause;
    if (dispose) {
      try { await dispose(); }
      catch (cleanupCause) { throw new StorageProfileCleanupError(validationCause, cleanupCause, { owner: providerOwner, dispose }); }
    }
    throw new ShadowProfileUnavailableError();
  }
}
