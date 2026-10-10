import { checkedExternalStorageNamespace, checkedSaveStorageCandidateInput, MAX_STORAGE_CANDIDATES, StorageConfigurationInputError,
  type ExternalStorageNamespace, type SaveStorageCandidateInput, type StorageCandidate, type StorageConfigurationStatus } from "../../shared/contracts/storage-configuration";
import { HTTPException } from "hono/http-exception";
import { configurationSqlInteger, type ConfigurationSqlDatabase, type ConfigurationSqlRow, type ConfigurationSqlStatement } from "../runtime/configuration-sql";
import { decryptStorageCredential, encryptStorageCredential,
  type StorageCredentialEnvelope, type StorageCredentialIdentity, type StorageCredentialKeyring } from "./credential-envelope";
export interface StorageConfigurationCapabilities {
  database(): ConfigurationSqlDatabase;
  authorizeAdministrator(actor: string): boolean | Promise<boolean>;
  keyring(): Promise<StorageCredentialKeyring>;
}
export class StorageConfigurationError extends Error {
  readonly status: 400 | 409 | 503;
  constructor(status: 400 | 409 | 503, message: string) { super(message); this.status = status; this.name = "StorageConfigurationError"; }
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
  envelope_version: number | null;
  key_id: string | null;
  nonce: string | null;
  ciphertext: string | null;
}
function candidateRow(row: ConfigurationSqlRow): CandidateRow {
  const text = (field: string): string => {
    const value = row[field];
    if (typeof value !== "string") throw new TypeError(`Invalid storage column: ${field}`);
    return value;
  };
  const nullableText = (field: string) => row[field] === null ? null : text(field);
  return { profile_id: text("profile_id"), revision: configurationSqlInteger(row.revision, "candidate revision", 1),
    label: text("label"), namespace_json: text("namespace_json"), namespace_sha256: text("namespace_sha256"),
    credential_ref: text("credential_ref"), created_at: text("created_at"), created_by: text("created_by"),
    envelope_version: row.envelope_version === null ? null : configurationSqlInteger(row.envelope_version, "envelope version", 1),
    key_id: nullableText("key_id"), nonce: nullableText("nonce"), ciphertext: nullableText("ciphertext") };
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

async function candidate(row: CandidateRow, keyring: StorageCredentialKeyring | null): Promise<StorageCandidate> {
  const stored = envelope(row);
  const readable = keyring && stored ? await decryptStorageCredential(keyring, identity(row), stored) : { outcome: "unavailable" as const };
  // Only status leaves this service. Unavailable envelopes remain unchanged.
  return { profileId: row.profile_id, revision: row.revision, label: row.label, namespace: checkedExternalStorageNamespace(JSON.parse(row.namespace_json)),
    credentials: { status: readable.outcome === "available" ? "configured" : "unavailable", ref: row.credential_ref },
    createdAt: row.created_at, createdBy: row.created_by };
}

class AdministratorDenied extends HTTPException {
  constructor() { super(403, { message: "System administrator access is required." }); }
}
/** Services independently recheck current administrator grants. SQL and keyring
 * getters are trusted capabilities selected after authorization, never Env. */
export function createStorageConfigurationRegistry(capabilities: StorageConfigurationCapabilities) {
  const assertAdministrator = async (actor: string) => {
    let allowed = false;
    try { allowed = await capabilities.authorizeAdministrator(actor) === true; } catch { /* Fail closed. */ }
    if (!allowed) throw new AdministratorDenied();
  };
  const maybeKeyring = async (): Promise<StorageCredentialKeyring | null> => {
    try { return await capabilities.keyring(); } catch { return null; }
  };
  const storageCredentialEditingAvailable = async () => !!await maybeKeyring();
  /** Independently enforced here as well as at the HTTP route boundary. These
   * operations remain separate from paused File execution and never call storage. */
  async function readStorageConfiguration(actor: string): Promise<StorageConfigurationStatus> {
    await assertAdministrator(actor);
    try {
      const keyring = await maybeKeyring();
      const result = await capabilities.database().primary().prepare(`${CANDIDATE_SELECT} ORDER BY r.created_at DESC,r.profile_id LIMIT ?`).bind(MAX_STORAGE_CANDIDATES + 1).all();
      return { scope: "system", credentialEditingAvailable: !!keyring,
        candidates: { items: await Promise.all(result.results.slice(0, MAX_STORAGE_CANDIDATES).map(row => candidate(candidateRow(row), keyring))), hasMore: result.results.length > MAX_STORAGE_CANDIDATES } };
    } catch { throw unavailable(); }
  }

  async function saveStorageCandidate(raw: unknown, actor: string): Promise<StorageCandidate> {
    await assertAdministrator(actor);
    let input: SaveStorageCandidateInput;
    try { input = checkedSaveStorageCandidateInput(raw); }
    catch (error) { if (error instanceof StorageConfigurationInputError) throw new StorageConfigurationError(400, error.message); throw unavailable(); }
    const keyring = await maybeKeyring();
    if (!keyring) throw credentialUnavailable();
    const revision = input.expectedRevision === null ? 1 : input.expectedRevision + 1;
    if (!Number.isSafeInteger(revision)) throw new StorageConfigurationError(400, "Invalid storage configuration.");
    const profileId = input.profileId ?? `external:${crypto.randomUUID()}`, credentialRef = `credential:${crypto.randomUUID()}`;
    const namespaceSha256 = await namespaceDigest(input.namespace), now = new Date().toISOString();
    let previous: CandidateRow | null = null;
    try {
      const db = capabilities.database().primary();
      if (input.expectedRevision !== null) {
        const row = await db.prepare(`${CANDIDATE_SELECT} WHERE p.id = ?`).bind(profileId).first();
        previous = row === null ? null : candidateRow(row);
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
      const auditId = crypto.randomUUID(), operation = input.expectedRevision === null ? "candidate_create" : "candidate_revise";
      const statements: ConfigurationSqlStatement[] = [];
      if (input.expectedRevision === null) statements.push(db.prepare(`INSERT INTO system_storage_profiles
        (id,adapter_type,namespace_json,namespace_sha256,latest_revision,created_at) VALUES (?,?,?,?,0,?)`)
        .bind(profileId, input.namespace.kind, physicalNamespace(input.namespace), namespaceSha256, now));
      statements.push(
        db.prepare(`INSERT INTO system_storage_credential_descriptors
          (credential_ref,profile_id,configuration_revision,namespace_sha256,created_at) VALUES (?,?,?,?,?)`)
          .bind(credentialRef, profileId, revision, namespaceSha256, now),
        db.prepare(`INSERT INTO system_storage_credential_payloads
          (credential_ref,envelope_revision,envelope_version,key_id,nonce,ciphertext) VALUES (?,1,?,?,?,?)`)
          .bind(credentialRef, sealed.version, sealed.keyId, sealed.nonce, sealed.ciphertext),
        db.prepare(`INSERT INTO system_storage_configuration_revisions
          (profile_id,revision,label,namespace_json,credential_ref,created_at,created_by) VALUES (?,?,?,?,?,?,?)`)
          .bind(profileId, revision, input.label, JSON.stringify(input.namespace), credentialRef, now, actor),
        db.prepare(`INSERT INTO system_storage_configuration_audit
          (id,profile_id,configuration_revision,actor,operation,outcome,created_at) VALUES (?,?,?,?,?,'saved',?)`)
          .bind(auditId, profileId, revision, actor, operation, now),
      );
      // Revision trigger performs the final CAS inside the atomic batch.
      // A stale concurrent writer rolls back its descriptor/payload and audit.
      await assertAdministrator(actor);
      try {
        const result = await db.batch(statements);
        if (result.length !== statements.length || result.some(item => item.directChanges !== 1)) {
          throw new Error("Incomplete storage configuration batch acknowledgement");
        }
      } catch (error) {
        await assertAdministrator(actor);
        let committed = false;
        try {
          // ACK loss is settled only by this attempt's exact immutable revision,
          // credential identity and audit, plus its original sealed payload.
          // A different winning writer or partial/unavailable state cannot qualify.
          const receipt = await capabilities.database().primary().prepare(`SELECT 1 AS committed
            FROM system_storage_configuration_revisions r
            JOIN system_storage_profiles p ON p.id=r.profile_id AND p.latest_revision>=r.revision
            JOIN system_storage_credential_descriptors d ON d.credential_ref=r.credential_ref
              AND d.profile_id=r.profile_id AND d.configuration_revision=r.revision AND d.namespace_sha256=p.namespace_sha256
            JOIN system_storage_credential_payloads e ON e.credential_ref=d.credential_ref
            JOIN system_storage_configuration_audit a ON a.profile_id=r.profile_id AND a.configuration_revision=r.revision
            WHERE r.profile_id=? AND r.revision=? AND r.credential_ref=? AND r.label=? AND r.namespace_json=?
              AND r.created_at=? AND r.created_by=? AND p.namespace_sha256=? AND d.created_at=?
              AND e.envelope_revision=1 AND e.envelope_version=? AND e.key_id=? AND e.nonce=? AND e.ciphertext=?
              AND a.id=? AND a.actor=? AND a.operation=? AND a.outcome='saved' AND a.created_at=?`)
            .bind(profileId, revision, credentialRef, input.label, JSON.stringify(input.namespace), now, actor, namespaceSha256, now,
              sealed.version, sealed.keyId, sealed.nonce, sealed.ciphertext, auditId, actor, operation, now).first();
          committed = receipt !== null && configurationSqlInteger(receipt.committed, "committed receipt", 1) === 1;
        } catch { /* An unreadable or absent receipt remains unavailable. */ }
        if (!committed) throw error;
      }
      return { profileId, revision, label: input.label, namespace: input.namespace,
        credentials: { status: "configured", ref: credentialRef }, createdAt: now, createdBy: actor };
    } catch (error) {
      if (error instanceof StorageConfigurationError || error instanceof AdministratorDenied) throw error;
      const message = error instanceof Error ? error.message : "";
      if (message.includes("FP2 candidate revision conflict") || message.includes("UNIQUE constraint failed: system_storage_")) throw conflict();
      throw unavailable();
    }
  }

  return { storageCredentialEditingAvailable, readStorageConfiguration, saveStorageCandidate };
}
