import { checkedExternalStorageNamespace, checkedSaveStorageCandidateInput, MAX_STORAGE_CANDIDATES, StorageConfigurationInputError,
  type ExternalStorageNamespace, type SaveStorageCandidateInput, type StorageCandidate, type StorageConfigurationStatus } from "../../shared/contracts/storage-configuration";
import type { Env } from "../types";
import { decryptStorageCredential, encryptStorageCredential, parseStorageCredentialKeyring,
  type StorageCredentialEnvelope, type StorageCredentialIdentity, type StorageCredentialKeyring } from "./credential-envelope";
import { assertSystemAdministrator } from "./system-administrator";

type ConfigurationEnvironment = Pick<Env, "DB" | "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS" | "STORAGE_CREDENTIAL_KEYRING">;
export class StorageConfigurationError extends Error {
  constructor(readonly status: 400 | 409 | 503, message: string) { super(message); this.name = "StorageConfigurationError"; }
}
const conflict = () => new StorageConfigurationError(409, "Storage candidate changed. Refresh and try again.");
const unavailable = () => new StorageConfigurationError(503, "Storage configuration is temporarily unavailable.");
const credentialUnavailable = () => new StorageConfigurationError(503, "Storage credential encryption is unavailable.");
interface CandidateRow {
  profile_id: string;
  revision: number;
  label: string;
  namespace_json: string;
  namespace_sha256: string;
  credential_ref: string;
  created_at: string;
  created_by: string;
  envelope_version: 1 | null;
  key_id: string | null;
  nonce: string | null;
  ciphertext: string | null;
}
const CANDIDATE_SELECT = `SELECT r.profile_id,r.revision,r.label,r.namespace_json,p.namespace_sha256,
  r.credential_ref,r.created_at,r.created_by,e.envelope_version,e.key_id,e.nonce,e.ciphertext
  FROM system_storage_profiles p
  JOIN system_storage_configuration_revisions r ON r.profile_id = p.id AND r.revision = p.latest_revision
  LEFT JOIN system_storage_credential_payloads e ON e.credential_ref = r.credential_ref`;

/** Metadata is not a provider capability check. Physical identity excludes S3
 * transport settings so region/path-style correction cannot reinterpret keys. */
function physicalNamespace(namespace: ExternalStorageNamespace): string {
  return JSON.stringify(namespace.kind === "s3"
    ? { kind: namespace.kind, endpoint: namespace.endpoint, bucket: namespace.bucket, root: namespace.root }
    : { kind: namespace.kind, endpoint: namespace.endpoint, root: namespace.root });
}
async function namespaceDigest(namespace: ExternalStorageNamespace): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(physicalNamespace(namespace)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function identity(row: CandidateRow): StorageCredentialIdentity {
  return { profileId: row.profile_id, configurationRevision: row.revision, credentialRef: row.credential_ref, namespaceSha256: row.namespace_sha256 };
}
function envelope(row: CandidateRow): StorageCredentialEnvelope | null {
  return row.envelope_version === 1 && row.key_id && row.nonce && row.ciphertext
    ? { version: 1, keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext } : null;
}
async function maybeKeyring(env: ConfigurationEnvironment): Promise<StorageCredentialKeyring | null> {
  try { return await parseStorageCredentialKeyring(env.STORAGE_CREDENTIAL_KEYRING); } catch { return null; }
}
export async function storageCredentialEditingAvailable(env: ConfigurationEnvironment): Promise<boolean> {
  return !!await maybeKeyring(env);
}
async function candidate(row: CandidateRow, keyring: StorageCredentialKeyring | null): Promise<StorageCandidate> {
  const stored = envelope(row);
  const readable = keyring && stored ? await decryptStorageCredential(keyring, identity(row), stored) : { outcome: "unavailable" as const };
  // Only status leaves this service. Unavailable envelopes remain unchanged.
  return { profileId: row.profile_id, revision: row.revision, label: row.label, namespace: checkedExternalStorageNamespace(JSON.parse(row.namespace_json)),
    credentials: { status: readable.outcome === "available" ? "configured" : "unavailable", ref: row.credential_ref },
    createdAt: row.created_at, createdBy: row.created_by };
}

/** Independently enforced here as well as at the HTTP route boundary. These
 * operations remain separate from paused File execution and never call storage. */
export async function readStorageConfiguration(env: ConfigurationEnvironment, actor: string): Promise<StorageConfigurationStatus> {
  assertSystemAdministrator(env, actor);
  try {
    const keyring = await maybeKeyring(env);
    const result = await env.DB.prepare(`${CANDIDATE_SELECT} ORDER BY r.created_at DESC,r.profile_id LIMIT ?`).bind(MAX_STORAGE_CANDIDATES + 1).all<CandidateRow>();
    return { scope: "system", credentialEditingAvailable: !!keyring,
      candidates: { items: await Promise.all(result.results.slice(0, MAX_STORAGE_CANDIDATES).map(row => candidate(row, keyring))), hasMore: result.results.length > MAX_STORAGE_CANDIDATES } };
  } catch { throw unavailable(); }
}

export async function saveStorageCandidate(env: ConfigurationEnvironment, raw: unknown, actor: string): Promise<StorageCandidate> {
  assertSystemAdministrator(env, actor);
  let input: SaveStorageCandidateInput;
  try { input = checkedSaveStorageCandidateInput(raw); }
  catch (error) { if (error instanceof StorageConfigurationInputError) throw new StorageConfigurationError(400, error.message); throw unavailable(); }
  const keyring = await maybeKeyring(env);
  if (!keyring) throw credentialUnavailable();
  const revision = input.expectedRevision === null ? 1 : input.expectedRevision + 1;
  if (!Number.isSafeInteger(revision)) throw new StorageConfigurationError(400, "Invalid storage configuration.");
  const profileId = input.profileId ?? `external:${crypto.randomUUID()}`, credentialRef = `credential:${crypto.randomUUID()}`;
  const namespaceSha256 = await namespaceDigest(input.namespace), now = new Date().toISOString();
  let previous: CandidateRow | null = null;
  try {
    if (input.expectedRevision !== null) {
      previous = await env.DB.prepare(`${CANDIDATE_SELECT} WHERE p.id = ?`).bind(profileId).first<CandidateRow>();
      if (!previous || previous.revision !== input.expectedRevision) throw conflict();
      if (previous.namespace_sha256 !== namespaceSha256)
        throw new StorageConfigurationError(409, "Changing the physical namespace requires a new storage profile.");
    }
    let plaintext: string;
    if (input.credentials.mode === "replace") plaintext = JSON.stringify(input.credentials.value);
    else {
      const stored = previous && envelope(previous);
      if (!previous || !stored) throw credentialUnavailable();
      const opened = await decryptStorageCredential(keyring, identity(previous), stored);
      if (opened.outcome !== "available") throw credentialUnavailable();
      plaintext = opened.plaintext;
    }
    // Retaining credentials still seals a new descriptor against this exact new
    // revision; copying an old ciphertext would fail its authenticated context.
    const sealed = await encryptStorageCredential(keyring, { profileId, configurationRevision: revision, credentialRef, namespaceSha256 }, plaintext);
    const statements: D1PreparedStatement[] = [];
    if (input.expectedRevision === null) statements.push(env.DB.prepare(`INSERT INTO system_storage_profiles
      (id,adapter_type,namespace_json,namespace_sha256,latest_revision,created_at) VALUES (?,?,?,?,0,?)`)
      .bind(profileId, input.namespace.kind, physicalNamespace(input.namespace), namespaceSha256, now));
    statements.push(
      env.DB.prepare(`INSERT INTO system_storage_credential_descriptors
        (credential_ref,profile_id,configuration_revision,namespace_sha256,created_at) VALUES (?,?,?,?,?)`)
        .bind(credentialRef, profileId, revision, namespaceSha256, now),
      env.DB.prepare(`INSERT INTO system_storage_credential_payloads
        (credential_ref,envelope_revision,envelope_version,key_id,nonce,ciphertext) VALUES (?,1,?,?,?,?)`)
        .bind(credentialRef, sealed.version, sealed.keyId, sealed.nonce, sealed.ciphertext),
      env.DB.prepare(`INSERT INTO system_storage_configuration_revisions
        (profile_id,revision,label,namespace_json,credential_ref,created_at,created_by) VALUES (?,?,?,?,?,?,?)`)
        .bind(profileId, revision, input.label, JSON.stringify(input.namespace), credentialRef, now, actor),
      env.DB.prepare(`INSERT INTO system_storage_configuration_audit
        (id,profile_id,configuration_revision,actor,operation,outcome,created_at) VALUES (?,?,?,?,?,'saved',?)`)
        .bind(crypto.randomUUID(), profileId, revision, actor, input.expectedRevision === null ? "candidate_create" : "candidate_revise", now),
    );
    // Revision trigger performs the final CAS inside D1's single batch
    // transaction. A stale concurrent writer rolls back its descriptor/payload.
    await env.DB.batch(statements);
    return { profileId, revision, label: input.label, namespace: input.namespace,
      credentials: { status: "configured", ref: credentialRef }, createdAt: now, createdBy: actor };
  } catch (error) {
    if (error instanceof StorageConfigurationError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("FP2 candidate revision conflict") || message.includes("UNIQUE constraint failed: system_storage_")) throw conflict();
    throw unavailable();
  }
}
