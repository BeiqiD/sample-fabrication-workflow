import { checkedStorageRolePolicyInput, checkedStorageRolePolicyReceipt,
  type StorageRolePolicyInput, type StorageRolePolicyReceipt } from "../../shared/contracts/storage-policy";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import type { FileAuthoritySqlDatabase, FileAuthoritySqlStatement } from "../../worker/runtime/file-authority-sql";
import { readSqlStorageRoleDefaults } from "../../worker/files/storage-role-defaults-core";
import { prepareRolePolicyWrites, type RolePolicyTarget } from "../../worker/storage/storage-role-policy-statements";
import { asFileAuthoritySqlDatabase } from "../file-authority-sql";
import { captureLocalVolumeProfileAuthority, createLocalVolumeFileAuthorityDatabase,
  ownedLocalVolumeProfileContext, prepareLocalVolumeProfileAuthorityFence,
  type LocalVolumeProfileOpening } from "./local-volume-profile-opening";
import { assertLocalFileRequestReconciliation, ownedLocalFileConfigurationRequest,
  type LocalFileConfigurationRequest } from "./local-file-request-admission";

export class LocalVolumeRolePolicyError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "unavailable") {
    super(code === "invalid" ? "Invalid local storage role policy."
      : code === "conflict" ? "The local storage role policy changed." : "The local storage role policy is unavailable.");
    this.name = "LocalVolumeRolePolicyError";
  }
}
function conflict(): never { throw new LocalVolumeRolePolicyError("conflict"); }

/** Exact immutable history read. A returned receipt is provenance, never
 * permission to open a retired profile or resurrect destination authority. */
export async function readSqlLocalRolePolicyReceipt(database: FileAuthoritySqlDatabase, operationId: string): Promise<StorageRolePolicyReceipt | null> {
  const result = await database.primary().prepare("SELECT * FROM storage_role_policy_revisions WHERE operation_id=? ORDER BY role")
    .bind(operationId).all();
  if (!result.results.length) return null;
  if (result.results.length !== 2) throw new LocalVolumeRolePolicyError("unavailable");
  const [internal, originals] = result.results;
  if (internal.role !== "internal" || originals.role !== "originals" || internal.actor !== originals.actor
    || internal.created_at !== originals.created_at || internal.operation_id !== operationId || originals.operation_id !== operationId)
    throw new LocalVolumeRolePolicyError("unavailable");
  const revision = configurationSqlInteger(internal.policy_revision, "localRole.policyRevision", 3);
  if (configurationSqlInteger(originals.policy_revision, "localRole.policyRevision", 3) !== revision
    || configurationSqlInteger(internal.storage_profile_revision, "localRole.profileRevision", 1) !== 1
    || configurationSqlInteger(originals.storage_profile_revision, "localRole.profileRevision", 1) !== 1)
    throw new LocalVolumeRolePolicyError("unavailable");
  return checkedStorageRolePolicyReceipt({ operationId, policyRevision: revision,
    internalProfileId: internal.storage_profile_id, originalsProfileId: originals.storage_profile_id,
    createdAt: internal.created_at, createdBy: internal.actor });
}
function match(value: StorageRolePolicyReceipt, input: StorageRolePolicyInput, actor: string): StorageRolePolicyReceipt {
  if (value.createdBy !== actor || value.internalProfileId !== input.internalProfileId || value.originalsProfileId !== input.originalsProfileId
    || value.policyRevision !== Math.max(3, (input.expectedPolicyRevision ?? 2) + 1)) conflict();
  return value;
}

/** Metadata selection fence is paired with both issued local source fences
 * in the same actual native transaction; it alone grants no byte authority. */
export function prepareLocalVolumeRoleSelectionFence(database: FileAuthoritySqlDatabase, revision: number,
  profiles: Readonly<Record<"internal" | "originals", RolePolicyTarget>>): FileAuthoritySqlStatement {
  return database.prepare(`SELECT CASE WHEN (SELECT count(*) FROM storage_role_defaults)=2 AND
    (SELECT count(*) FROM storage_role_defaults d JOIN storage_role_policy_revisions h
      ON h.policy_revision=d.policy_revision AND h.role=d.role AND h.storage_profile_id=d.storage_profile_id
        AND h.storage_profile_revision=d.storage_profile_revision AND h.created_at=d.created_at
      JOIN storage_profiles p ON p.id=d.storage_profile_id AND p.configuration_revision=d.storage_profile_revision
      JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
      WHERE d.policy_revision=? AND p.adapter_type='local' AND p.configuration_source='installation'
        AND ((d.role='internal' AND d.storage_profile_id=? AND p.namespace_identity=?)
          OR(d.role='originals' AND d.storage_profile_id=? AND p.namespace_identity=?)))=2
    AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g
      ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active')
    THEN 1 ELSE json('Selected local storage policy changed') END`)
    .bind(revision, profiles.internal.id, profiles.internal.namespaceIdentity, profiles.originals.id, profiles.originals.namespaceIdentity);
}

/** Explicit offline operator composition only. The actual issued opening owns
 * current V26 installation/catalog, Linux lease, configured physical volume
 * descriptors and current installed administrator. Profiles must already have
 * genuine writable probe/binding/activation; this does not activate File mode,
 * attach volumes, initialize a provider, or write any bytes. HTTP/configuration
 * mounting remains a separate qualified host integration. */
export function createOfflineLocalVolumeRolePolicy(opening: LocalVolumeProfileOpening) {
  return localVolumeRolePolicy(opening);
}
/** Request-scoped metadata operation, unmounted. The same original four
 * issued administrator checks precede the mature policy/source SQL in BEGIN. */
export function createRequestScopedLocalVolumeRolePolicy(opening: LocalVolumeProfileOpening,
  capturedRequest: LocalFileConfigurationRequest) {
  const request = ownedLocalFileConfigurationRequest(capturedRequest, opening);
  const service = localVolumeRolePolicy(opening, request);
  return Object.freeze({ setDefaults(raw: unknown) { return service.setDefaults(raw, request.actor); } });
}
function localVolumeRolePolicy(opening: LocalVolumeProfileOpening,
  request?: ReturnType<typeof ownedLocalFileConfigurationRequest>) {
  const owner = ownedLocalVolumeProfileContext(opening);
  const authorizeAdministrator = (actor: string) => request
    ? request.authorizeAdministrator() : owner.authorizeAdministrator(actor);
  return Object.freeze({
    async setDefaults(raw: unknown, actor: string): Promise<StorageRolePolicyReceipt> {
      let input: StorageRolePolicyInput;
      try { input = Object.freeze(checkedStorageRolePolicyInput(raw)); }
      catch { throw new LocalVolumeRolePolicyError("invalid"); }
      return owner.writerLease.withWriter(async () => {
        await authorizeAdministrator(actor);
        const historyDatabase = request ? request.historyDatabase() : asFileAuthoritySqlDatabase(owner.database, {
          assertHeld() { owner.assertCurrent(); owner.assertAdministrator(actor); },
        });
        function accepted(value: StorageRolePolicyReceipt): StorageRolePolicyReceipt | Promise<StorageRolePolicyReceipt> {
          const result = match(value, input, actor);
          if (!request) return result;
          return (async () => {
            await request.authorizeAdministrator();
            // Re-read the exact immutable operation through the original
            // issued checks after the final async authorization. Historical
            // replay remains provenance; it does not require the current head.
            const final = await readSqlLocalRolePolicyReceipt(historyDatabase, input.operationId);
            if (!final || match(final, input, actor).createdAt !== result.createdAt) conflict();
            historyDatabase.primary(); return final;
          })();
        }
        const previous = await readSqlLocalRolePolicyReceipt(historyDatabase, input.operationId);
        if (previous) return accepted(previous);
        const stored = await readSqlStorageRoleDefaults(historyDatabase);
        if ((stored?.internal.policyRevision ?? null) !== input.expectedPolicyRevision) conflict();
        const internal = captureLocalVolumeProfileAuthority(opening, { profileId: input.internalProfileId, configurationRevision: 1 }, "write");
        const originals = captureLocalVolumeProfileAuthority(opening, { profileId: input.originalsProfileId, configurationRevision: 1 }, "write");
        const database = request ? request.database([internal, originals])
          : createLocalVolumeFileAuthorityDatabase(opening, [internal, originals]);
        const profiles: Readonly<Record<"internal" | "originals", RolePolicyTarget>> = Object.freeze({
          internal: Object.freeze({ id: internal.profile.profileId, configurationRevision: 1, namespaceIdentity: internal.profile.namespaceIdentity }),
          originals: Object.freeze({ id: originals.profile.profileId, configurationRevision: 1, namespaceIdentity: originals.profile.namespaceIdentity }),
        });
        const revision = Math.max(3, (input.expectedPolicyRevision ?? 2) + 1), now = new Date().toISOString();
        if (!Number.isSafeInteger(revision)) conflict();
        const currentAdministrator = database.prepare(`SELECT CASE WHEN EXISTS(
          SELECT 1 FROM local_accounts a JOIN local_admin_grants g ON g.principal_id=a.principal_id
          WHERE a.principal_id=? AND a.enabled=1) THEN 1 ELSE json('Current local administrator changed') END`)
          .bind(actor.slice("local-account:".length));
        const selectionFence = prepareLocalVolumeRoleSelectionFence(database, revision, profiles);
        const providerFences: FileAuthoritySqlStatement[] = [currentAdministrator,
          prepareLocalVolumeProfileAuthorityFence(internal, database), prepareLocalVolumeProfileAuthorityFence(originals, database)];
        const statements = prepareRolePolicyWrites<FileAuthoritySqlStatement>(database, stored, profiles, revision,
          input.operationId, actor, now, providerFences, selectionFence);
        await authorizeAdministrator(actor);
        try { await database.batch(statements); }
        catch (cause) {
          if (request) assertLocalFileRequestReconciliation(opening, cause);
          // Actual SQL can commit before the caller loses its ACK. Read the
          // immutable operation once; never issue a second policy write.
          const committed = await readSqlLocalRolePolicyReceipt(historyDatabase, input.operationId);
          if (committed) return accepted(committed);
          conflict();
        }
        const committed = await readSqlLocalRolePolicyReceipt(historyDatabase, input.operationId);
        if (!committed) throw new LocalVolumeRolePolicyError("unavailable");
        return accepted(committed);
      });
    },
  });
}
