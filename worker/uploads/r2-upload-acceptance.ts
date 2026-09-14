import { HTTPException } from "hono/http-exception";
import {
  canonicalR2UploadInput, MAX_R2_UPLOAD_BYTES, normalizeR2UploadRequestId,
  R2_UPLOAD_RECEIPT_LIFETIME_MS, validateR2UploadInput,
  type R2UploadIngress, type R2UploadRequestState, type R2UploadResult,
} from "../../shared/contracts/r2-upload";
import { sha256Hex } from "../../shared/domain/content-addressing";
import { AttachmentIngestionUnavailableError, ingestR2Attachment, safeAttachmentObjectName } from "../attachment-ingestion";
import { primaryD1 } from "../d1-primary";
import { ByteVerificationError, verifyByteStream } from "../files/byte-verification";
import { cloudflareSha256 } from "../files/storage-adapters/cloudflare-sha256";
import { r2ByteReader } from "../files/storage-adapters/r2-reader";
import { assertR2BootstrapProfile, ensureR2BootstrapProfile, R2BootstrapUnavailableError } from "../files/r2-bootstrap-profile";
import type { Env } from "../types";

export interface AcceptedR2UploadRow {
  id: string; actor_email: string; client_request_id: string; operation_id: string;
  ingress: R2UploadIngress; purpose: "embedded_content" | "research_source";
  request_sha256: string; request_input_json: string; request_scope: "system";
  storage_profile_id: string; storage_profile_revision: 1; storage_policy_revision: 1;
  candidate_asset_id: string; candidate_object_key: string;
  status: "pending" | "ready" | "failed"; accepted_result_json: string | null;
  created_at: string; completed_at: string | null; expires_at: string;
}

export class R2UploadAcceptanceUnavailableError extends Error {
  constructor(message = "The upload outcome could not be determined. Check the same request again.") { super(message); this.name = "R2UploadAcceptanceUnavailableError"; }
}
export class R2UploadRequestConflictError extends Error {
  constructor() { super("This upload request was already accepted with different content."); this.name = "R2UploadRequestConflictError"; }
}

export function requireR2UploadRequestId(value: string | undefined): string {
  if (!value) throw new HTTPException(428, { message: "Reload the application before uploading files." });
  const id = normalizeR2UploadRequestId(value);
  if (!id) throw new HTTPException(400, { message: "A valid upload request ID is required." });
  return id;
}

/** Bound an unknown/chunked body before retaining it or accepting any write. */
export async function boundedR2UploadBody(request: Request): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_R2_UPLOAD_BYTES);
  let length = 0;
  let finished = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { finished = true; break; }
      if (!(next.value instanceof Uint8Array)) throw new HTTPException(400, { message: "The upload body is invalid." });
      if (next.value.byteLength > MAX_R2_UPLOAD_BYTES - length) {
        throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
      }
      bytes.set(next.value, length);
      length += next.value.byteLength;
    }
    return bytes.slice(0, length).buffer;
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readAcceptedR2Upload(db: D1Database, actorEmail: string, requestId: string): Promise<AcceptedR2UploadRow | null> {
  if (!actorEmail || normalizeR2UploadRequestId(requestId) !== requestId) throw new Error("Invalid upload request identity");
  try {
    return await primaryD1(db).prepare("SELECT * FROM r2_upload_requests WHERE actor_email = ? AND client_request_id = ?")
      .bind(actorEmail, requestId).first<AcceptedR2UploadRow>();
  } catch { throw new R2UploadAcceptanceUnavailableError(); }
}

function identity(row: AcceptedR2UploadRow) {
  return { requestId: row.client_request_id, ingress: row.ingress, expiresAt: row.expires_at };
}
function resultFor(row: AcceptedR2UploadRow): R2UploadResult {
  try {
    const result = JSON.parse(row.accepted_result_json ?? "null") as R2UploadResult;
    if (!result || typeof result !== "object" || Array.isArray(result)
      || Object.keys(result).sort().join(",") !== "deduplicated,id,key"
      || typeof result.id !== "string" || !result.id || [...result.id].length > 256 || result.id.includes("\0")
      || typeof result.key !== "string" || !result.key || [...result.key].length > 4096 || result.key.includes("\0")
      || typeof result.deduplicated !== "boolean") throw new Error();
    return result;
  } catch { throw new R2UploadAcceptanceUnavailableError(); }
}
async function resultStillEligible(db: D1Database, result: R2UploadResult, expected: { sha256: string; byteSize: number }) {
  try {
    return Boolean(await primaryD1(db).prepare(`SELECT 1 AS available FROM assets a LEFT JOIN imports i ON i.id = a.import_id
      WHERE a.id = ? AND a.r2_key = ? AND a.status = 'ready' AND a.sha256 = ? AND a.byte_size = ?
        AND (a.import_id IS NULL OR i.status = 'ready')
        AND NOT EXISTS (SELECT 1 FROM blob_gc_ledger bg WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted'))
        AND NOT EXISTS (SELECT 1 FROM blob_integrity_quarantine biq WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key)`)
      .bind(result.id, result.key, expected.sha256, expected.byteSize).first());
  } catch { throw new R2UploadAcceptanceUnavailableError(); }
}

/** Receipts do not retain bytes or renew registration grace. A successful read
 * requires the original namespace, verified bytes and current lifecycle state. */
export async function acceptedR2UploadState(env: Env, row: AcceptedR2UploadRow): Promise<R2UploadRequestState> {
  const base = identity(row);
  if (row.expires_at <= new Date().toISOString()) return { ...base, status: "expired" };
  if (row.status !== "ready") return { ...base, status: row.status };
  const result = resultFor(row);
  let expected;
  try { expected = validateR2UploadInput(JSON.parse(row.request_input_json)).file; }
  catch { throw new R2UploadAcceptanceUnavailableError(); }
  await assertR2BootstrapProfile(primaryD1(env.DB), env, row.storage_profile_id, row.storage_profile_revision);
  if (!await resultStillEligible(env.DB, result, expected)) return { ...base, status: "unavailable" };
  const opened = await r2ByteReader(env.ASSETS).read(result.key);
  if (opened.outcome === "missing") return { ...base, status: "unavailable" };
  if (opened.outcome !== "available") throw new R2UploadAcceptanceUnavailableError();
  try { await verifyByteStream(opened.body, expected, cloudflareSha256, "destination"); }
  catch (error) {
    if (error instanceof ByteVerificationError && (error.reason === "size_mismatch" || error.reason === "hash_mismatch")) {
      return { ...base, status: "unavailable" };
    }
    throw new R2UploadAcceptanceUnavailableError();
  }
  // Verification is provider I/O outside SQL. Recheck after it so a concurrent
  // expiry or deletion claim cannot turn an old receipt into a new publication.
  await assertR2BootstrapProfile(primaryD1(env.DB), env, row.storage_profile_id, row.storage_profile_revision);
  if (row.expires_at <= new Date().toISOString()) return { ...base, status: "expired" };
  if (!await resultStillEligible(env.DB, result, expected)) return { ...base, status: "unavailable" };
  return { ...base, status: "ready", result };
}

export async function getR2UploadRequestState(env: Env, actorEmail: string, requestId: string): Promise<R2UploadRequestState | null> {
  const row = await readAcceptedR2Upload(env.DB, actorEmail, requestId);
  return row ? acceptedR2UploadState(env, row) : null;
}

export interface AcceptAndUploadR2Input {
  requestId: string; actorEmail: string; ingress: R2UploadIngress;
  originalName: string; mimeType: string; bytes: ArrayBuffer;
}

/** A fresh operation owner alone may perform I/O. No retry, process restart,
 * expiry or changed default can claim an existing accepted operation. */
export async function acceptAndUploadR2Asset(env: Env, upload: AcceptAndUploadR2Input): Promise<{ state: R2UploadRequestState; fresh: boolean }> {
  if (normalizeR2UploadRequestId(upload.requestId) !== upload.requestId) throw new Error("Invalid upload request identity");
  if (upload.bytes.byteLength > MAX_R2_UPLOAD_BYTES) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  let canonical;
  try {
    canonical = await canonicalR2UploadInput(upload.ingress, { originalName: upload.originalName,
      mimeType: upload.mimeType, byteSize: upload.bytes.byteLength, sha256: await sha256Hex(upload.bytes) });
  } catch { throw new HTTPException(400, { message: "The upload file metadata is invalid." }); }
  const compare = (row: AcceptedR2UploadRow) => {
    if (row.request_sha256 !== canonical.sha256 || row.request_input_json !== canonical.json) throw new R2UploadRequestConflictError();
  };
  const existing = await readAcceptedR2Upload(env.DB, upload.actorEmail, upload.requestId);
  if (existing) { compare(existing); return { state: await acceptedR2UploadState(env, existing), fresh: false }; }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + R2_UPLOAD_RECEIPT_LIFETIME_MS).toISOString();
  const profile = await ensureR2BootstrapProfile(primaryD1(env.DB), env, now);
  const id = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const objectKey = `${now.slice(0, 10)}/${assetId}-${safeAttachmentObjectName(upload.originalName)}`;
  try {
    await primaryD1(env.DB).prepare(`INSERT INTO r2_upload_requests
      (id, actor_email, client_request_id, operation_id, ingress, purpose, request_sha256, request_input_json,
       request_scope, storage_profile_id, storage_profile_revision, storage_policy_revision,
       candidate_asset_id, candidate_object_key, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, 1, 1, ?, ?, 'pending', ?, ?)`)
      .bind(id, upload.actorEmail, upload.requestId, operationId, upload.ingress, canonical.input.purpose,
        canonical.sha256, canonical.json, profile.id, assetId, objectKey, now, expiresAt).run();
  } catch { /* Constraint races and lost acknowledgements require the same primary read. */ }
  const accepted = await readAcceptedR2Upload(env.DB, upload.actorEmail, upload.requestId);
  if (!accepted) throw new R2UploadAcceptanceUnavailableError();
  compare(accepted);
  if (accepted.id !== id || accepted.operation_id !== operationId || accepted.status !== "pending") {
    return { state: await acceptedR2UploadState(env, accepted), fresh: false };
  }
  if (accepted.storage_profile_id !== profile.id || accepted.storage_profile_revision !== profile.configurationRevision
    || accepted.candidate_asset_id !== assetId || accepted.candidate_object_key !== objectKey) throw new R2UploadAcceptanceUnavailableError();
  if (accepted.expires_at <= new Date().toISOString()) return { state: { ...identity(accepted), status: "expired" }, fresh: false };
  await assertR2BootstrapProfile(primaryD1(env.DB), env, accepted.storage_profile_id, accepted.storage_profile_revision);
  let result: R2UploadResult;
  try {
    const registration = await ingestR2Attachment(env, {
      originalName: upload.originalName, mimeType: upload.mimeType, actorEmail: upload.actorEmail,
      bytes: upload.bytes, registrationId: accepted.candidate_asset_id, objectKey: () => accepted.candidate_object_key,
    });
    result = { id: registration.record.id, key: registration.record.r2_key, deduplicated: registration.deduplicated };
  } catch (error) {
    // Existing registration can have committed despite a lost response. Keep
    // pending ownership; never turn uncertainty into permission to write again.
    throw new R2UploadAcceptanceUnavailableError(error instanceof AttachmentIngestionUnavailableError
      ? `${error.publicMessage} Check the same upload request again.` : undefined);
  }
  await assertR2BootstrapProfile(primaryD1(env.DB), env, accepted.storage_profile_id, accepted.storage_profile_revision);
  const completedAt = new Date().toISOString();
  if (accepted.expires_at <= completedAt) return { state: { ...identity(accepted), status: "expired" }, fresh: true };
  try {
    await primaryD1(env.DB).prepare(`UPDATE r2_upload_requests SET status = 'ready', accepted_result_json = ?, completed_at = ?
      WHERE id = ? AND operation_id = ? AND status = 'pending' AND expires_at > ?`)
      .bind(JSON.stringify(result), completedAt, accepted.id, accepted.operation_id, completedAt).run();
  } catch { /* A committed finalization is indistinguishable from response loss until readback. */ }
  const finalized = await readAcceptedR2Upload(env.DB, upload.actorEmail, upload.requestId);
  if (!finalized || finalized.id !== accepted.id || finalized.operation_id !== accepted.operation_id) throw new R2UploadAcceptanceUnavailableError();
  return { state: await acceptedR2UploadState(env, finalized), fresh: true };
}

export function rethrowR2UploadError(error: unknown): never {
  if (error instanceof R2UploadRequestConflictError) throw new HTTPException(409, { message: error.message });
  if (error instanceof R2BootstrapUnavailableError || error instanceof R2UploadAcceptanceUnavailableError) {
    throw new HTTPException(503, { message: error.message });
  }
  throw error;
}
