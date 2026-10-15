import {
  MAX_STORAGE_CREDENTIAL_ENVELOPES, checkedReenvelopeStorageCredentialInput,
  checkedStorageCredentialEnvelopeList, checkedStorageCredentialEnvelopeProfileId,
  checkedStorageCredentialReenvelopeOperationId, checkedStorageCredentialReenvelopeReceipt,
  StorageCredentialReenvelopeInputError,
  type ReenvelopeStorageCredentialInput, type StorageCredentialEnvelopeList,
  type StorageCredentialEnvelopeMetadata, type StorageCredentialReenvelopeReceipt,
} from "../../shared/contracts/storage-credential-reenvelope";
import type { Env } from "../types";
import {
  decryptStorageCredential, parseStorageCredentialKeyring, reenvelopeStorageCredential,
  type StorageCredentialEnvelope, type StorageCredentialIdentity, type StorageCredentialKeyring,
} from "./credential-envelope";
import { assertSystemAdministrator } from "./system-administrator";

type ReenvelopeEnvironment = Pick<Env, "DB" | "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS" | "STORAGE_CREDENTIAL_KEYRING">;
export class StorageCredentialReenvelopeError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) {
    super(message); this.name = "StorageCredentialReenvelopeError";
  }
}
const conflict = () => new StorageCredentialReenvelopeError(409, "Storage credential envelope changed. Refresh and try again.");
const unavailable = () => new StorageCredentialReenvelopeError(503, "Storage credential re-envelope is temporarily unavailable.");
const encryptionUnavailable = () => new StorageCredentialReenvelopeError(503, "Storage credential encryption is unavailable.");
const missing = () => new StorageCredentialReenvelopeError(404, "Storage credential re-envelope was not found.");

interface EnvelopeRow {
  profile_id: string;
  configuration_revision: number;
  credential_ref: string;
  namespace_sha256: string;
  is_current_candidate: number | null;
  envelope_revision: number | null;
  envelope_version: 1 | null;
  key_id: string | null;
  nonce: string | null;
  ciphertext: string | null;
}
interface ReceiptRow {
  operation_id: string;
  profile_id: string;
  configuration_revision: number;
  credential_ref: string;
  previous_envelope_revision: number;
  envelope_revision: number;
  outcome: "reenveloped" | "already_current";
  created_at: string;
  created_by: string;
}
const ENVELOPE_SELECT = `SELECT d.profile_id,d.configuration_revision,d.credential_ref,d.namespace_sha256,
  (r.revision=p.latest_revision) AS is_current_candidate,
  e.envelope_revision,e.envelope_version,e.key_id,e.nonce,e.ciphertext
  FROM system_storage_credential_descriptors d
  LEFT JOIN system_storage_configuration_revisions r ON r.profile_id=d.profile_id
    AND r.revision=d.configuration_revision AND r.credential_ref=d.credential_ref
  JOIN system_storage_profiles p ON p.id=d.profile_id AND p.namespace_sha256=d.namespace_sha256
  LEFT JOIN system_storage_credential_payloads e ON e.credential_ref=d.credential_ref`;
const RECEIPT_SELECT = `SELECT operation_id,profile_id,configuration_revision,credential_ref,
  previous_envelope_revision,envelope_revision,outcome,created_at,created_by
  FROM system_storage_credential_reenvelopes WHERE operation_id=?`;
function identity(row: EnvelopeRow): StorageCredentialIdentity {
  return { profileId: row.profile_id, configurationRevision: row.configuration_revision,
    credentialRef: row.credential_ref, namespaceSha256: row.namespace_sha256 };
}
function envelope(row: EnvelopeRow): StorageCredentialEnvelope | null {
  return row.envelope_version === 1 && row.key_id && row.nonce && row.ciphertext
    ? { version: 1, keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext } : null;
}
async function keyring(env: ReenvelopeEnvironment): Promise<StorageCredentialKeyring | null> {
  try { return await parseStorageCredentialKeyring(env.STORAGE_CREDENTIAL_KEYRING); } catch { return null; }
}
function receipt(row: ReceiptRow): StorageCredentialReenvelopeReceipt {
  return checkedStorageCredentialReenvelopeReceipt({ operationId: row.operation_id, profileId: row.profile_id,
    revision: row.configuration_revision, credentialRef: row.credential_ref,
    previousEnvelopeRevision: row.previous_envelope_revision, envelopeRevision: row.envelope_revision,
    outcome: row.outcome, createdAt: row.created_at, createdBy: row.created_by });
}
async function storedReceipt(env: ReenvelopeEnvironment, operationId: string): Promise<StorageCredentialReenvelopeReceipt | null> {
  const row = await env.DB.prepare(RECEIPT_SELECT).bind(operationId).first<ReceiptRow>();
  return row ? receipt(row) : null;
}
function matchingReceipt(value: StorageCredentialReenvelopeReceipt, input: ReenvelopeStorageCredentialInput): StorageCredentialReenvelopeReceipt {
  if (value.profileId !== input.profileId || value.revision !== input.revision || value.credentialRef !== input.credentialRef
    || value.previousEnvelopeRevision !== input.expectedEnvelopeRevision) throw conflict();
  return value;
}

/** Safe administrator metadata for retained candidate descriptors. Matching a
 * key ID alone never establishes that a payload can be authenticated. */
export async function listStorageCredentialEnvelopes(env: ReenvelopeEnvironment, rawProfileId: unknown,
  actor: string): Promise<StorageCredentialEnvelopeList> {
  assertSystemAdministrator(env, actor);
  let profileId: string;
  try { profileId = checkedStorageCredentialEnvelopeProfileId(rawProfileId); }
  catch { throw new StorageCredentialReenvelopeError(400, "Invalid storage credential re-envelope."); }
  try {
    const keys = await keyring(env);
    const result = await env.DB.prepare(`${ENVELOPE_SELECT} WHERE d.profile_id=?
      ORDER BY d.configuration_revision DESC,d.credential_ref LIMIT ?`).bind(profileId, MAX_STORAGE_CREDENTIAL_ENVELOPES + 1).all<EnvelopeRow>();
    const items = await Promise.all(result.results.slice(0, MAX_STORAGE_CREDENTIAL_ENVELOPES).map(async row => {
      const sealed = envelope(row), opened = keys && sealed ? await decryptStorageCredential(keys, identity(row), sealed) : { outcome: "unavailable" as const };
      const status = opened.outcome === "available" ? sealed!.keyId === keys!.currentKeyId ? "current" : "needs_reenvelope" : "unavailable";
      return { profileId: row.profile_id, revision: row.configuration_revision, credentialRef: row.credential_ref,
        envelopeRevision: row.envelope_revision, isCurrentCandidate: row.is_current_candidate === 1,
        status } satisfies StorageCredentialEnvelopeMetadata;
    }));
    return checkedStorageCredentialEnvelopeList({ items, hasMore: result.results.length > MAX_STORAGE_CREDENTIAL_ENVELOPES });
  } catch { throw unavailable(); }
}

export async function readStorageCredentialReenvelope(env: ReenvelopeEnvironment, rawOperationId: unknown,
  actor: string): Promise<StorageCredentialReenvelopeReceipt> {
  assertSystemAdministrator(env, actor);
  let operationId: string;
  try { operationId = checkedStorageCredentialReenvelopeOperationId(rawOperationId); }
  catch { throw new StorageCredentialReenvelopeError(400, "Invalid storage credential re-envelope."); }
  try {
    const value = await storedReceipt(env, operationId);
    if (!value) throw missing();
    return value;
  } catch (error) { if (error instanceof StorageCredentialReenvelopeError) throw error; throw unavailable(); }
}

/** This is wrapping maintenance, with no provider access or configuration head
 * change. Historical descriptors retain their original authenticated identity.
 * The receipt and exact-envelope CAS share one D1 transaction. */
export async function reenvelopeStoredStorageCredential(env: ReenvelopeEnvironment, rawInput: unknown,
  actor: string): Promise<StorageCredentialReenvelopeReceipt> {
  assertSystemAdministrator(env, actor);
  let input: ReenvelopeStorageCredentialInput;
  try { input = checkedReenvelopeStorageCredentialInput(rawInput); }
  catch (error) {
    if (error instanceof StorageCredentialReenvelopeInputError) throw new StorageCredentialReenvelopeError(400, error.message);
    throw unavailable();
  }
  try {
    // A durable UUID is authoritative before the latest payload or deployment
    // keyring is read, including after a response was lost or a later rotation.
    const previous = await storedReceipt(env, input.operationId);
    if (previous) return matchingReceipt(previous, input);
    const row = await env.DB.prepare(`${ENVELOPE_SELECT} WHERE d.credential_ref=? AND d.profile_id=?
      AND d.configuration_revision=?`).bind(input.credentialRef, input.profileId, input.revision).first<EnvelopeRow>();
    if (!row) throw conflict();
    if (row.envelope_revision === null) throw encryptionUnavailable();
    if (row.envelope_revision !== input.expectedEnvelopeRevision) throw conflict();
    const stored = envelope(row), keys = await keyring(env);
    if (!stored || !keys) throw encryptionUnavailable();
    let replacement = stored, outcome: StorageCredentialReenvelopeReceipt["outcome"] = "already_current";
    if (stored.keyId === keys.currentKeyId) {
      if ((await decryptStorageCredential(keys, identity(row), stored)).outcome !== "available") throw encryptionUnavailable();
    } else {
      const prepared = await reenvelopeStorageCredential(keys, identity(row), stored);
      if (prepared.outcome !== "available") throw encryptionUnavailable();
      replacement = prepared.replacement; outcome = "reenveloped";
    }
    const envelopeRevision = input.expectedEnvelopeRevision + (outcome === "reenveloped" ? 1 : 0);
    if (!Number.isSafeInteger(envelopeRevision)) throw conflict();
    const createdAt = new Date().toISOString(), statements: D1PreparedStatement[] = [];
    if (outcome === "reenveloped") statements.push(env.DB.prepare(`UPDATE system_storage_credential_payloads
      SET envelope_revision=?,envelope_version=?,key_id=?,nonce=?,ciphertext=?
      WHERE credential_ref=? AND envelope_revision=? AND envelope_version=? AND key_id=? AND nonce=? AND ciphertext=?`)
      .bind(envelopeRevision, replacement.version, replacement.keyId, replacement.nonce, replacement.ciphertext,
        input.credentialRef, input.expectedEnvelopeRevision, stored.version, stored.keyId, stored.nonce, stored.ciphertext));
    // Scalar SELECT returns NULL on a lost CAS. The receipt's NOT NULL guard
    // fails inside the batch, rolling back an UPDATE as well as its audit.
    // No nonce/ciphertext is copied into the retained receipt. changes() applies
    // to the immediately preceding payload UPDATE in this transaction.
    statements.push(env.DB.prepare(`INSERT INTO system_storage_credential_reenvelopes
      (operation_id,profile_id,configuration_revision,credential_ref,previous_envelope_revision,
       envelope_revision,outcome,previous_key_id,key_id,created_at,created_by)
      VALUES (?,?,?,?,?,(SELECT envelope_revision FROM system_storage_credential_payloads
        WHERE credential_ref=? AND envelope_revision=? AND envelope_version=? AND key_id=? AND nonce=? AND ciphertext=?
        ${outcome === "reenveloped" ? "AND changes()=1" : ""}),?,?,?,?,?)`)
      .bind(input.operationId, input.profileId, input.revision, input.credentialRef, input.expectedEnvelopeRevision,
        input.credentialRef, envelopeRevision, replacement.version, replacement.keyId, replacement.nonce, replacement.ciphertext,
        outcome, stored.keyId, replacement.keyId, createdAt, actor));
    try { await env.DB.batch(statements); }
    catch (error) {
      // Two requests for one ID can prepare distinct fresh nonces. Only one
      // commits; its durable receipt wins and the losing batch rolls back.
      const committed = await storedReceipt(env, input.operationId);
      if (committed) return matchingReceipt(committed, input);
      const message = error instanceof Error ? error.message : "";
      if (message.includes("FP2 credential re-envelope") || message.includes("FP2 credential envelope revision conflict")
        || message.includes("NOT NULL constraint failed: system_storage_credential_reenvelopes.envelope_revision")
        || message.includes("UNIQUE constraint failed: system_storage_credential_reenvelopes")) throw conflict();
      throw unavailable();
    }
    return checkedStorageCredentialReenvelopeReceipt({ operationId: input.operationId, profileId: input.profileId,
      revision: input.revision, credentialRef: input.credentialRef, previousEnvelopeRevision: input.expectedEnvelopeRevision,
      envelopeRevision, outcome, createdAt, createdBy: actor });
  } catch (error) { if (error instanceof StorageCredentialReenvelopeError) throw error; throw unavailable(); }
}
