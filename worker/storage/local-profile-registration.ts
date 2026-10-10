import { HTTPException } from "hono/http-exception";
import { checkedRegisterLocalProfileInput, LocalProfileRegistrationInputError,
  type LocalProfileRegistrationReceipt, type RegisterLocalProfileInput } from "../../shared/contracts/local-profile-registration";
import { canonicalLocalVolumeNamespace, checkedLocalVolumeNamespace, checkedStoredLocalVolumeNamespace,
  localVolumeStorageProfileId, type LocalVolumeNamespace } from "../../shared/contracts/local-volume-profile";
import { configurationSqlInteger, type ConfigurationSqlDatabase, type ConfigurationSqlRow } from "../runtime/configuration-sql";

/** Only trusted installation composition resolves this opaque descriptor. The
 * namespace excludes the physical path and does not attest a physical volume. */
export interface LocalVolumeRegistrationDescriptor {
  readonly id: string;
  readonly namespace: Readonly<LocalVolumeNamespace>;
}
export interface LocalProfileRegistrationCapabilities {
  /** Node composition must supply createOwnedLocalProfileRegistrationSql,
   * whose batch synchronously asserts the same held owner before BEGIN.
   * An unfenced generic database plus isCurrent callback is insufficient. */
  database(): ConfigurationSqlDatabase;
  authorizeAdministrator(actor: string): boolean | Promise<boolean>;
  /** Captures the installation/physical writer owner selected by composition.
   * It must become false when that owner is disposed, replaced or loses lease. */
  isCurrent(): boolean | Promise<boolean>;
  resolveVolumeDescriptor(id: string): LocalVolumeRegistrationDescriptor | null | Promise<LocalVolumeRegistrationDescriptor | null>;
}
export class LocalProfileRegistrationError extends Error {
  readonly status: 400 | 409 | 503;
  constructor(status: 400 | 409 | 503, message: string) { super(message); this.status = status; this.name = "LocalProfileRegistrationError"; }
}
class AdministratorDenied extends HTTPException {
  constructor() { super(403, { message: "System administrator access is required." }); }
}
const unavailable = () => new LocalProfileRegistrationError(503, "Local profile registration is temporarily unavailable.");
const conflict = () => new LocalProfileRegistrationError(409, "Local profile registration conflicts with an existing operation.");
const SELECT_RECEIPT = `SELECT p.id,p.namespace_identity,p.configuration_revision,p.configuration_source,p.adapter_type,p.credential_reference,
  p.created_at AS profile_created_at,r.operation_id,r.namespace_sha256,r.actor,r.created_at
  FROM local_storage_profile_registrations r JOIN storage_profiles p ON p.id=r.storage_profile_id WHERE r.operation_id=?`;

function text(row: ConfigurationSqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new TypeError(`Invalid local profile column: ${column}`);
  return value;
}
function receipt(row: ConfigurationSqlRow, operationId: string, profileId: string, namespaceJson: string, actor: string): LocalProfileRegistrationReceipt {
  if (text(row, "operation_id") !== operationId || text(row, "id") !== profileId || text(row, "namespace_identity") !== namespaceJson
    || text(row, "namespace_sha256") !== profileId.slice("storage-profile:local:".length) || text(row, "actor") !== actor
    || text(row, "adapter_type") !== "local" || text(row, "configuration_source") !== "installation" || row.credential_reference !== null
    || configurationSqlInteger(row.configuration_revision, "local configuration revision", 1) !== 1
    || text(row, "profile_created_at") !== text(row, "created_at")) throw conflict();
  const createdAt = text(row, "created_at");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || new Date(createdAt).toISOString() !== createdAt) throw unavailable();
  return Object.freeze({ operationId, storageProfileId: profileId, namespace: checkedStoredLocalVolumeNamespace(namespaceJson),
    namespaceSha256: text(row, "namespace_sha256"), configurationRevision: 1, registeredMode: "read_only", createdAt, actor });
}

/** Uncomposed V26 service. This only creates immutable historical metadata and
 * its read-only runtime seed. No storage adapter, probe, binding, admission,
 * activation, default policy, File authority or administrator grant is opened. */
export function createLocalProfileRegistration(capabilities: LocalProfileRegistrationCapabilities) {
  async function assertAdministrator(actor: string) {
    let allowed = false;
    try { allowed = await capabilities.authorizeAdministrator(actor) === true; } catch { /* Fail closed. */ }
    if (!allowed) throw new AdministratorDenied();
  }
  async function assertCurrent() {
    let current = false;
    try { current = await capabilities.isCurrent() === true; } catch { /* Fail closed. */ }
    if (!current) throw unavailable();
  }
  async function registerLocalProfile(raw: unknown, actor: string): Promise<LocalProfileRegistrationReceipt> {
    await assertAdministrator(actor); await assertCurrent();
    let input: Readonly<RegisterLocalProfileInput>;
    try { input = checkedRegisterLocalProfileInput(raw); }
    catch (error) { if (error instanceof LocalProfileRegistrationInputError) throw new LocalProfileRegistrationError(400, error.message); throw unavailable(); }
    if (typeof actor !== "string" || actor.length < 1 || actor.length > 254 || actor.includes("\0")) throw unavailable();
    try {
      const descriptor = await capabilities.resolveVolumeDescriptor(input.volumeDescriptorId);
      if (!descriptor || descriptor.id !== input.volumeDescriptorId) throw unavailable();
      // Snapshot all descriptor namespace cells before awaiting the digest.
      const namespace = checkedLocalVolumeNamespace(descriptor.namespace), namespaceJson = canonicalLocalVolumeNamespace(namespace);
      const profileId = await localVolumeStorageProfileId(namespace), namespaceSha256 = profileId.slice("storage-profile:local:".length);
      await assertCurrent(); await assertAdministrator(actor);
      const db = capabilities.database().primary();
      const previous = await db.prepare(SELECT_RECEIPT).bind(input.operationId).first();
      if (previous !== null) {
        const result = receipt(previous, input.operationId, profileId, namespaceJson, actor);
        await assertCurrent(); await assertAdministrator(actor); return result;
      }
      if (await db.prepare("SELECT id FROM storage_profiles WHERE id=?").bind(profileId).first()) throw conflict();
      const now = new Date().toISOString();
      const statements = [
        db.prepare(`INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
          VALUES(?,'local',?,'installation',NULL,1,'historical',?)`).bind(profileId, namespaceJson, now),
        db.prepare(`INSERT INTO local_storage_profile_registrations(storage_profile_id,operation_id,namespace_sha256,actor,created_at)
          VALUES(?,?,?,?,?)`).bind(profileId, input.operationId, namespaceSha256, actor, now),
      ];
      await assertCurrent(); await assertAdministrator(actor);
      try {
        const acknowledged = await db.batch(statements);
        if (acknowledged.length !== 2 || acknowledged.some(item => item.directChanges !== 1)) throw new Error("Uncertain local registration acknowledgement");
      } catch (error) {
        // No destructive cleanup or blind mutation retry. Only a fresh primary
        // read of this immutable operation settles uncertain acknowledgement.
        await assertCurrent(); await assertAdministrator(actor);
        const committed = await capabilities.database().primary().prepare(SELECT_RECEIPT).bind(input.operationId).first();
        if (!committed) throw error;
        const recovered = receipt(committed, input.operationId, profileId, namespaceJson, actor);
        if (recovered.createdAt !== now) throw conflict();
        await assertCurrent(); await assertAdministrator(actor); return recovered;
      }
      await assertCurrent(); await assertAdministrator(actor);
      const committed = await capabilities.database().primary().prepare(SELECT_RECEIPT).bind(input.operationId).first();
      if (!committed) throw unavailable();
      const result = receipt(committed, input.operationId, profileId, namespaceJson, actor);
      if (result.createdAt !== now) throw conflict();
      await assertCurrent(); await assertAdministrator(actor); return result;
    } catch (error) {
      if (error instanceof LocalProfileRegistrationError || error instanceof AdministratorDenied) throw error;
      if (error instanceof Error && error.message.includes("FP1 immutable identity conflict")) throw conflict();
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: storage_profiles.id")) throw conflict();
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: local_storage_profile_registrations.")) throw conflict();
      throw unavailable();
    }
  }
  return { registerLocalProfile };
}
