import { checkedStorageCandidateReadinessInput } from "../../shared/contracts/storage-candidate-readiness";
import { checkedExternalStorageNamespace, checkedSaveStorageCandidateInput, type S3StorageNamespace } from "../../shared/contracts/storage-configuration";
import { awsS3NativeNamespace, canonicalNativeS3Namespace, checkedStorageProfileAdmissionInput,
  checkedStorageProfileAdmissionOperationId, checkedStorageProfileAdmissionReceipt,
  type StorageProfileAdmissionInput, type StorageProfileAdmissionReceipt } from "../../shared/contracts/storage-profile-admission";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { decryptStorageCredential, parseStorageCredentialKeyring } from "./credential-envelope";
import { assertSystemAdministrator } from "./system-administrator";

type AdmissionEnvironment = Pick<Env, "DB" | "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS" | "STORAGE_CREDENTIAL_KEYRING">;
export class StorageProfileAdmissionError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); this.name = "StorageProfileAdmissionError"; }
}
const unavailable = () => new StorageProfileAdmissionError(503, "Storage profile registration is temporarily unavailable.");
const conflict = () => new StorageProfileAdmissionError(409, "Storage candidate or registration changed. Refresh and try again.");
const missing = () => new StorageProfileAdmissionError(404, "Storage profile registration was not found.");
const invalid = () => new StorageProfileAdmissionError(400, "Invalid storage profile registration.");
const encoder = new TextEncoder();
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

// Every field used to authenticate or classify the candidate is checked again
// inside the publication transaction, including a missing protected payload.
const SOURCE_COLUMNS = {
  profile_id: "p.id", adapter_type: "p.adapter_type", physical_namespace_json: "p.namespace_json",
  namespace_sha256: "p.namespace_sha256", latest_revision: "p.latest_revision", profile_created_at: "p.created_at",
  revision: "r.revision", namespace_json: "r.namespace_json", credential_ref: "r.credential_ref",
  label: "r.label", configuration_created_at: "r.created_at", configuration_created_by: "r.created_by",
  descriptor_ref: "d.credential_ref", descriptor_profile_id: "d.profile_id", descriptor_revision: "d.configuration_revision",
  descriptor_namespace_sha256: "d.namespace_sha256", descriptor_created_at: "d.created_at",
  payload_ref: "e.credential_ref", envelope_revision: "e.envelope_revision", envelope_version: "e.envelope_version",
  key_id: "e.key_id", nonce: "e.nonce", ciphertext: "e.ciphertext",
} as const;
interface SourceRow {
  profile_id: string; adapter_type: string; physical_namespace_json: string; namespace_sha256: string;
  latest_revision: number; profile_created_at: string; revision: number | null; namespace_json: string | null;
  credential_ref: string | null; label: string | null; configuration_created_at: string | null; configuration_created_by: string | null;
  descriptor_ref: string | null; descriptor_profile_id: string | null; descriptor_revision: number | null;
  descriptor_namespace_sha256: string | null; descriptor_created_at: string | null;
  payload_ref: string | null; envelope_revision: number | null; envelope_version: number | null;
  key_id: string | null; nonce: string | null; ciphertext: string | null;
}
const SOURCE_SELECT = `SELECT ${Object.entries(SOURCE_COLUMNS).map(([key, column]) => `${column} AS ${key}`).join(",")}
  FROM system_storage_profiles p
  LEFT JOIN system_storage_configuration_revisions r ON r.profile_id=p.id AND r.revision=p.latest_revision
  LEFT JOIN system_storage_credential_descriptors d ON d.credential_ref=r.credential_ref
    AND d.profile_id=r.profile_id AND d.configuration_revision=r.revision AND d.namespace_sha256=p.namespace_sha256
  LEFT JOIN system_storage_credential_payloads e ON e.credential_ref=d.credential_ref WHERE p.id=?`;
const SOURCE_GUARD = Object.values(SOURCE_COLUMNS).map(column => `${column} IS ?`).join(" AND ");
const sourceValues = (row: SourceRow) => Object.keys(SOURCE_COLUMNS).map(key => row[key as keyof SourceRow]);
const CHECK_COLUMNS = ["id", "profile_id", "configuration_revision", "credential_ref", "envelope_revision", "namespace_json",
  "namespace_sha256", "configuration_sha256", "envelope_version", "key_id", "nonce", "ciphertext", "status", "write_outcome",
  "read_outcome", "metadata_outcome", "delete_outcome", "cleanup_outcome", "result_code", "completed_at"] as const;
type CheckRow = Record<typeof CHECK_COLUMNS[number], string | number | null>;
const SUCCESS = `status='succeeded' AND write_outcome='acknowledged' AND read_outcome='verified' AND metadata_outcome='verified'
  AND delete_outcome='acknowledged' AND cleanup_outcome='confirmed_absent' AND result_code IS NULL AND completed_at IS NOT NULL`;
const CLEAR_HISTORY = `NOT EXISTS(SELECT 1 FROM system_storage_candidate_checks h
  WHERE h.profile_id=s.profile_id AND (h.status='running' OR h.cleanup_outcome<>'confirmed_absent'))`;

interface AdmissionRow {
  operation_id: string; native_profile_id: string; candidate_profile_id: string; candidate_revision: number;
  envelope_revision: number; check_id: string; configuration_sha256: string; namespace_sha256: string; actor: string; created_at: string;
  namespace_identity: string; adapter_type: string; configuration_source: string; credential_reference: string | null;
  configuration_revision: number; state: string; profile_created_at: string; runtime_access: string;
}
const ADMISSION_SELECT = `SELECT a.*,p.namespace_identity,p.adapter_type,p.configuration_source,p.credential_reference,
  p.configuration_revision,p.state,p.created_at AS profile_created_at,r.state AS runtime_access
  FROM storage_profile_admissions a JOIN storage_profiles p ON p.id=a.native_profile_id
  JOIN storage_profile_runtime r ON r.storage_profile_id=p.id`;
async function receipt(row: AdmissionRow): Promise<StorageProfileAdmissionReceipt> {
  const namespace = canonicalNativeS3Namespace(JSON.parse(row.namespace_identity));
  if (namespace !== row.namespace_identity || await digest(namespace) !== row.namespace_sha256
    || row.native_profile_id !== `storage-profile:aws-s3:${row.namespace_sha256}` || row.adapter_type !== "s3"
    || row.configuration_source !== "system" || row.credential_reference !== null || row.configuration_revision !== 1
    || row.state !== "historical" || row.runtime_access !== "read_only" || row.profile_created_at !== row.created_at
    || !/^[0-9a-f]{64}$/.test(row.configuration_sha256)) throw unavailable();
  return checkedStorageProfileAdmissionReceipt({ operationId: row.operation_id, profileId: row.candidate_profile_id,
    revision: row.candidate_revision, envelopeRevision: row.envelope_revision, checkId: row.check_id,
    nativeProfileId: row.native_profile_id, configurationRevision: 1, runtimeAccess: "read_only", createdAt: row.created_at, createdBy: row.actor });
}
async function storedReceipt(env: AdmissionEnvironment, operationId: string): Promise<StorageProfileAdmissionReceipt | null> {
  const row = await primaryD1(env.DB).prepare(`${ADMISSION_SELECT} WHERE a.operation_id=?`).bind(operationId).first<AdmissionRow>();
  return row ? receipt(row) : null;
}
function matchingReceipt(value: StorageProfileAdmissionReceipt, input: StorageProfileAdmissionInput): StorageProfileAdmissionReceipt {
  if (value.profileId !== input.profileId || value.revision !== input.expectedRevision || value.envelopeRevision !== input.expectedEnvelopeRevision
    || value.checkId !== input.checkId) throw conflict();
  return value;
}
async function currentSource(env: AdmissionEnvironment, profileId: string, revision: number): Promise<SourceRow> {
  const source = await primaryD1(env.DB).prepare(SOURCE_SELECT).bind(profileId).first<SourceRow>();
  if (!source) throw new StorageProfileAdmissionError(404, "Storage candidate was not found.");
  if (source.latest_revision !== revision) throw conflict();
  if (source.revision !== revision || !source.namespace_json || !source.credential_ref || source.descriptor_ref !== source.credential_ref) throw unavailable();
  return source;
}
async function parsedNamespace(source: SourceRow): Promise<S3StorageNamespace> {
  const namespace = checkedExternalStorageNamespace(JSON.parse(source.namespace_json!));
  if (source.adapter_type !== "s3" || namespace.kind !== "s3") throw new StorageProfileAdmissionError(400, "Only qualified AWS S3 candidates can be registered.");
  const physical = JSON.stringify({ kind: "s3", endpoint: namespace.endpoint, bucket: namespace.bucket, root: namespace.root });
  if (JSON.stringify(namespace) !== source.namespace_json || physical !== source.physical_namespace_json
    || await digest(physical) !== source.namespace_sha256) throw unavailable();
  return namespace;
}

/** Replays survive candidate edits, credential maintenance and portable restore.
 * This path reads only the immutable portable receipt and native identity. */
export async function readStorageProfileAdmission(env: AdmissionEnvironment, rawOperationId: unknown, actor: string): Promise<StorageProfileAdmissionReceipt> {
  assertSystemAdministrator(env, actor);
  let operationId: string;
  try { operationId = checkedStorageProfileAdmissionOperationId(rawOperationId); } catch { throw invalid(); }
  try { const value = await storedReceipt(env, operationId); if (!value) throw missing(); return value; }
  catch (error) { if (error instanceof StorageProfileAdmissionError) throw error; throw unavailable(); }
}

/** Locate an already registered physical namespace after a page reload. The
 * returned receipt describes its original admission, not current check health. */
export async function findStorageProfileAdmission(env: AdmissionEnvironment, rawInput: unknown, actor: string): Promise<StorageProfileAdmissionReceipt> {
  assertSystemAdministrator(env, actor);
  let input;
  try { input = checkedStorageCandidateReadinessInput(rawInput); } catch { throw invalid(); }
  try {
    const source = await currentSource(env, input.profileId, input.expectedRevision);
    const namespace = await parsedNamespace(source);
    let identity: string;
    try { identity = awsS3NativeNamespace(namespace); } catch { throw missing(); }
    const snapshot = await primaryD1(env.DB).prepare(`WITH source AS (${SOURCE_SELECT} AND ${SOURCE_GUARD}),
      admitted AS (${ADMISSION_SELECT} WHERE p.namespace_identity=?)
      SELECT (SELECT json_object(${["operation_id", "native_profile_id", "candidate_profile_id", "candidate_revision", "envelope_revision", "check_id",
        "configuration_sha256", "namespace_sha256", "actor", "created_at", "namespace_identity", "adapter_type", "configuration_source", "credential_reference",
        "configuration_revision", "state", "profile_created_at", "runtime_access"].map(name => `'${name}',${name}`).join(",")} ) FROM admitted) AS admission_json FROM source`)
      .bind(input.profileId, ...sourceValues(source), identity).first<{ admission_json: string | null }>();
    if (!snapshot) throw conflict();
    if (!snapshot.admission_json) throw missing();
    return await receipt(JSON.parse(snapshot.admission_json));
  } catch (error) { if (error instanceof StorageProfileAdmissionError) throw error; throw unavailable(); }
}

/** Register identity only. A successful check, current authenticated wrapping
 * and qualified AWS owner are fenced in the same transaction as both portable
 * rows. No provider access, role default, File location or write admission. */
export async function registerStorageProfile(env: AdmissionEnvironment, rawInput: unknown, actor: string): Promise<StorageProfileAdmissionReceipt> {
  assertSystemAdministrator(env, actor);
  let input: StorageProfileAdmissionInput;
  try { input = checkedStorageProfileAdmissionInput(rawInput); } catch { throw invalid(); }
  try {
    const prior = await storedReceipt(env, input.operationId);
    if (prior) return matchingReceipt(prior, input);
    const source = await currentSource(env, input.profileId, input.expectedRevision), namespace = await parsedNamespace(source);
    let namespaceIdentity: string;
    try { namespaceIdentity = awsS3NativeNamespace(namespace); }
    catch { throw new StorageProfileAdmissionError(400, "Registration requires a qualified commercial AWS S3 bucket owner."); }
    if (source.envelope_revision !== input.expectedEnvelopeRevision) throw conflict();
    const keys = await parseStorageCredentialKeyring(env.STORAGE_CREDENTIAL_KEYRING);
    if (source.key_id !== keys.currentKeyId) throw new StorageProfileAdmissionError(409, "Re-envelope the candidate credentials and run a new check before registration.");
    const opened = await decryptStorageCredential(keys, { profileId: source.profile_id, configurationRevision: input.expectedRevision,
      credentialRef: source.credential_ref!, namespaceSha256: source.namespace_sha256 },
    { version: source.envelope_version, keyId: source.key_id, nonce: source.nonce, ciphertext: source.ciphertext });
    if (opened.outcome !== "available") throw unavailable();
    checkedSaveStorageCandidateInput({ expectedRevision: null, label: "Native registration", namespace,
      credentials: { mode: "replace", value: JSON.parse(opened.plaintext) } });
    const configurationSha256 = await digest(source.namespace_json!), namespaceSha256 = await digest(namespaceIdentity);
    const nativeProfileId = `storage-profile:aws-s3:${namespaceSha256}`;
    const check = await primaryD1(env.DB).prepare(`SELECT ${CHECK_COLUMNS.join(",")} FROM system_storage_candidate_checks WHERE id=?`)
      .bind(input.checkId).first<CheckRow>();
    if (!check) throw new StorageProfileAdmissionError(404, "Storage candidate check was not found.");
    const expected = { profile_id: source.profile_id, configuration_revision: source.revision, credential_ref: source.credential_ref,
      envelope_revision: source.envelope_revision, namespace_json: source.namespace_json, namespace_sha256: source.namespace_sha256,
      configuration_sha256: configurationSha256, envelope_version: source.envelope_version, key_id: source.key_id, nonce: source.nonce, ciphertext: source.ciphertext,
      status: "succeeded", write_outcome: "acknowledged", read_outcome: "verified", metadata_outcome: "verified", delete_outcome: "acknowledged",
      cleanup_outcome: "confirmed_absent", result_code: null };
    if (!check.completed_at || Object.entries(expected).some(([name, value]) => check[name as keyof CheckRow] !== value)) throw conflict();
    const createdAt = new Date().toISOString();
    try {
      await env.DB.batch([
        // A lost source/check CAS produces a NULL primary key and aborts the
        // entire batch. Trigger-created runtime/registry rows roll back too.
        env.DB.prepare(`INSERT INTO storage_profiles
          (id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
          VALUES ((SELECT ? FROM (${SOURCE_SELECT} AND ${SOURCE_GUARD}) s
            WHERE EXISTS(SELECT 1 FROM system_storage_candidate_checks c WHERE ${CHECK_COLUMNS.map(name => `c.${name} IS ?`).join(" AND ")} AND ${SUCCESS})
              AND ${CLEAR_HISTORY}), 's3',?,'system',NULL,1,'historical',?)`)
          .bind(nativeProfileId, input.profileId, ...sourceValues(source), ...CHECK_COLUMNS.map(name => check[name]), namespaceIdentity, createdAt),
        env.DB.prepare(`INSERT INTO storage_profile_admissions
          (operation_id,native_profile_id,candidate_profile_id,candidate_revision,envelope_revision,check_id,configuration_sha256,namespace_sha256,actor,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(input.operationId, nativeProfileId, input.profileId, input.expectedRevision,
          input.expectedEnvelopeRevision, input.checkId, configurationSha256, namespaceSha256, actor, createdAt),
      ]);
    } catch (error) {
      const committed = await storedReceipt(env, input.operationId);
      if (committed) return matchingReceipt(committed, input);
      const message = error instanceof Error ? error.message : "";
      if (message.includes("NOT NULL constraint failed: storage_profiles.id") || message.includes("FP1 immutable identity conflict")
        || message.includes("Native profile admission is immutable")
        || message.includes("UNIQUE constraint failed: storage_profiles") || message.includes("UNIQUE constraint failed: storage_profile_admissions")) throw conflict();
      throw unavailable();
    }
    const committed = await storedReceipt(env, input.operationId);
    if (!committed) throw unavailable();
    return matchingReceipt(committed, input);
  } catch (error) { if (error instanceof StorageProfileAdmissionError) throw error; throw unavailable(); }
}
