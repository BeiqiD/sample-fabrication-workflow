import type { StorageRolePolicyReceipt } from "../../shared/contracts/storage-policy";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import type { FileAuthoritySqlStatement } from "../../worker/runtime/file-authority-sql";
import { prepareSqlFileAuthorityActivation } from "../../worker/files/authority-activation-core";
import { readSqlStorageRoleDefaults } from "../../worker/files/storage-role-defaults-core";
import { prepareRolePolicyWrites, type RolePolicyTarget } from "../../worker/storage/storage-role-policy-statements";
import { captureLocalVolumeProfileAuthority, createLocalVolumeFileAuthorityDatabase,
  ownedLocalVolumeProfileContext, prepareLocalVolumeProfileAuthorityFence,
  type LocalVolumeProfileOpening } from "./local-volume-profile-opening";
import { LocalVolumeRolePolicyError, prepareLocalVolumeRoleSelectionFence, readSqlLocalRolePolicyReceipt } from "./local-volume-role-policy";
import { assertLocalFileRequestReconciliation, ownedLocalFileConfigurationRequest,
  type LocalFileConfigurationRequest } from "./local-file-request-admission";

interface Input {
  readonly requestId: string;
  readonly expectedEpoch: number;
  readonly internalProfileId: string;
  readonly originalsProfileId: string;
}
function input(raw: unknown): Readonly<Input> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LocalVolumeRolePolicyError("invalid");
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "expectedEpoch,internalProfileId,originalsProfileId,requestId"
    || !("requestId" in raw) || !("expectedEpoch" in raw) || !("internalProfileId" in raw) || !("originalsProfileId" in raw))
    throw new LocalVolumeRolePolicyError("invalid");
  const { requestId, expectedEpoch, internalProfileId, originalsProfileId } = raw;
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
    || typeof expectedEpoch !== "number" || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0
    || typeof internalProfileId !== "string" || !/^storage-profile:local:[0-9a-f]{64}$/.test(internalProfileId)
    || typeof originalsProfileId !== "string" || !/^storage-profile:local:[0-9a-f]{64}$/.test(originalsProfileId))
    throw new LocalVolumeRolePolicyError("invalid");
  return Object.freeze({ requestId, expectedEpoch, internalProfileId, originalsProfileId });
}
function conflict(): never { throw new LocalVolumeRolePolicyError("conflict"); }

/** Explicit fresh-install offline operation, deliberately unmounted. The
 * current real Node installation/lease/admin and both already writable owned
 * local profiles are prerequisites. One native batch executes the mature
 * shadow-enable/activation checkpoint and both role defaults. No cloud profile,
 * alternate namespace, byte copy, hash shortcut, or profile activation is
 * created. A recovered history cannot initialize destination byte authority. */
export function createOfflineLocalFileInitialization(opening: LocalVolumeProfileOpening) {
  return localFileInitialization(opening);
}
/** Unmounted trusted ingress composition. The actor is captured from the
 * original request context and never selected by the initializer payload. */
export function createRequestScopedLocalFileInitialization(opening: LocalVolumeProfileOpening,
  capturedRequest: LocalFileConfigurationRequest) {
  const request = ownedLocalFileConfigurationRequest(capturedRequest, opening);
  const service = localFileInitialization(opening, request);
  return Object.freeze({ initialize(raw: unknown) { return service.initialize(raw, request.actor); } });
}
function localFileInitialization(opening: LocalVolumeProfileOpening,
  request?: ReturnType<typeof ownedLocalFileConfigurationRequest>) {
  const owner = ownedLocalVolumeProfileContext(opening);
  const authorizeAdministrator = (actor: string) => request
    ? request.authorizeAdministrator() : owner.authorizeAdministrator(actor);
  // Capture one genuine native read before any operation await. The final ACK
  // must still describe this current initialization after async authorization;
  // profile/physical current checks alone do not pin File/default heads.
  const currentGraphSql = `SELECT 1 AS admitted WHERE EXISTS(
    SELECT 1 FROM file_shadow_checkpoints cp JOIN file_authority_control a ON a.singleton=1 AND a.mode='active'
    JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 AND g.incarnation=cp.id
    WHERE cp.id=? AND cp.captured_by=? AND g.enabled_by=? AND cp.captured_epoch=? AND cp.captured_at=?)
    AND (SELECT count(*) FROM storage_role_defaults)=2
    AND (SELECT count(*) FROM storage_role_defaults d JOIN storage_role_policy_revisions h
      ON h.policy_revision=d.policy_revision AND h.role=d.role AND h.storage_profile_id=d.storage_profile_id
        AND h.storage_profile_revision=d.storage_profile_revision AND h.created_at=d.created_at
      WHERE d.policy_revision=3 AND d.storage_profile_revision=1 AND h.operation_id=? AND h.actor=? AND d.created_at=?
        AND ((d.role='internal' AND d.storage_profile_id=?) OR(d.role='originals' AND d.storage_profile_id=?)))=2`;
  const currentGraphStatement = owner.nativeDatabase.prepare(currentGraphSql);
  const currentGraph = currentGraphStatement.get.bind(currentGraphStatement);
  return Object.freeze({
    async initialize(raw: unknown, actor: string): Promise<StorageRolePolicyReceipt> {
      const captured = input(raw);
      return owner.writerLease.withWriter(async () => {
        await authorizeAdministrator(actor);
        const internal = captureLocalVolumeProfileAuthority(opening, { profileId: captured.internalProfileId, configurationRevision: 1 }, "write");
        const originals = captureLocalVolumeProfileAuthority(opening, { profileId: captured.originalsProfileId, configurationRevision: 1 }, "write");
        const database = request ? request.database([internal, originals])
          : createLocalVolumeFileAuthorityDatabase(opening, [internal, originals]);
        const admittedCurrentGraph = request ? database.prepare(currentGraphSql) : null;
        const profiles: Readonly<Record<"internal" | "originals", RolePolicyTarget>> = Object.freeze({
          internal: Object.freeze({ id: internal.profile.profileId, configurationRevision: 1, namespaceIdentity: internal.profile.namespaceIdentity }),
          originals: Object.freeze({ id: originals.profile.profileId, configurationRevision: 1, namespaceIdentity: originals.profile.namespaceIdentity }),
        });
        async function committed(): Promise<StorageRolePolicyReceipt | null> {
          owner.assertAdministrator(actor);
          const value = await readSqlLocalRolePolicyReceipt(database, captured.requestId);
          owner.assertAdministrator(actor);
          if (!value) return null;
          if (value.policyRevision !== 3 || value.createdBy !== actor || value.internalProfileId !== captured.internalProfileId
            || value.originalsProfileId !== captured.originalsProfileId) conflict();
          const current = await database.primary().prepare(`SELECT cp.captured_epoch,cp.captured_at FROM file_shadow_checkpoints cp
            JOIN file_authority_control a ON a.singleton=1 AND a.mode='active'
            JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 AND g.incarnation=cp.id
            WHERE cp.id=? AND cp.captured_by=? AND g.enabled_by=?`).bind(captured.requestId, actor, actor).first();
          owner.assertAdministrator(actor);
          if (!current || configurationSqlInteger(current.captured_epoch, "localFile.initializationEpoch") !== captured.expectedEpoch
            || current.captured_at !== value.createdAt) conflict();
          // A newer policy or recovered disabled runtime is not a replay that
          // grants initial File powers, even if copied provenance still exists.
          const defaults = await readSqlStorageRoleDefaults(database);
          owner.assertAdministrator(actor);
          if (!defaults || defaults.internal.policyRevision !== 3 || defaults.internal.storageProfileId !== captured.internalProfileId
            || defaults.originals.storageProfileId !== captured.originalsProfileId || defaults.internal.createdAt !== value.createdAt) conflict();
          // The last async authorization can yield across a session or
          // credential change after its authentic prior result. For Request
          // operations the issued checks and this original current graph
          // therefore run together in a final actual BEGIN. The immutable
          // operation/actor/epoch/time/default-history tuple pins the receipt.
          await authorizeAdministrator(actor);
          if (admittedCurrentGraph) {
            const admitted = await admittedCurrentGraph.bind(captured.requestId, actor, actor, captured.expectedEpoch, value.createdAt,
              captured.requestId, actor, value.createdAt, captured.internalProfileId, captured.originalsProfileId).first();
            if (admitted?.admitted !== 1 && admitted?.admitted !== 1n) conflict();
          }
          // No further authorization await follows the final admitted read;
          // retain the existing synchronous physical and current graph fence.
          owner.assertAdministrator(actor); database.primary();
          const finalGraph = currentGraph(captured.requestId, actor, actor, captured.expectedEpoch, value.createdAt,
            captured.requestId, actor, value.createdAt, captured.internalProfileId, captured.originalsProfileId);
          if (finalGraph?.admitted !== 1 && finalGraph?.admitted !== 1n) conflict();
          return value;
        }
        const previous = await committed();
        if (previous) return previous;
        const stored = await readSqlStorageRoleDefaults(database);
        if (stored) conflict();
        const now = new Date().toISOString();
        const administrator = database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM local_accounts a
          JOIN local_admin_grants g ON g.principal_id=a.principal_id WHERE a.principal_id=? AND a.enabled=1)
          THEN 1 ELSE json('Current local administrator changed') END`).bind(actor.slice("local-account:".length));
        const fresh = database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_control a
          JOIN file_shadow_control c ON c.singleton=a.singleton JOIN file_shadow_runtime_guard s ON s.singleton=a.singleton
          JOIN file_authority_runtime_guard g ON g.singleton=a.singleton WHERE a.singleton=1 AND a.mode='legacy'
            AND c.epoch=? AND s.incarnation IS NULL AND s.enabled=0 AND g.enabled=0)
          AND NOT EXISTS(SELECT 1 FROM storage_role_defaults) AND NOT EXISTS(SELECT 1 FROM storage_role_policy_revisions)
          AND NOT EXISTS(SELECT 1 FROM file_shadow_enablements) AND NOT EXISTS(SELECT 1 FROM files)
          AND NOT EXISTS(SELECT 1 FROM assets) AND NOT EXISTS(SELECT 1 FROM file_shadow_heads WHERE present=1)
          THEN 1 ELSE json('Fresh local File initialization changed') END`).bind(captured.expectedEpoch);
        const providerFences = [prepareLocalVolumeProfileAuthorityFence(internal, database),
          prepareLocalVolumeProfileAuthorityFence(originals, database)];
        const statements: FileAuthoritySqlStatement[] = [administrator, fresh, ...providerFences,
          database.prepare("INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at) VALUES(1,?,?,?)")
            .bind(captured.expectedEpoch, actor, now),
          ...prepareSqlFileAuthorityActivation(database, actor, { requestId: captured.requestId,
            expectedEpoch: captured.expectedEpoch, expectedShadowIncarnation: null }, now),
          ...prepareRolePolicyWrites<FileAuthoritySqlStatement>(database, null, profiles, 3, captured.requestId, actor, now,
            [administrator, ...providerFences], prepareLocalVolumeRoleSelectionFence(database, 3, profiles)),
        ];
        await authorizeAdministrator(actor);
        try { await database.batch(statements); }
        catch (cause) {
          if (request) assertLocalFileRequestReconciliation(opening, cause);
          // Reconcile the single original native commit; no second activation,
          // role write, or provider operation follows an uncertain ACK.
          const result = await committed();
          if (result) return result;
          conflict();
        }
        const result = await committed();
        if (!result) throw new LocalVolumeRolePolicyError("unavailable");
        return result;
      });
    },
  });
}
