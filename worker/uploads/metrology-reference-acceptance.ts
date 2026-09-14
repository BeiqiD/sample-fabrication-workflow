import { HTTPException } from "hono/http-exception";
import {
  canonicalMetrologyReferenceUploadInput, MAX_METROLOGY_REFERENCE_UPLOAD_BYTES,
  validateMetrologyReferencePublicationPlan, validateMetrologyReferenceUploadInput, validateMetrologyReferenceUploadResult,
  type MetrologyReferencePublicationPlan, type MetrologyReferenceUploadRequestState,
  type MetrologyReferenceUploadResult,
} from "../../shared/contracts/metrology-reference-upload";
import { normalizeR2UploadRequestId, R2_UPLOAD_RECEIPT_LIFETIME_MS } from "../../shared/contracts/r2-upload";
import { sha256Hex, stableJson } from "../../shared/domain/content-addressing";
import { ingestR2Attachment, safeAttachmentObjectName } from "../attachment-ingestion";
import { primaryD1 } from "../d1-primary";
import { ByteVerificationError, verifyByteStream } from "../files/byte-verification";
import { cloudflareSha256 } from "../files/storage-adapters/cloudflare-sha256";
import { r2ByteReader } from "../files/storage-adapters/r2-reader";
import { assertR2BootstrapProfile, ensureR2BootstrapProfile, R2BootstrapUnavailableError } from "../files/r2-bootstrap-profile";
import { publishedAssetSql, publishedTemplateVersionSql } from "../template-publication";
import type { Env } from "../types";

export interface AcceptedMetrologyReferenceUploadRow {
  id: string; actor_email: string; client_request_id: string; operation_id: string;
  template_version_id: string; candidate_reference_id: string; publication_plan_json: string;
  ingress: "metrology_reference"; purpose: "research_source";
  request_sha256: string; request_input_json: string; request_scope: "system";
  storage_profile_id: string; storage_profile_revision: 1; storage_policy_revision: 1;
  candidate_asset_id: string; candidate_object_key: string;
  status: "pending" | "ready" | "failed"; accepted_result_json: string | null;
  created_at: string; completed_at: string | null; expires_at: string;
}
export class MetrologyReferenceUploadUnavailableError extends Error {
  constructor() { super("The reference upload outcome could not be determined. Check the same request again."); this.name = "MetrologyReferenceUploadUnavailableError"; }
}
export class MetrologyReferenceUploadConflictError extends Error {
  constructor() { super("This reference upload request was already accepted with different content or another template."); this.name = "MetrologyReferenceUploadConflictError"; }
}
const activeTemplateSql = `tv.template_kind = 'metrology' AND tv.archived_at IS NULL AND tv.deleted_at IS NULL AND ${publishedTemplateVersionSql("tv")}`;
const availableAssetSql = `a.status = 'ready' AND ${publishedAssetSql("a")}
  AND NOT EXISTS (SELECT 1 FROM blob_gc_ledger bg WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
    AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted'))
  AND NOT EXISTS (SELECT 1 FROM blob_integrity_quarantine biq WHERE biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key)`;

export async function boundedMetrologyReferenceUploadBody(request: Request): Promise<ArrayBuffer> {
  if (!request.body) throw new HTTPException(413, { message: "Template reference files must be between 1 byte and 25 MB" });
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_METROLOGY_REFERENCE_UPLOAD_BYTES);
  let length = 0; let finished = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { finished = true; break; }
      if (!(next.value instanceof Uint8Array)) throw new HTTPException(400, { message: "The reference upload body is invalid." });
      if (next.value.byteLength > MAX_METROLOGY_REFERENCE_UPLOAD_BYTES - length) throw new HTTPException(413, { message: "Template reference files are limited to 25 MB" });
      bytes.set(next.value, length); length += next.value.byteLength;
    }
    if (!length) throw new HTTPException(413, { message: "Template reference files must be between 1 byte and 25 MB" });
    return bytes.slice(0, length).buffer;
  } finally { if (!finished) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function readAcceptedMetrologyReferenceUpload(db: D1Database, actorEmail: string, requestId: string) {
  if (!actorEmail || normalizeR2UploadRequestId(requestId) !== requestId) throw new Error("Invalid reference upload identity");
  try {
    return await primaryD1(db).prepare("SELECT * FROM metrology_reference_upload_requests WHERE actor_email = ? AND client_request_id = ?")
      .bind(actorEmail, requestId).first<AcceptedMetrologyReferenceUploadRow>();
  } catch { throw new MetrologyReferenceUploadUnavailableError(); }
}
function identity(row: AcceptedMetrologyReferenceUploadRow) {
  return { requestId: row.client_request_id, templateId: row.template_version_id, expiresAt: row.expires_at };
}
function parseInput(row: AcceptedMetrologyReferenceUploadRow) {
  try { return validateMetrologyReferenceUploadInput(JSON.parse(row.request_input_json)); } catch { throw new MetrologyReferenceUploadUnavailableError(); }
}
function parsePlan(row: AcceptedMetrologyReferenceUploadRow) {
  try { return validateMetrologyReferencePublicationPlan(JSON.parse(row.publication_plan_json)); } catch { throw new MetrologyReferenceUploadUnavailableError(); }
}
async function liveResultEligible(db: D1Database, row: AcceptedMetrologyReferenceUploadRow, result: MetrologyReferenceUploadResult) {
  const file = parseInput(row).file;
  const ref = result.reference;
  try {
    return Boolean(await primaryD1(db).prepare(`SELECT 1 AS available FROM metrology_template_references mtr
      JOIN template_versions tv ON tv.id = mtr.template_version_id JOIN assets a ON a.id = mtr.asset_id
      WHERE mtr.id = ? AND mtr.template_version_id = ? AND mtr.asset_id = ?
        AND mtr.display_name IS ? AND mtr.created_at IS ? AND mtr.deleted_at IS NULL AND mtr.superseded_by_occurrence_id IS NULL
        AND a.r2_key = ? AND a.mime_type = ? AND a.byte_size = ? AND a.sha256 = ?
        AND ${activeTemplateSql} AND ${availableAssetSql}`)
      .bind(ref.id, row.template_version_id, result.assetId, ref.filename, ref.createdAt, ref.assetKey, ref.mimeType, file.byteSize, file.sha256).first());
  } catch { throw new MetrologyReferenceUploadUnavailableError(); }
}
export async function acceptedMetrologyReferenceUploadState(env: Env, row: AcceptedMetrologyReferenceUploadRow): Promise<MetrologyReferenceUploadRequestState> {
  const base = identity(row);
  if (row.expires_at <= new Date().toISOString()) return { ...base, status: "expired" };
  if (row.status !== "ready") return { ...base, status: row.status };
  let result: MetrologyReferenceUploadResult;
  try { result = validateMetrologyReferenceUploadResult(JSON.parse(row.accepted_result_json ?? "null")); } catch { throw new MetrologyReferenceUploadUnavailableError(); }
  const expected = parseInput(row).file;
  await assertR2BootstrapProfile(primaryD1(env.DB), env, row.storage_profile_id, row.storage_profile_revision);
  if (!await liveResultEligible(env.DB, row, result)) return { ...base, status: "unavailable" };
  const opened = await r2ByteReader(env.ASSETS).read(result.reference.assetKey);
  if (opened.outcome === "missing") return { ...base, status: "unavailable" };
  if (opened.outcome !== "available") throw new MetrologyReferenceUploadUnavailableError();
  try { await verifyByteStream(opened.body, expected, cloudflareSha256, "destination"); }
  catch (error) {
    if (error instanceof ByteVerificationError && (error.reason === "size_mismatch" || error.reason === "hash_mismatch")) return { ...base, status: "unavailable" };
    throw new MetrologyReferenceUploadUnavailableError();
  }
  await assertR2BootstrapProfile(primaryD1(env.DB), env, row.storage_profile_id, row.storage_profile_revision);
  if (row.expires_at <= new Date().toISOString()) return { ...base, status: "expired" };
  if (!await liveResultEligible(env.DB, row, result)) return { ...base, status: "unavailable" };
  return { ...base, status: "ready", result };
}
export async function getMetrologyReferenceUploadRequestState(env: Env, actorEmail: string, templateId: string, requestId: string) {
  const row = await readAcceptedMetrologyReferenceUpload(env.DB, actorEmail, requestId);
  return row && row.template_version_id === templateId ? acceptedMetrologyReferenceUploadState(env, row) : null;
}
async function publicationPlan(db: D1Database, templateId: string, sha256: string, byteSize: number): Promise<MetrologyReferencePublicationPlan> {
  if (!await primaryD1(db).prepare(`SELECT 1 FROM template_versions tv WHERE tv.id = ? AND ${activeTemplateSql}`).bind(templateId).first()) {
    throw new HTTPException(404, { message: "Metrology template not found" });
  }
  const ref = await primaryD1(db).prepare(`SELECT mtr.id, mtr.asset_id AS assetId, mtr.display_name AS filename, mtr.position,
      mtr.actor_email AS actorEmail, mtr.created_at AS createdAt, mtr.deleted_at AS deletedAt, mtr.deleted_by AS deletedBy
    FROM metrology_template_references mtr JOIN assets a ON a.id = mtr.asset_id
    WHERE mtr.template_version_id = ? AND mtr.superseded_by_occurrence_id IS NULL AND a.sha256 = ? AND a.byte_size = ?
      AND ${availableAssetSql} ORDER BY (mtr.deleted_at IS NULL) DESC, mtr.created_at DESC, mtr.id DESC LIMIT 1`)
    .bind(templateId, sha256, byteSize).first();
  return validateMetrologyReferencePublicationPlan({ schema: "metrology-reference-publication/1", action: ref ? ref.deletedAt ? "restore" : "reuse" : "create", reference: ref });
}
const snapshotSql = `id = ? AND template_version_id = ? AND asset_id IS ? AND display_name IS ? AND position IS ?
  AND actor_email IS ? AND created_at IS ? AND deleted_at IS ? AND deleted_by IS ? AND superseded_by_occurrence_id IS NULL`;
function snapshotBindings(row: AcceptedMetrologyReferenceUploadRow, plan: Exclude<MetrologyReferencePublicationPlan, { action: "create" }>) {
  const ref = plan.reference;
  return [ref.id, row.template_version_id, ref.assetId, ref.filename, ref.position, ref.actorEmail, ref.createdAt, ref.deletedAt, ref.deletedBy];
}
async function knownPlanUnavailable(db: D1Database, row: AcceptedMetrologyReferenceUploadRow, assetId: string): Promise<boolean> {
  const plan = parsePlan(row);
  const live = await primaryD1(db).prepare(`SELECT 1 FROM template_versions tv, assets a WHERE tv.id = ? AND a.id = ?
    AND ${activeTemplateSql} AND ${availableAssetSql}`).bind(row.template_version_id, assetId).first();
  if (!live) return true;
  if (plan.action === "create") {
    return Boolean(await primaryD1(db).prepare(`SELECT 1 FROM metrology_template_references WHERE template_version_id = ? AND asset_id = ?
      AND (deleted_at IS NOT NULL OR superseded_by_occurrence_id IS NOT NULL)`).bind(row.template_version_id, assetId).first());
  }
  return !await primaryD1(db).prepare(`SELECT 1 FROM metrology_template_references WHERE ${snapshotSql}`).bind(...snapshotBindings(row, plan)).first();
}
export async function acceptAndUploadMetrologyReference(env: Env, upload: {
  requestId: string; actorEmail: string; templateId: string; originalName: string; mimeType: string; bytes: ArrayBuffer;
}): Promise<{ state: MetrologyReferenceUploadRequestState; fresh: boolean }> {
  if (normalizeR2UploadRequestId(upload.requestId) !== upload.requestId) throw new Error("Invalid reference upload identity");
  if (!upload.bytes.byteLength || upload.bytes.byteLength > MAX_METROLOGY_REFERENCE_UPLOAD_BYTES) throw new HTTPException(413, { message: "Template reference files must be between 1 byte and 25 MB" });
  let canonical;
  try { canonical = await canonicalMetrologyReferenceUploadInput(upload.templateId, { originalName: upload.originalName, mimeType: upload.mimeType,
    byteSize: upload.bytes.byteLength, sha256: await sha256Hex(upload.bytes) }); } catch { throw new HTTPException(400, { message: "Reference-file metadata is invalid" }); }
  const compare = (row: AcceptedMetrologyReferenceUploadRow) => {
    if (row.request_sha256 !== canonical.sha256 || row.request_input_json !== canonical.json || row.template_version_id !== upload.templateId) throw new MetrologyReferenceUploadConflictError();
  };
  const existing = await readAcceptedMetrologyReferenceUpload(env.DB, upload.actorEmail, upload.requestId);
  if (existing) { compare(existing); return { state: await acceptedMetrologyReferenceUploadState(env, existing), fresh: false }; }
  const plan = await publicationPlan(env.DB, upload.templateId, canonical.input.file.sha256, upload.bytes.byteLength);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + R2_UPLOAD_RECEIPT_LIFETIME_MS).toISOString();
  const profile = await ensureR2BootstrapProfile(primaryD1(env.DB), env, now);
  const id = crypto.randomUUID(); const operationId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const referenceId = crypto.randomUUID();
  const objectKey = `metrology/${assetId}-${safeAttachmentObjectName(upload.originalName)}`;
  try {
    await primaryD1(env.DB).prepare(`INSERT INTO metrology_reference_upload_requests
      (id, actor_email, client_request_id, operation_id, template_version_id, candidate_reference_id, publication_plan_json,
       ingress, purpose, request_sha256, request_input_json, request_scope, storage_profile_id, storage_profile_revision, storage_policy_revision,
       candidate_asset_id, candidate_object_key, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'metrology_reference', 'research_source', ?, ?, 'system', ?, 1, 1, ?, ?, 'pending', ?, ?)`)
      .bind(id, upload.actorEmail, upload.requestId, operationId, upload.templateId, referenceId, stableJson(plan), canonical.sha256, canonical.json,
        profile.id, assetId, objectKey, now, expiresAt).run();
  } catch { /* Reconcile uniqueness races and lost acknowledgements on the primary. */ }
  const accepted = await readAcceptedMetrologyReferenceUpload(env.DB, upload.actorEmail, upload.requestId);
  if (!accepted) throw new MetrologyReferenceUploadUnavailableError();
  compare(accepted);
  if (accepted.id !== id || accepted.operation_id !== operationId || accepted.status !== "pending") return { state: await acceptedMetrologyReferenceUploadState(env, accepted), fresh: false };
  if (accepted.storage_profile_id !== profile.id || accepted.storage_profile_revision !== profile.configurationRevision
    || accepted.candidate_asset_id !== assetId || accepted.candidate_object_key !== objectKey || accepted.candidate_reference_id !== referenceId
    || accepted.publication_plan_json !== stableJson(plan)) throw new MetrologyReferenceUploadUnavailableError();
  if (accepted.expires_at <= new Date().toISOString()) return { state: { ...identity(accepted), status: "expired" }, fresh: false };
  await assertR2BootstrapProfile(primaryD1(env.DB), env, accepted.storage_profile_id, accepted.storage_profile_revision);
  let registration;
  try { registration = await ingestR2Attachment(env, { originalName: upload.originalName, mimeType: upload.mimeType,
    actorEmail: upload.actorEmail, bytes: upload.bytes, registrationId: accepted.candidate_asset_id, objectKey: () => accepted.candidate_object_key }); }
  catch { throw new MetrologyReferenceUploadUnavailableError(); }
  await assertR2BootstrapProfile(primaryD1(env.DB), env, accepted.storage_profile_id, accepted.storage_profile_revision);
  const completedAt = new Date().toISOString();
  if (accepted.expires_at <= completedAt) return { state: { ...identity(accepted), status: "expired" }, fresh: true };
  const db = primaryD1(env.DB);
  const asset = registration.record;
  const statements: D1PreparedStatement[] = [];
  if (plan.action === "create") {
    statements.push(db.prepare(`INSERT INTO metrology_template_references
      (id, template_version_id, asset_id, display_name, position, actor_email, created_at)
      SELECT ?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM metrology_template_references WHERE template_version_id = ?), 0), ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM metrology_template_references WHERE template_version_id = ? AND asset_id = ?)
      ON CONFLICT(template_version_id, asset_id) DO NOTHING`)
      .bind(referenceId, upload.templateId, asset.id, upload.originalName, upload.templateId, upload.actorEmail, accepted.created_at, upload.templateId, asset.id));
  } else {
    statements.push(db.prepare(`UPDATE metrology_template_references SET asset_id = ?, display_name = ?, deleted_at = NULL, deleted_by = NULL
      WHERE ${snapshotSql}`)
      .bind(asset.id, plan.action === "restore" ? upload.originalName : plan.reference.filename, ...snapshotBindings(accepted, plan)));
  }
  // Never silently skip finalization: this exact immutable row must update, and
  // its SQL guard aborts the entire batch when CAS or publication eligibility
  // fails. The ledger cannot disappear or change operation identity meanwhile.
  statements.push(db.prepare(`UPDATE metrology_reference_upload_requests SET status = 'ready', completed_at = ?,
    accepted_result_json = CASE WHEN ? = 'create' OR changes() = 1 THEN (
      SELECT json_object('assetId', a.id, 'deduplicated', json(?), 'reference', json_object(
        'id', mtr.id, 'filename', mtr.display_name, 'mimeType', a.mime_type, 'byteSize', a.byte_size, 'assetKey', a.r2_key, 'createdAt', mtr.created_at))
      FROM metrology_template_references mtr JOIN assets a ON a.id = mtr.asset_id
      WHERE mtr.template_version_id = ? AND mtr.asset_id = ? AND (? = 'create' OR mtr.id = ?)
        AND mtr.deleted_at IS NULL AND mtr.superseded_by_occurrence_id IS NULL
    ) ELSE NULL END WHERE id = ? AND operation_id = ?`)
    .bind(completedAt, plan.action, JSON.stringify(registration.deduplicated), upload.templateId, asset.id, plan.action,
      plan.reference?.id ?? referenceId, accepted.id, accepted.operation_id));
  // SQL-level assertion also covers a suppressed/zero-row final UPDATE: the
  // preceding occurrence write cannot commit without its exact ready receipt.
  statements.push(db.prepare(`SELECT CASE WHEN changes() = 1 AND EXISTS (
    SELECT 1 FROM metrology_reference_upload_requests WHERE id = ? AND operation_id = ? AND status = 'ready'
  ) THEN 1 ELSE json('metrology reference publication did not commit') END AS published`)
    .bind(accepted.id, accepted.operation_id));
  try { await db.batch(statements); } catch { /* Read the receipt before classifying any failed or lost batch response. */ }
  let finalized = await readAcceptedMetrologyReferenceUpload(env.DB, upload.actorEmail, upload.requestId);
  if (!finalized || finalized.id !== accepted.id || finalized.operation_id !== accepted.operation_id) throw new MetrologyReferenceUploadUnavailableError();
  if (finalized.status === "pending" && await knownPlanUnavailable(env.DB, accepted, asset.id)) {
    try { await db.prepare(`UPDATE metrology_reference_upload_requests SET status = 'failed', completed_at = ?
      WHERE id = ? AND operation_id = ? AND status = 'pending'`).bind(new Date().toISOString(), accepted.id, accepted.operation_id).run(); } catch { /* A terminal-state acknowledgement can also be lost. */ }
    finalized = await readAcceptedMetrologyReferenceUpload(env.DB, upload.actorEmail, upload.requestId);
    if (!finalized) throw new MetrologyReferenceUploadUnavailableError();
  }
  const state = await acceptedMetrologyReferenceUploadState(env, finalized);
  return { state, fresh: state.status === "ready" && state.result.reference.id === accepted.candidate_reference_id };
}
export function rethrowMetrologyReferenceUploadError(error: unknown): never {
  if (error instanceof MetrologyReferenceUploadConflictError) throw new HTTPException(409, { message: error.message });
  if (error instanceof R2BootstrapUnavailableError || error instanceof MetrologyReferenceUploadUnavailableError) throw new HTTPException(503, { message: error.message });
  throw error;
}
