import type { Env } from "../types";
import type { StorageCredentialSetupState, StorageCredentialSetupStatus } from "../../shared/contracts/storage-credential-setup";
import { decryptStorageCredential, StorageCredentialUnavailableError, type StorageCredentialKeyring } from "./credential-envelope";
import { captureStorageCredentialRoot, resolveStorageCredentialRoot, storageCredentialRootUnchanged,
  type StorageCredentialRootCapture } from "./installation-secret-seed";
import { assertSystemAdministrator } from "./system-administrator";

type CredentialEnvironment = Pick<Env, "DB" | "STORAGE_CREDENTIAL_KEYRING" | "INSTALLATION_SECRET_SEED">;
type AdministratorEnvironment = CredentialEnvironment & Pick<Env, "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS">;
interface RetainedEnvelope {
  profile_id: string; configuration_revision: number; credential_ref: string; namespace_sha256: string;
  envelope_version: number; key_id: string; nonce: string; ciphertext: string;
}

/** Existing protected rows are the durable indication that this is recovery,
 * not first installation. No new schema or root secret is stored in D1.
 * Historical schema14 installations have no checks table yet; its presence is
 * discovered explicitly rather than treating arbitrary SQL failures as empty. */
async function retainedHistory(database: D1Database) {
  const db = typeof database.withSession === "function" ? database.withSession("first-primary") : database;
  const tables = (await db.prepare(`SELECT name FROM sqlite_schema WHERE type='table'
    AND name IN ('system_storage_profiles','system_storage_credential_descriptors',
      'system_storage_credential_payloads','system_storage_candidate_checks')`).all<{ name: string }>()).results;
  const names = new Set(tables.map(row => row.name));
  for (const required of ["system_storage_profiles", "system_storage_credential_descriptors", "system_storage_credential_payloads"]) {
    if (!names.has(required)) throw new StorageCredentialUnavailableError();
  }
  const checks = names.has("system_storage_candidate_checks");
  const row = await db.prepare(`SELECT (EXISTS(SELECT 1 FROM system_storage_profiles)
    OR EXISTS(SELECT 1 FROM system_storage_credential_descriptors)
    OR EXISTS(SELECT 1 FROM system_storage_credential_payloads)
    ${checks ? "OR EXISTS(SELECT 1 FROM system_storage_candidate_checks)" : ""}) AS retained,
    (EXISTS(SELECT 1 FROM system_storage_credential_payloads)
    ${checks ? "OR EXISTS(SELECT 1 FROM system_storage_candidate_checks)" : ""}) AS protected`).first<{ retained: number; protected: number }>();
  if (!row || row.retained !== 0 && row.retained !== 1 || row.protected !== 0 && row.protected !== 1) throw new StorageCredentialUnavailableError();
  return { db, checks, exists: row.retained === 1, hasProtected: row.protected === 1 };
}

/** At most one authenticated sample per retained key, including immutable check
 * snapshots. The keyring format admits at most16 keys; a17th retained key fails
 * closed. This diagnoses the configured root, not every stored row's integrity.
 * Each consuming operation still authenticates its own complete envelope. */
async function assertHistoryReadable(database: D1Database, keyring: StorageCredentialKeyring, legacyMetadataRecovery: boolean) {
  const history = await retainedHistory(database);
  if (!history.exists) return { exists: false, checks: history.checks, hasProtected: false };
  if (!history.hasProtected) {
    // Existing metadata-only recovery deliberately omits protected payloads.
    // A configured legacy keyring may still accept explicitly re-entered
    // provider credentials; retaining absent plaintext continues to fail. A new
    // seed cannot adopt this history or masquerade as the missing original root.
    if (legacyMetadataRecovery) return { exists: true, checks: history.checks, hasProtected: false };
    throw new StorageCredentialUnavailableError();
  }
  const samples = (await history.db.prepare(`WITH retained AS (
    SELECT d.profile_id,d.configuration_revision,d.credential_ref,d.namespace_sha256,
      e.envelope_version,e.key_id,e.nonce,e.ciphertext,0 AS source
    FROM system_storage_credential_descriptors d
    JOIN system_storage_credential_payloads e ON e.credential_ref=d.credential_ref
    ${history.checks ? `UNION ALL SELECT profile_id,configuration_revision,credential_ref,namespace_sha256,
      envelope_version,key_id,nonce,ciphertext,1 AS source FROM system_storage_candidate_checks` : ""}
  ), ranked AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY key_id ORDER BY source,credential_ref) AS sample FROM retained
  ) SELECT profile_id,configuration_revision,credential_ref,namespace_sha256,envelope_version,key_id,nonce,ciphertext
    FROM ranked WHERE sample=1 ORDER BY key_id LIMIT 17`).all<RetainedEnvelope>()).results;
  if (!samples.length || samples.length > 16) throw new StorageCredentialUnavailableError();
  for (const sample of samples) {
    if (!keyring.keys.has(sample.key_id) || sample.envelope_version !== 1) throw new StorageCredentialUnavailableError();
    const value = await decryptStorageCredential(keyring, { profileId: sample.profile_id,
      configurationRevision: sample.configuration_revision, credentialRef: sample.credential_ref,
      namespaceSha256: sample.namespace_sha256 }, { version: 1, keyId: sample.key_id, nonce: sample.nonce, ciphertext: sample.ciphertext });
    if (value.outcome !== "available") throw new StorageCredentialUnavailableError();
    // No plaintext escapes this health check or enters response/log/persistence.
  }
  return { exists: true, checks: history.checks, hasProtected: true };
}

/** Composition hook for candidate writes. Missing/wrong roots cannot create a
 * new candidate that silently starts a second encryption lineage over history. */
export async function compatibleStorageCredentialKeyring(env: CredentialEnvironment,
  captured: StorageCredentialRootCapture = captureStorageCredentialRoot(env),
  onHistoryRead?: (history: { exists: boolean; checks: boolean; hasProtected: boolean }) => void): Promise<StorageCredentialKeyring> {
  const database = env.DB;
  if (!storageCredentialRootUnchanged(env, captured)) throw new StorageCredentialUnavailableError();
  const { keyring, source } = await resolveStorageCredentialRoot(captured);
  const history = await assertHistoryReadable(database, keyring, source === "legacy_keyring");
  if (env.DB !== database || !storageCredentialRootUnchanged(env, captured)) throw new StorageCredentialUnavailableError();
  onHistoryRead?.(history);
  return keyring;
}

export async function readStorageCredentialSetup(env: AdministratorEnvironment, actor: string): Promise<StorageCredentialSetupStatus> {
  assertSystemAdministrator(env, actor);
  const captured = captureStorageCredentialRoot(env), database = env.DB;
  const result = (state: StorageCredentialSetupState): StorageCredentialSetupStatus => {
    assertSystemAdministrator(env, actor);
    return { version: 1, runtime: "cloudflare_worker", state: env.DB === database
      && storageCredentialRootUnchanged(env, captured) ? state : "unavailable" };
  };
  const legacy = captured.STORAGE_CREDENTIAL_KEYRING !== undefined, seed = captured.INSTALLATION_SECRET_SEED !== undefined;
  if (legacy && seed) return result("configuration_conflict");
  try {
    const history = await retainedHistory(database);
    if (!legacy && !seed) return result(history.exists ? "restore_required" : "setup_required");
    try {
      await compatibleStorageCredentialKeyring(env, captured);
      return result(legacy ? "legacy_ready" : "seed_ready");
    } catch (error) { return result(error instanceof StorageCredentialUnavailableError ? "restore_required" : "unavailable"); }
  } catch { return result("unavailable"); }
}
