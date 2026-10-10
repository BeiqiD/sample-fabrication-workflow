import { checkedNativeStorageActivationInput, type NativeStorageActivationInput, type NativeStorageActivationReceipt } from "../../shared/contracts/storage-policy";
import { awsS3NativeNamespace, canonicalNativeS3Namespace } from "../../shared/contracts/storage-profile-admission";
import { checkedSaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { decryptStorageCredential, parseStorageCredentialKeyring } from "./credential-envelope";
import { assertSystemAdministrator } from "./system-administrator";

type ActivationEnvironment = Pick<Env, "DB" | "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS" | "STORAGE_CREDENTIAL_KEYRING">;
export class StoragePolicyError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); this.name = "StoragePolicyError"; }
}
export const storagePolicyUnavailable = () => new StoragePolicyError(503, "Storage policy is temporarily unavailable.");
export const storagePolicyConflict = () => new StoragePolicyError(409, "Storage policy or candidate changed. Refresh and try again.");
const COLUMNS = {
  profile_id: "p.id", latest_revision: "p.latest_revision", adapter_type: "p.adapter_type", physical_namespace: "p.namespace_json", namespace_sha256: "p.namespace_sha256",
  namespace_json: "r.namespace_json", credential_ref: "r.credential_ref", revision: "r.revision", descriptor_profile: "d.profile_id", descriptor_revision: "d.configuration_revision", descriptor_namespace: "d.namespace_sha256",
  envelope_revision: "e.envelope_revision", envelope_version: "e.envelope_version", key_id: "e.key_id", nonce: "e.nonce", ciphertext: "e.ciphertext",
  check_id: "c.id", check_revision: "c.configuration_revision", check_credential: "c.credential_ref", check_namespace: "c.namespace_json", check_namespace_sha256: "c.namespace_sha256",
  configuration_sha256: "c.configuration_sha256", check_envelope_revision: "c.envelope_revision", check_envelope_version: "c.envelope_version", check_key_id: "c.key_id", check_nonce: "c.nonce", check_ciphertext: "c.ciphertext",
  status: "c.status", write_outcome: "c.write_outcome", read_outcome: "c.read_outcome", metadata_outcome: "c.metadata_outcome", delete_outcome: "c.delete_outcome", cleanup_outcome: "c.cleanup_outcome", result_code: "c.result_code", completed_at: "c.completed_at",
  native_id: "n.id", native_namespace: "n.namespace_identity", native_revision: "n.configuration_revision", native_adapter: "n.adapter_type", native_source: "n.configuration_source", native_credential: "n.credential_reference", native_state: "n.state",
  runtime_state: "rt.state", runtime_registered: "rt.registered_at", runtime_activated: "rt.activated_at", runtime_retired: "rt.retired_at",
  binding_revision: "b.binding_revision", binding_operation: "b.activation_operation_id",
  activation_head: "(SELECT coalesce(max(head.binding_revision),0) FROM storage_profile_activations head WHERE head.storage_profile_id=n.id AND head.action='activate')",
} as const;
type Source = Record<keyof typeof COLUMNS, string | number | null>;
const SOURCE = `SELECT ${Object.entries(COLUMNS).map(([name, sql]) => `${sql} AS ${name}`).join(",")} FROM system_storage_profiles p
 JOIN system_storage_configuration_revisions r ON r.profile_id=p.id AND r.revision=p.latest_revision
 JOIN system_storage_credential_descriptors d ON d.credential_ref=r.credential_ref
 JOIN system_storage_credential_payloads e ON e.credential_ref=d.credential_ref
 JOIN system_storage_candidate_checks c ON c.profile_id=p.id AND c.id=?
 JOIN storage_profiles n ON n.id=? JOIN storage_profile_runtime rt ON rt.storage_profile_id=n.id
 LEFT JOIN system_storage_native_bindings b ON b.storage_profile_id=n.id WHERE p.id=?`;
function capturedConjunction(terms: readonly string[]): string {
  if (terms.length === 1) return terms[0];
  const middle = Math.floor(terms.length / 2);
  return `(${capturedConjunction(terms.slice(0, middle))} AND ${capturedConjunction(terms.slice(middle))})`;
}
// D1 limits expression depth. Keep every exact captured IS comparison and its
// original parameter order while balancing the conjunction's parse tree.
const GUARD = capturedConjunction(Object.values(COLUMNS).map(sql => `${sql} IS ?`));
const values = (row: Source) => Object.keys(COLUMNS).map(key => row[key as keyof Source]);
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
interface AuditRow {
  operation_id: string; storage_profile_id: string; configuration_revision: number; action: string;
  candidate_profile_id: string; candidate_revision: number; envelope_revision: number; check_id: string; binding_revision: number;
  configuration_sha256: string; namespace_sha256: string; actor: string; created_at: string; namespace_identity: string;
}
async function stored(database: D1Database, operationId: string): Promise<NativeStorageActivationReceipt | null> {
  const row = await primaryD1(database).prepare(`SELECT a.*,p.namespace_identity FROM storage_profile_activations a
    JOIN storage_profiles p ON p.id=a.storage_profile_id WHERE a.operation_id=?`).bind(operationId).first<AuditRow>();
  if (!row) return null;
  if (row.action !== "activate" || row.configuration_revision !== 1 || !Number.isSafeInteger(row.binding_revision) || row.binding_revision < 1
    || canonicalNativeS3Namespace(JSON.parse(row.namespace_identity)) !== row.namespace_identity
    || await digest(row.namespace_identity) !== row.namespace_sha256 || row.storage_profile_id !== `storage-profile:aws-s3:${row.namespace_sha256}`) throw storagePolicyUnavailable();
  return { operationId: row.operation_id, nativeProfileId: row.storage_profile_id, candidateProfileId: row.candidate_profile_id,
    candidateRevision: row.candidate_revision, envelopeRevision: row.envelope_revision, checkId: row.check_id,
    bindingRevision: row.binding_revision, createdAt: row.created_at, createdBy: row.actor };
}
function match(receipt: NativeStorageActivationReceipt, input: NativeStorageActivationInput): NativeStorageActivationReceipt {
  if (receipt.nativeProfileId !== input.nativeProfileId || receipt.candidateProfileId !== input.candidateProfileId
    || receipt.candidateRevision !== input.expectedCandidateRevision || receipt.envelopeRevision !== input.expectedEnvelopeRevision
    || receipt.checkId !== input.checkId || (input.expectedBindingRevision !== null && receipt.bindingRevision !== input.expectedBindingRevision + 1)) throw storagePolicyConflict();
  return receipt;
}
export async function readNativeStorageActivation(env: ActivationEnvironment, operationId: string, actor: string): Promise<NativeStorageActivationReceipt> {
  assertSystemAdministrator(env, actor);
  if (typeof operationId !== "string" || !operationId || operationId.length > 256 || operationId.includes("\0")) throw new StoragePolicyError(400, "Invalid activation identity.");
  try { const value = await stored(env.DB, operationId); if (!value) throw new StoragePolicyError(404, "Storage activation was not found."); return value; }
  catch (error) { if (error instanceof StoragePolicyError) throw error; throw storagePolicyUnavailable(); }
}

/** Activation binds an immutable physical profile to one exact tested local
 * candidate. It performs no provider I/O and never follows a candidate head on
 * subsequent reads. Credential changes require another explicit CAS activation. */
export async function activateNativeStorageProfile(env: ActivationEnvironment, raw: unknown, actor: string): Promise<NativeStorageActivationReceipt> {
  assertSystemAdministrator(env, actor);
  let input: NativeStorageActivationInput;
  try { input = checkedNativeStorageActivationInput(raw); } catch { throw new StoragePolicyError(400, "Invalid native storage activation."); }
  try {
    const previous = await stored(env.DB, input.operationId);
    if (previous) return match(previous, input);
    const capturedKeyring = env.STORAGE_CREDENTIAL_KEYRING, db = primaryD1(env.DB);
    const row = await db.prepare(SOURCE).bind(input.checkId, input.nativeProfileId, input.candidateProfileId).first<Source>();
    if (!row) throw new StoragePolicyError(404, "Registered storage profile or candidate check was not found.");
    if (row.latest_revision !== input.expectedCandidateRevision || row.revision !== input.expectedCandidateRevision
      || row.envelope_revision !== input.expectedEnvelopeRevision || row.binding_revision !== input.expectedBindingRevision
      || !Number.isSafeInteger(row.activation_head) || Number(row.activation_head) < 0
      || input.expectedBindingRevision !== null && row.activation_head !== input.expectedBindingRevision
      || !["read_only", "read_write"].includes(String(row.runtime_state)) || row.runtime_retired !== null) throw storagePolicyConflict();
    const ring = await parseStorageCredentialKeyring(capturedKeyring);
    if (ring.currentKeyId !== row.key_id) throw storagePolicyConflict();
    const opened = await decryptStorageCredential(ring, { profileId: input.candidateProfileId, configurationRevision: input.expectedCandidateRevision,
      credentialRef: String(row.credential_ref), namespaceSha256: String(row.namespace_sha256) },
    { version: row.envelope_version, keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext });
    if (opened.outcome !== "available") throw storagePolicyUnavailable();
    const checked = checkedSaveStorageCandidateInput({ expectedRevision: null, label: "Storage activation", namespace: JSON.parse(String(row.namespace_json)),
      credentials: { mode: "replace", value: JSON.parse(opened.plaintext) } });
    if (checked.namespace.kind !== "s3" || row.adapter_type !== "s3") throw storagePolicyConflict();
    const namespaceIdentity = awsS3NativeNamespace(checked.namespace), namespaceSha256 = await digest(namespaceIdentity);
    const physical = JSON.stringify({ kind: "s3", endpoint: checked.namespace.endpoint, bucket: checked.namespace.bucket, root: checked.namespace.root });
    if (JSON.stringify(checked.namespace) !== row.namespace_json || physical !== row.physical_namespace || await digest(physical) !== row.namespace_sha256
      || row.native_namespace !== namespaceIdentity || row.native_id !== `storage-profile:aws-s3:${namespaceSha256}`
      || row.native_adapter !== "s3" || row.native_source !== "system" || row.native_revision !== 1 || row.native_credential !== null || row.native_state !== "historical"
      || row.descriptor_profile !== input.candidateProfileId || row.descriptor_revision !== row.revision || row.descriptor_namespace !== row.namespace_sha256
      || row.configuration_sha256 !== await digest(String(row.namespace_json)) || row.check_revision !== row.revision || row.check_credential !== row.credential_ref
      || row.check_namespace !== row.namespace_json || row.check_namespace_sha256 !== row.namespace_sha256 || row.check_envelope_revision !== row.envelope_revision
      || row.check_envelope_version !== row.envelope_version || row.check_key_id !== row.key_id || row.check_nonce !== row.nonce || row.check_ciphertext !== row.ciphertext
      || row.status !== "succeeded" || row.write_outcome !== "acknowledged" || row.read_outcome !== "verified" || row.metadata_outcome !== "verified"
      || row.delete_outcome !== "acknowledged" || row.cleanup_outcome !== "confirmed_absent" || row.result_code !== null || !row.completed_at) throw storagePolicyConflict();
    assertSystemAdministrator(env, actor);
    if (env.STORAGE_CREDENTIAL_KEYRING !== capturedKeyring) throw storagePolicyConflict();
    const now = new Date().toISOString(), revision = Number(row.activation_head) + 1;
    if (!Number.isSafeInteger(revision)) throw storagePolicyConflict();
    try {
      await db.batch([
        db.prepare(`SELECT CASE WHEN EXISTS(${SOURCE} AND ${GUARD})
          AND NOT EXISTS(SELECT 1 FROM system_storage_candidate_checks WHERE profile_id=? AND (status='running' OR cleanup_outcome<>'confirmed_absent'))
          AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active')
          THEN 1 ELSE json('Storage activation source changed') END`).bind(input.checkId, input.nativeProfileId, input.candidateProfileId, ...values(row), input.candidateProfileId),
        db.prepare(`INSERT INTO storage_profile_activations(operation_id,storage_profile_id,configuration_revision,action,candidate_profile_id,candidate_revision,envelope_revision,
          check_id,configuration_sha256,namespace_sha256,binding_revision,actor,created_at) VALUES (?,?,1,'activate',?,?,?,?,?,?,?,?,?)`)
          .bind(input.operationId, input.nativeProfileId, input.candidateProfileId, input.expectedCandidateRevision, input.expectedEnvelopeRevision,
            input.checkId, row.configuration_sha256, namespaceSha256, revision, actor, now),
        input.expectedBindingRevision === null
          ? db.prepare(`INSERT INTO system_storage_native_bindings(storage_profile_id,candidate_profile_id,candidate_revision,credential_ref,envelope_revision,check_id,
              configuration_sha256,namespace_sha256,activation_operation_id,binding_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(input.nativeProfileId, input.candidateProfileId, input.expectedCandidateRevision, row.credential_ref, input.expectedEnvelopeRevision, input.checkId,
              row.configuration_sha256, namespaceSha256, input.operationId, revision, now, now)
          : db.prepare(`UPDATE system_storage_native_bindings SET candidate_profile_id=?,candidate_revision=?,credential_ref=?,envelope_revision=?,check_id=?,
              configuration_sha256=?,namespace_sha256=?,activation_operation_id=?,binding_revision=?,updated_at=? WHERE storage_profile_id=? AND binding_revision=?`)
            .bind(input.candidateProfileId, input.expectedCandidateRevision, row.credential_ref, input.expectedEnvelopeRevision, input.checkId,
              row.configuration_sha256, namespaceSha256, input.operationId, revision, now, input.nativeProfileId, input.expectedBindingRevision),
        db.prepare(`UPDATE storage_profile_runtime SET state='read_write',activated_at=?,retired_at=NULL WHERE storage_profile_id=? AND state IN ('read_only','read_write')`)
          .bind(now, input.nativeProfileId),
        db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_storage_native_bindings b JOIN storage_profile_runtime r ON r.storage_profile_id=b.storage_profile_id
          WHERE b.storage_profile_id=? AND b.activation_operation_id=? AND b.binding_revision=? AND r.state='read_write' AND r.activated_at=?)
          THEN 1 ELSE json('Storage activation did not commit') END`).bind(input.nativeProfileId, input.operationId, revision, now),
      ]);
    } catch {
      const committed = await stored(env.DB, input.operationId);
      if (committed) return match(committed, input);
      throw storagePolicyConflict();
    }
    const committed = await stored(env.DB, input.operationId);
    if (!committed) throw storagePolicyUnavailable();
    return match(committed, input);
  } catch (error) { if (error instanceof StoragePolicyError) throw error; throw storagePolicyUnavailable(); }
}
