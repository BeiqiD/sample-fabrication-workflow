import { HTTPException } from "hono/http-exception";
import { canonicalR2UploadInput, MAX_R2_UPLOAD_BYTES, normalizeR2UploadRequestId, R2_UPLOAD_RECEIPT_LIFETIME_MS,
  validateFileUploadResult, validateR2UploadInput, type R2UploadIngress, type R2UploadRequestState,
  type R2UploadResult } from "../../shared/contracts/r2-upload";
import { sha256Hex } from "../../shared/domain/content-addressing";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import type { FileAuthoritySqlDatabase, FileAuthoritySqlRow } from "../../worker/runtime/file-authority-sql";
import { stageAuthorityCandidate } from "../../worker/files/authority-candidates-core";
import { writeAuthorityCandidate } from "../../worker/files/authority-publication-core";
import { resolveSqlAcceptedUploadResultFile, verifyOwnedAcceptedResultFile } from "../../worker/files/accepted-result-reader-core";
import { readSqlStorageRoleDefaults } from "../../worker/files/storage-role-defaults-core";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { prepareActiveFileUploadReceiptStatements } from "../../worker/uploads/active-file-upload-receipt-statements";
import { captureLocalVolumeProfileAuthority, ownedLocalVolumeProfileContext, prepareLocalVolumeProfileAuthorityFence,
  type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening";
import { prepareLocalVolumeRoleSelectionFence } from "../storage/local-volume-role-policy";
import { assertLocalUploadExecutionOwner, type LocalUploadExecution } from "./local-upload-execution";

interface Receipt {
  id: string; actor_email: string; client_request_id: string; operation_id: string;
  ingress: R2UploadIngress; purpose: "embedded_content" | "research_source";
  request_sha256: string; request_input_json: string; storage_profile_id: string;
  storage_profile_revision: 1; role_policy_revision: number;
  candidate_asset_id: string; candidate_object_key: string;
  status: "pending" | "ready" | "failed"; accepted_result_json: string | null;
  created_at: string; completed_at: string | null; expires_at: string;
}
export class LocalUploadUnavailableError extends Error {
  constructor() { super("The original local upload outcome is unavailable. Check the same request again."); this.name = "LocalUploadUnavailableError"; }
}
export class LocalUploadConflictError extends Error {
  constructor() { super("This upload request was already accepted with different content."); this.name = "LocalUploadConflictError"; }
}
function text(row: FileAuthoritySqlRow, key: string, maximum = 256): string {
  const value = row[key];
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) throw new LocalUploadUnavailableError();
  return value;
}
function timestamp(row: FileAuthoritySqlRow, key: string): string {
  const value = text(row, key, 64);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new LocalUploadUnavailableError();
  return value;
}
function checkedReceipt(row: FileAuthoritySqlRow): Receipt {
  if ((row.ingress !== "ordinary_image" && row.ingress !== "project_attachment")
    || (row.purpose !== "embedded_content" && row.purpose !== "research_source")
    || row.request_scope !== "system" || (row.status !== "pending" && row.status !== "ready" && row.status !== "failed")
    || row.accepted_result_json !== null && typeof row.accepted_result_json !== "string"
    || row.completed_at !== null && typeof row.completed_at !== "string"
    || configurationSqlInteger(row.storage_profile_revision, "localUpload.profileRevision", 1) !== 1
    || configurationSqlInteger(row.storage_policy_revision, "localUpload.storagePolicyRevision", 1) !== 1)
    throw new LocalUploadUnavailableError();
  const request_input_json = text(row, "request_input_json", 8192), request_sha256 = text(row, "request_sha256", 64);
  if (!/^[a-f0-9]{64}$/.test(request_sha256)) throw new LocalUploadUnavailableError();
  return { id: text(row, "id"), actor_email: text(row, "actor_email"), client_request_id: text(row, "client_request_id"),
    operation_id: text(row, "operation_id"), ingress: row.ingress, purpose: row.purpose, request_sha256, request_input_json,
    storage_profile_id: text(row, "storage_profile_id"), storage_profile_revision: 1,
    role_policy_revision: configurationSqlInteger(row.role_policy_revision, "localUpload.rolePolicyRevision", 3),
    candidate_asset_id: text(row, "candidate_asset_id"), candidate_object_key: text(row, "candidate_object_key", 4096),
    status: row.status, accepted_result_json: row.accepted_result_json, created_at: timestamp(row, "created_at"),
    completed_at: row.completed_at === null ? null : timestamp(row, "completed_at"), expires_at: timestamp(row, "expires_at") };
}
async function readReceipt(database: FileAuthoritySqlDatabase, actor: string, requestId: string): Promise<Receipt | null> {
  const row = await database.primary().prepare("SELECT * FROM r2_upload_requests WHERE actor_email = ? AND client_request_id = ?")
    .bind(actor, requestId).first();
  return row ? checkedReceipt(row) : null;
}
function identity(row: Receipt) { return { requestId: row.client_request_id, ingress: row.ingress, expiresAt: row.expires_at }; }
function sameContent(row: Receipt, canonical: Readonly<{ sha256: string; json: string }>): void {
  if (row.request_sha256 !== canonical.sha256 || row.request_input_json !== canonical.json) throw new LocalUploadConflictError();
}
function preserveOwnershipFailure(error: unknown): void {
  if (error instanceof StorageProfileCleanupError || error instanceof HTTPException) throw error;
}

/** Unmounted ordinary system-scope accepted upload. It consumes only the exact
 * genuinely issued execution. Both deployment-owned local roles must already
 * be initialized/activated. This never installs, activates, repairs, selects an
 * R2 fallback, or derives a parent-resource/administrator/Job capability.
 *
 * Historical r2_upload_requests names preserve the existing acceptance/replay
 * protocol; the genuine byte provider and native alias remain explicitly local.
 * The host retains execution.settled/dispose through original provider cleanup.
 * Current3 recovery validators remain closed until separate paired review. */
export function createLocalAcceptedUpload(opening: LocalVolumeProfileOpening, execution: LocalUploadExecution) {
  assertLocalUploadExecutionOwner(execution, opening);
  const physical = ownedLocalVolumeProfileContext(opening);
  physical.assertCurrent();
  const history = execution.historyDatabase();
  async function state(row: Receipt): Promise<R2UploadRequestState> {
    const base = identity(row);
    if (row.expires_at <= new Date().toISOString()) return { ...base, status: "expired" };
    if (row.status !== "ready") return { ...base, status: row.status };
    let result: R2UploadResult;
    try { result = validateFileUploadResult(JSON.parse(row.accepted_result_json ?? "null")); }
    catch { throw new LocalUploadUnavailableError(); }
    if (result.key !== null) throw new LocalUploadUnavailableError();
    const expected = validateR2UploadInput(JSON.parse(row.request_input_json)).file;
    const resolveFileId = () => resolveSqlAcceptedUploadResultFile(history, { kind: "r2_upload", receipt: row });
    if (await resolveFileId() !== result.fileId) return { ...base, status: "unavailable" };
    const verified = await verifyOwnedAcceptedResultFile({ openRead: execution.openRead.bind(execution) }, {
      purpose: row.purpose, expectedBytes: expected, resolveFileId,
    });
    // Provider I/O is outside SQL. The final fresh admitted read confirms the
    // same immutable receipt after complete verification AND owned disposal.
    const current = await readReceipt(history, execution.actor, row.client_request_id);
    if (!current || current.id !== row.id || current.operation_id !== row.operation_id
      || current.request_input_json !== row.request_input_json || current.accepted_result_json !== row.accepted_result_json)
      throw new LocalUploadUnavailableError();
    if (current.expires_at <= new Date().toISOString()) return { ...base, status: "expired" };
    if (!verified || current.status !== "ready") return { ...base, status: "unavailable" };
    return { ...base, status: "ready", result };
  }
  return Object.freeze({
    /** Existing receipt-state verification, exposed only to the same issued
     * current actor execution. This creates no new upload executor or retry. */
    async getState(requestId: string): Promise<R2UploadRequestState | null> {
      assertLocalUploadExecutionOwner(execution, opening);
      if (normalizeR2UploadRequestId(requestId) !== requestId)
        throw new HTTPException(400, { message: "A valid upload request ID is required." });
      const current = await readReceipt(history, execution.actor, requestId);
      return current ? state(current) : null;
    },
    async accept(upload: Readonly<{ requestId: string; ingress: R2UploadIngress; originalName: string; mimeType: string;
      bytes: ArrayBuffer }>): Promise<Readonly<{ state: R2UploadRequestState; fresh: boolean }>> {
      assertLocalUploadExecutionOwner(execution, opening);
      const requestId = upload.requestId, ingress = upload.ingress, originalName = upload.originalName, mimeType = upload.mimeType;
      const sourceBytes = upload.bytes;
      if (normalizeR2UploadRequestId(requestId) !== requestId) throw new HTTPException(400, { message: "A valid upload request ID is required." });
      if (!(sourceBytes instanceof ArrayBuffer) || sourceBytes.byteLength > MAX_R2_UPLOAD_BYTES)
        throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
      // Capture bytes and metadata before the first hash/SQL await. A mutable
      // caller ArrayBuffer cannot change content after accepting its hash.
      const bytes = sourceBytes.slice(0);
      const canonical = await canonicalR2UploadInput(ingress, { originalName, mimeType, byteSize: bytes.byteLength,
        sha256: await sha256Hex(bytes) });
      const previous = await readReceipt(history, execution.actor, requestId);
      if (previous) { sameContent(previous, canonical); return { state: await state(previous), fresh: false }; }
      const defaults = await readSqlStorageRoleDefaults(history);
      if (!defaults || defaults.internal.policyRevision < 3) throw new LocalUploadUnavailableError();
      const internal = captureLocalVolumeProfileAuthority(opening,
        { profileId: defaults.internal.storageProfileId, configurationRevision: 1 }, "write");
      const originals = captureLocalVolumeProfileAuthority(opening,
        { profileId: defaults.originals.storageProfileId, configurationRevision: 1 }, "write");
      const authorities = [internal, originals];
      const database = execution.database(authorities);
      const targets = Object.freeze({ internal: { id: internal.profile.profileId, configurationRevision: 1 as const,
        namespaceIdentity: internal.profile.namespaceIdentity }, originals: { id: originals.profile.profileId,
        configurationRevision: 1 as const, namespaceIdentity: originals.profile.namespaceIdentity } });
      const selection = () => prepareLocalVolumeRoleSelectionFence(database, defaults.internal.policyRevision, targets);
      const sourceFences = () => authorities.map(authority => prepareLocalVolumeProfileAuthorityFence(authority, database));
      const profile = canonical.input.purpose === "research_source" ? originals.profile : internal.profile;
      const now = new Date().toISOString(), expiresAt = new Date(Date.parse(now) + R2_UPLOAD_RECEIPT_LIFETIME_MS).toISOString();
      const id = crypto.randomUUID(), operationId = crypto.randomUUID(), assetId = crypto.randomUUID();
      const objectKey = `files/${crypto.randomUUID()}`;
      try {
        // Same mature acceptance shape, explicit role policy >=3. Both exact
        // source snapshots and the dual-role selection fence share this BEGIN.
        await database.batch([...sourceFences(), selection(), database.prepare(`INSERT INTO r2_upload_requests
      (id, actor_email, client_request_id, operation_id, ingress, purpose, request_sha256, request_input_json,
       request_scope, storage_profile_id, storage_profile_revision, storage_policy_revision,
       candidate_asset_id, candidate_object_key, status, created_at, expires_at,role_policy_revision)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, 1, 1, ?, ?, 'pending', ?, ?,?
      WHERE EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode=?)`)
          .bind(id, execution.actor, requestId, operationId, ingress, canonical.input.purpose, canonical.sha256, canonical.json,
            profile.profileId, assetId, objectKey, now, expiresAt, defaults.internal.policyRevision, "active"),
          database.prepare(`SELECT CASE WHEN changes()=1 AND EXISTS(SELECT 1 FROM r2_upload_requests
        WHERE id=? AND operation_id=? AND status='pending' AND storage_profile_id=? AND storage_profile_revision=1
          AND candidate_asset_id=? AND candidate_object_key=?) THEN 1 ELSE json('Upload acceptance did not commit') END`)
            .bind(id, operationId, profile.profileId, assetId, objectKey)]);
      } catch (error) { preserveOwnershipFailure(error); /* Read exact original receipt; never repeat acceptance. */ }
      const accepted = await readReceipt(history, execution.actor, requestId);
      if (!accepted) throw new LocalUploadUnavailableError();
      sameContent(accepted, canonical);
      if (accepted.id !== id || accepted.operation_id !== operationId || accepted.status !== "pending")
        return { state: await state(accepted), fresh: false };
      if (accepted.storage_profile_id !== profile.profileId || accepted.role_policy_revision !== defaults.internal.policyRevision
        || accepted.candidate_asset_id !== assetId || accepted.candidate_object_key !== objectKey) throw new LocalUploadUnavailableError();
      if (accepted.expires_at <= new Date().toISOString()) return { state: { ...identity(accepted), status: "expired" }, fresh: false };
      const owner = Object.freeze({ kind: "r2_upload" as const, acceptanceId: id, actorEmail: execution.actor, operationId });
      const candidate = await stageAuthorityCandidate(database, owner);
      const publication = await writeAuthorityCandidate({ database,
        openProfile(frozen, access, lifecycle) {
          return execution.openProfile(frozen, access, { ...lifecycle, async beforeRequest(operation) {
            if (lifecycle.beforeRequest && await lifecycle.beforeRequest(operation) !== true) return false;
            await database.batch([...sourceFences(), selection()]);
            return true;
          } });
        },
      }, owner, candidate, { body: bytes, contentType: mimeType, filename: originalName });
      const completedAt = new Date().toISOString();
      try {
        // Publication, the native File alias, and accepted receipt are one
        // transaction with fresh original source/default/principal checks.
        await database.batch([...sourceFences(), selection(), ...publication.statements,
          ...prepareActiveFileUploadReceiptStatements(database, accepted, candidate, publication.result,
            { originalName, mimeType, completedAt, aliasKind: "native" })]);
      } catch (error) { preserveOwnershipFailure(error); /* No PUT/delete/metadata retry after unknown final ACK. */ }
      const finalized = await readReceipt(history, execution.actor, requestId);
      if (!finalized || finalized.id !== accepted.id || finalized.operation_id !== accepted.operation_id)
        throw new LocalUploadUnavailableError();
      return { state: await state(finalized), fresh: true };
    },
  });
}
