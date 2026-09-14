import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { canonicalCommentAcceptanceInput, COMMENT_ACCEPTANCE_LIFETIME_MS, MAX_COMMENT_ACCEPTANCE_INPUT_BYTES,
  validateCommentAcceptanceInput, validateCommentAcceptedItemResult, validateCommentPublicationPlan, validateCommentPublicationResult,
  type AcceptedCommentSubmissionInput, type CommentAcceptanceState, type CommentAcceptedItemResult, type CommentPublicationPlan } from "../../shared/contracts/comment-acceptance";
import { validSubmissionId } from "../../shared/contracts/comment-submissions";
import { sha256Hex, stableJson } from "../../shared/domain/content-addressing";
import { primaryD1 } from "../d1-primary";
import { ensureR2BootstrapProfile, assertR2BootstrapProfile } from "../files/r2-bootstrap-profile";
import { ensureManagedBootstrapProfile, assertManagedBootstrapProfile } from "../files/managed-bootstrap-profile";
import { managedStorage, managedObjectKey } from "../managed-storage";
import { AttachmentIngestionHashMismatchError, AttachmentIngestionByteSizeMismatchError, ingestManagedAttachment, ingestR2Attachment, safeAttachmentObjectName } from "../attachment-ingestion";
import { ByteVerificationError, verifyByteStream } from "../files/byte-verification";
import { verifyUploadBody } from "../files/legacy-byte-writer";
import { cloudflareSha256 } from "../files/storage-adapters/cloudflare-sha256";
import { r2ByteReader } from "../files/storage-adapters/r2-reader";
import { managedByteReader } from "../files/storage-adapters/managed-reader";
import type { Env } from "../types";

type C = Context<{ Bindings: Env; Variables: { userEmail: string } }>;
export interface CommentSubmissionAcceptanceRow {
  submission_id: string; actor_email: string; operation_id: string; request_sha256: string; request_input_json: string;
  publication_plan_json: string; request_scope: "system"; storage_policy_revision: 1; status: "pending" | "ready" | "cancelled";
  accepted_result_json: string | null; created_at: string; completed_at: string | null; expires_at: string;
}
export interface CommentItemAcceptanceRow {
  item_id: string; submission_id: string; actor_email: string; purpose: "embedded_content" | "derived_preview" | "research_source";
  expected_sha256: string; expected_byte_size: number; storage_profile_id: string; storage_profile_revision: 1;
  candidate_blob_id: string; candidate_object_key: string; execution_token: string | null; started_at: string | null;
  status: "pending" | "ready" | "cancelled"; accepted_result_json: string | null; created_at: string;
}
export class CommentAcceptanceUnavailableError extends Error {
  constructor() { super("The Comment outcome could not be determined. Check the same submission again."); this.name = "CommentAcceptanceUnavailableError"; }
}
function failClosed(): never { throw new CommentAcceptanceUnavailableError(); }
function assertSql(db: D1Database, condition: string, bindings: unknown[] = []) {
  return db.prepare(`SELECT CASE WHEN ${condition} THEN 1 ELSE json('Comment publication did not commit') END AS accepted`).bind(...bindings);
}
export const visibleCommentTargetsSql = (alias: string) => `(( ${alias}.context_kind = 'sample' AND EXISTS (
  SELECT 1 FROM samples s WHERE s.id = ${alias}.sample_id AND s.deleted_at IS NULL)) OR (${alias}.context_kind = 'run_steps'
  AND EXISTS (SELECT 1 FROM comment_submission_targets t WHERE t.submission_id = ${alias}.id)
  AND NOT EXISTS (SELECT 1 FROM comment_submission_targets t LEFT JOIN samples s ON s.id = t.sample_id
    LEFT JOIN runs r ON r.id = t.run_id AND r.sample_id = t.sample_id LEFT JOIN run_steps rs ON rs.id = t.run_step_id AND rs.run_id = t.run_id
    WHERE t.submission_id = ${alias}.id AND (s.id IS NULL OR s.deleted_at IS NOT NULL OR r.id IS NULL OR r.deleted_at IS NOT NULL OR rs.id IS NULL OR rs.deleted_at IS NOT NULL))))`;
async function rows(db: D1Database, id: string) {
  try {
    const snapshot = await db.batch([
      db.prepare("SELECT * FROM comment_submission_acceptances WHERE submission_id = ?").bind(id),
      db.prepare("SELECT * FROM comment_submissions WHERE id = ?").bind(id),
    ]);
    return { parent: (snapshot[0].results[0] as unknown as CommentSubmissionAcceptanceRow | undefined) ?? null,
      canonical: (snapshot[1].results[0] as Record<string, unknown> | undefined) ?? null };
  } catch { failClosed(); }
}
function requireAuthor(actor: string, canonical: Record<string, unknown> | null) {
  if (!canonical) throw new HTTPException(404, { message: "Comment submission not found" });
  if (canonical.actor_email && canonical.actor_email !== actor) throw new HTTPException(404, { message: "Comment submission not found" });
}
function inputFor(row: CommentSubmissionAcceptanceRow) { try { return validateCommentAcceptanceInput(JSON.parse(row.request_input_json)); } catch { failClosed(); } }
function planFor(row: CommentSubmissionAcceptanceRow) { try { return validateCommentPublicationPlan(JSON.parse(row.publication_plan_json)); } catch { failClosed(); } }
async function itemStillEligible(db: D1Database, row: CommentItemAcceptanceRow, result: CommentAcceptedItemResult) {
  const asset = result.storeKind === "r2" ? `EXISTS (SELECT 1 FROM assets a LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = csi.asset_id AND a.id = ? AND a.r2_key = ? AND a.status = 'ready' AND a.sha256 = ? AND a.byte_size = ? AND (a.import_id IS NULL OR i.status = 'ready'))`
    : `EXISTS (SELECT 1 FROM managed_storage_objects m WHERE m.id = csi.storage_object_id AND m.id = ? AND m.object_key = ?
      AND m.provider = 'switchdrive' AND m.status = 'ready' AND m.sha256 = ? AND m.byte_size = ?)`;
  return Boolean(await db.prepare(`SELECT 1 FROM comment_submission_items csi JOIN comment_submissions cs ON cs.id = csi.submission_id
    WHERE csi.id = ? AND csi.submission_id = ? AND csi.status = 'ready' AND csi.deleted_at IS NULL AND csi.sha256 = ?
      AND cs.status <> 'cancelled' AND cs.deleted_at IS NULL AND ${visibleCommentTargetsSql("cs")} AND ${asset}
      AND NOT EXISTS (SELECT 1 FROM blob_gc_ledger WHERE store_kind = ? AND provider = ? AND object_key = ? AND state IN ('deleting', 'deleted'))
      AND NOT EXISTS (SELECT 1 FROM blob_integrity_quarantine WHERE store_kind = ? AND provider = ? AND object_key = ?)`)
    .bind(row.item_id, row.submission_id, row.expected_sha256, result.blobRecordId, result.objectKey, row.expected_sha256, row.expected_byte_size,
      result.storeKind, result.provider, result.objectKey, result.storeKind, result.provider, result.objectKey).first());
}
async function verifiedItem(env: Env, row: CommentItemAcceptanceRow): Promise<boolean> {
  let result: CommentAcceptedItemResult;
  try { result = validateCommentAcceptedItemResult(JSON.parse(row.accepted_result_json ?? "null")); } catch { failClosed(); }
  const db = primaryD1(env.DB);
  if (!await itemStillEligible(db, row, result)) return false;
  const check = () => result.storeKind === "r2" ? assertR2BootstrapProfile(db, env, row.storage_profile_id, row.storage_profile_revision)
    : assertManagedBootstrapProfile(db, env, row.storage_profile_id, row.storage_profile_revision);
  try { await check(); } catch { return false; }
  const storage = result.storeKind === "managed" ? managedStorage(env) : null;
  if (result.storeKind === "managed" && !storage) return false;
  const reader = storage ? managedByteReader(storage) : r2ByteReader(env.ASSETS);
  const opened = await reader.read(result.objectKey);
  if (opened.outcome === "missing") return false;
  if (opened.outcome !== "available") failClosed();
  try { await verifyByteStream(opened.body, { sha256: row.expected_sha256, byteSize: row.expected_byte_size }, cloudflareSha256, "destination"); }
  catch (error) { if (error instanceof ByteVerificationError && ["size_mismatch", "hash_mismatch"].includes(error.reason)) return false; failClosed(); }
  try { await check(); } catch { return false; }
  return itemStillEligible(db, row, result);
}
export async function getCommentAcceptanceState(env: Env, actor: string, id: string, verification: {allPending?:boolean; itemId?:string} = {}): Promise<CommentAcceptanceState> {
  const db = primaryD1(env.DB); const { parent, canonical } = await rows(db, id); requireAuthor(actor, canonical);
  if (!parent) return { submissionId: id, inputSha256: null, expiresAt: null, status: canonical!.status === "cancelled" ? "cancelled" : "legacy", input: null, items: [] };
  if (parent.actor_email !== actor) throw new HTTPException(404, { message: "Comment submission not found" });
  const input = inputFor(parent);
  const state: CommentAcceptanceState = { submissionId: id, inputSha256: parent.request_sha256, expiresAt: parent.expires_at,
    status: parent.status === "cancelled" || canonical!.status === "cancelled" ? "cancelled" : parent.status !== "ready" && parent.expires_at <= new Date().toISOString() ? "expired"
      : canonical!.deleted_at ? "unavailable" : parent.status === "ready" ? "ready" : "pending", input, items: [] };
  const [itemRows, acceptedRows] = await Promise.all([
    db.prepare("SELECT id, status, deleted_at FROM comment_submission_items WHERE submission_id = ?").bind(id).all<{ id: string; status: string; deleted_at: string | null }>(),
    db.prepare("SELECT * FROM comment_item_acceptances WHERE submission_id = ?").bind(id).all<CommentItemAcceptanceRow>(),
  ]);
  const existing = new Map(itemRows.results.map((row) => [row.id, row])); const receipts = new Map(acceptedRows.results.map((row) => [row.item_id, row]));
  for (const item of input.items) {
    const current = existing.get(item.id); const accepted = receipts.get(item.id);
    let status: CommentAcceptanceState["items"][number]["status"] = state.status === "cancelled" || current?.status === "cancelled" ? "cancelled"
      : !current || current.deleted_at ? "unavailable" : item.kind === "link" ? "ready" : !accepted ? "unavailable"
        : accepted.status === "cancelled" ? "cancelled" : accepted.status === "ready" ? "ready" : accepted.execution_token ? "uploading" : "pending";
    if (status === "ready" && item.kind !== "link" && !["expired", "unavailable", "cancelled"].includes(state.status)) {
      if (state.status === "ready" || verification.allPending || verification.itemId === item.id) {
        if (!await verifiedItem(env, accepted!)) status = "unavailable";
      } else {
        const result = validateCommentAcceptedItemResult(JSON.parse(accepted!.accepted_result_json ?? "null"));
        try {
          if (result.storeKind === "r2") await assertR2BootstrapProfile(db,env,accepted!.storage_profile_id,accepted!.storage_profile_revision);
          else await assertManagedBootstrapProfile(db,env,accepted!.storage_profile_id,accepted!.storage_profile_revision);
          if (!await itemStillEligible(db,accepted!,result)) status = "unavailable";
        } catch { status = "unavailable"; }
      }
    }
    state.items.push({ id: item.id, kind: item.kind, status, sha256: item.kind === "link" ? null : item.sha256! });
  }
  // One SQL snapshot follows all provider I/O. Recheck earlier verified items
  // too: another file's slow read must not hide a concurrent deletion or GC claim.
  const finalSnapshot = await db.batch([
    db.prepare(`SELECT cs.status,cs.deleted_at,ca.status AS acceptance_status,ca.expires_at,${visibleCommentTargetsSql("cs")} AS visible
      FROM comment_submissions cs JOIN comment_submission_acceptances ca ON ca.submission_id=cs.id WHERE cs.id=?`).bind(id),
    db.prepare(`SELECT csi.id,csi.status,csi.deleted_at,ia.execution_token,CASE WHEN csi.kind='link' THEN 1
      WHEN ia.status='ready' AND csi.sha256=ia.expected_sha256 AND csi.byte_size=ia.expected_byte_size
        AND ((csi.kind='comment_image' AND EXISTS(SELECT 1 FROM assets a LEFT JOIN imports i ON i.id=a.import_id
          WHERE a.id=csi.asset_id AND a.id=json_extract(ia.accepted_result_json,'$.blobRecordId') AND a.r2_key=json_extract(ia.accepted_result_json,'$.objectKey')
            AND a.status='ready' AND a.sha256=ia.expected_sha256 AND a.byte_size=ia.expected_byte_size AND (a.import_id IS NULL OR i.status='ready')))
          OR (csi.kind='attachment' AND EXISTS(SELECT 1 FROM managed_storage_objects m WHERE m.id=csi.storage_object_id
            AND m.id=json_extract(ia.accepted_result_json,'$.blobRecordId') AND m.object_key=json_extract(ia.accepted_result_json,'$.objectKey')
            AND m.provider='switchdrive' AND m.status='ready' AND m.sha256=ia.expected_sha256 AND m.byte_size=ia.expected_byte_size)))
        AND NOT EXISTS(SELECT 1 FROM blob_gc_ledger bg WHERE bg.store_kind=json_extract(ia.accepted_result_json,'$.storeKind')
          AND bg.provider=json_extract(ia.accepted_result_json,'$.provider') AND bg.object_key=json_extract(ia.accepted_result_json,'$.objectKey') AND bg.state IN('deleting','deleted'))
        AND NOT EXISTS(SELECT 1 FROM blob_integrity_quarantine b WHERE b.store_kind=json_extract(ia.accepted_result_json,'$.storeKind')
          AND b.provider=json_extract(ia.accepted_result_json,'$.provider') AND b.object_key=json_extract(ia.accepted_result_json,'$.objectKey'))
      THEN 1 ELSE 0 END AS available FROM comment_submission_items csi LEFT JOIN comment_item_acceptances ia ON ia.item_id=csi.id WHERE csi.submission_id=?`).bind(id),
    db.prepare("SELECT id FROM run_step_comments WHERE submission_id=? AND deleted_at IS NULL").bind(id),
    db.prepare("SELECT id FROM events WHERE json_extract(metadata_json,'$.action')='comment_submission' AND json_extract(metadata_json,'$.submissionId')=?").bind(id),
  ]);
  const currentParent = finalSnapshot[0].results[0] as {status:string;acceptance_status:string;deleted_at:string|null;expires_at:string;visible:number}|undefined;
  if (!currentParent) state.status="unavailable";
  else if (currentParent.status === "cancelled") state.status="cancelled";
  else if (currentParent.acceptance_status !== "ready" && currentParent.expires_at <= new Date().toISOString()) state.status="expired";
  else if (currentParent.deleted_at || !currentParent.visible) state.status="unavailable";
  const currentItems = new Map((finalSnapshot[1].results as Record<string,unknown>[]).map((value) => [value.id as string,value]));
  for (const item of state.items) {
    const current=currentItems.get(item.id);
    if(state.status==="cancelled" || current?.status==="cancelled") item.status="cancelled";
    else if(!current || current.deleted_at || item.status==="ready" && !current.available) item.status="unavailable";
    else if(item.status==="pending" && current.execution_token) item.status="uploading";
  }
  if (parent.status === "ready") {
    const result = validateCommentPublicationResult(JSON.parse(parent.accepted_result_json ?? "null"));
    if (state.status === "ready") {
      const liveIds = new Set((finalSnapshot[2].results as {id:string}[]).map((entry) => entry.id));
      const eventIds = new Set((finalSnapshot[3].results as {id:string}[]).map((entry) => entry.id));
      if (result.occurrenceIds.some((entry) => !liveIds.has(entry)) || result.eventIds.some((entry) => !eventIds.has(entry))
        || result.itemIds.some((entry) => state.items.find((item) => item.id === entry)?.status !== "ready")) state.status = "unavailable";
      else state.result = result;
    }
  }
  return state;
}
export async function acceptedComment(c: C) {
  c.header("Cache-Control", "no-store");
  return c.json({ request: await getCommentAcceptanceState(c.env, c.get("userEmail"), c.req.param("submissionId")!) });
}
async function boundedBody(request: Request, maximum: number) {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let size = 0; let done = false;
  try { while (true) { const next = await reader.read(); if (next.done) { done = true; break; }
    if (next.value.byteLength > maximum - size) throw new HTTPException(413, { message: "The Comment request exceeds its byte limit" });
    parts.push(next.value); size += next.value.byteLength;
  } const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; } return bytes.buffer;
  } finally { if (!done) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function publicationPlan(input: AcceptedCommentSubmissionInput): CommentPublicationPlan {
  const targets = input.context.kind === "run_steps" ? input.context.targets : [];
  const samples = input.context.kind === "sample" ? [input.context.sampleId] : [...new Set(targets.map((target) => target.sampleId))];
  return { schema: "comment-publication/1", mutationId: crypto.randomUUID(), operationGroupId: targets.length > 1 ? crypto.randomUUID() : null,
    occurrences: targets.map((_, targetIndex) => ({ id: crypto.randomUUID(), targetIndex })), events: samples.map((sampleId) => ({ id: crypto.randomUUID(), sampleId })) };
}
export async function createAcceptedComment(c: C) {
  c.header("Cache-Control", "no-store");
  let raw: unknown; try { raw = JSON.parse(new TextDecoder().decode(await boundedBody(c.req.raw, MAX_COMMENT_ACCEPTANCE_INPUT_BYTES))); } catch (e) { if (e instanceof HTTPException) throw e; throw new HTTPException(400, { message: "Invalid Comment submission" }); }
  if (!raw || (raw as { protocol?: unknown }).protocol !== "comment-submission/1") throw new HTTPException(428, { message: "Reload the application before submitting comments." });
  let accepted; try { accepted = await canonicalCommentAcceptanceInput(raw); } catch { throw new HTTPException(400, { message: "Comment input or prepared file checksum is invalid" }); }
  const { input } = accepted; const actor = c.get("userEmail"); const db = primaryD1(c.env.DB);
  const previous = await rows(db, input.id);
  if (previous.canonical) {
    if (!previous.parent || previous.parent.actor_email !== actor || previous.parent.request_sha256 !== accepted.sha256 || previous.parent.request_input_json !== accepted.json) throw new HTTPException(409, { message: "This Comment submission ID already belongs to different content or an older upload" });
    return c.json({ id: input.id, deduplicated: true, request: await getCommentAcceptanceState(c.env, actor, input.id) });
  }
  const now = new Date().toISOString(); const expires = new Date(Date.parse(now) + COMMENT_ACCEPTANCE_LIFETIME_MS).toISOString();
  const plan = publicationPlan(input); const operation = crypto.randomUUID();
  const r2 = input.items.some((item) => item.kind === "comment_image") ? await ensureR2BootstrapProfile(db, c.env, now) : null;
  const managed = input.items.some((item) => item.kind === "attachment") ? await ensureManagedBootstrapProfile(db, c.env, now) : null;
  const sampleIds = input.context.kind === "sample" ? [input.context.sampleId] : [...new Set(input.context.targets.map((target) => target.sampleId))];
  const managedSample = managed && sampleIds.length === 1 ? await db.prepare("SELECT id,code FROM samples WHERE id=? AND deleted_at IS NULL").bind(sampleIds[0]).first<{id:string;code:string}>() : null;
  const statements: D1PreparedStatement[] = [];
  if (input.context.kind === "sample") {
    statements.push(db.prepare(`INSERT INTO comment_submissions (id, context_kind, sample_id, scope, body, status, actor_email, created_at, updated_at, retry_until)
      SELECT ?, 'sample', id, NULL, ?, 'uploading', ?, ?, ?, ? FROM samples WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`)
      .bind(input.id, input.body, actor, now, now, expires, input.context.sampleId, input.context.expectedUpdatedAt));
  } else {
    statements.push(db.prepare(`WITH requested(sample_id,run_id,step_id,revision) AS (VALUES ${input.context.targets.map(() => "(?,?,?,?)").join(",")})
      INSERT INTO comment_submissions (id,context_kind,sample_id,scope,body,status,actor_email,created_at,updated_at,retry_until)
      SELECT ?, 'run_steps', NULL, ?, ?, 'uploading', ?, ?, ?, ? WHERE (SELECT count(*) FROM requested q
        JOIN samples s ON s.id=q.sample_id AND s.deleted_at IS NULL JOIN runs r ON r.id=q.run_id AND r.sample_id=s.id AND r.deleted_at IS NULL
        JOIN run_steps rs ON rs.id=q.step_id AND rs.run_id=r.id AND rs.deleted_at IS NULL AND rs.updated_at=q.revision)=?`)
      .bind(...input.context.targets.flatMap((target) => [target.sampleId, target.runId, target.stepId, target.expectedUpdatedAt]), input.id, input.context.scope, input.body, actor, now, now, expires, input.context.targets.length));
  }
  statements.push(assertSql(db, "changes()=1"));
  if (input.context.kind === "run_steps") for (const target of input.context.targets) statements.push(db.prepare(`INSERT INTO comment_submission_targets (submission_id,sample_id,run_id,run_step_id,expected_updated_at) VALUES (?,?,?,?,?)`)
    .bind(input.id,target.sampleId,target.runId,target.stepId,target.expectedUpdatedAt));
  for (const [position,item] of input.items.entries()) {
    statements.push(db.prepare(`INSERT INTO comment_submission_items (id,submission_id,kind,status,position,filename,mime_type,byte_size,original_filename,original_mime_type,original_byte_size,title,description,external_url,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(item.id,input.id,item.kind,item.kind === "link" ? "ready" : "pending",position,
      item.kind === "link" ? null : item.filename,item.kind === "link" ? null : item.mimeType,item.kind === "link" ? null : item.byteSize,
      item.kind === "link" ? null : item.kind === "comment_image" ? item.originalFilename : item.filename,
      item.kind === "link" ? null : item.kind === "comment_image" ? item.originalMimeType : item.mimeType,
      item.kind === "link" ? null : item.kind === "comment_image" ? item.originalByteSize : item.byteSize,
      item.kind === "comment_image" ? null : item.kind === "attachment" ? item.title?.trim() || item.filename : item.title.trim(),
      item.kind === "link" ? item.description?.trim() || null : null,item.kind === "link" ? item.url : null,now,now));
  }
  for (const item of input.items) {
    const related = item.kind === "comment_image" ? item.relatedAttachmentId : item.kind === "attachment" ? item.relatedCommentImageId : null;
    if (related) statements.push(db.prepare("UPDATE comment_submission_items SET related_item_id=? WHERE id=? AND submission_id=?").bind(related,item.id,input.id));
  }
  statements.push(db.prepare(`INSERT INTO comment_submission_acceptances (submission_id,actor_email,operation_id,request_sha256,request_input_json,publication_plan_json,request_scope,storage_policy_revision,status,created_at,expires_at)
    VALUES (?,?,?,?,?,?,'system',1,'pending',?,?)`).bind(input.id,actor,operation,accepted.sha256,accepted.json,stableJson(plan),now,expires));
  for (const item of input.items) if (item.kind !== "link") {
    const profile = item.kind === "comment_image" ? r2! : managed!; const blob = crypto.randomUUID();
    const key = item.kind === "comment_image" ? `comments/${input.id}/${item.id}/${blob}-${safeAttachmentObjectName(item.filename)}`
      : managedObjectKey(input.id, `${item.id}-${blob}`, item.filename, managedSample ?? undefined);
    const purpose = item.kind === "attachment" ? "research_source" : item.relatedAttachmentId ? "derived_preview" : "embedded_content";
    statements.push(db.prepare(`INSERT INTO comment_item_acceptances (item_id,submission_id,actor_email,purpose,expected_sha256,expected_byte_size,storage_profile_id,storage_profile_revision,candidate_blob_id,candidate_object_key,status,created_at)
      VALUES (?,?,?,?,?,?,?,1,?,?,'pending',?)`).bind(item.id,input.id,actor,purpose,item.sha256!,item.byteSize,profile.id,blob,key,now));
  }
  statements.push(assertSql(db, "EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE submission_id=? AND operation_id=?) AND (SELECT count(*) FROM comment_item_acceptances WHERE submission_id=?)=?",[input.id,operation,input.id,input.items.filter((item) => item.kind !== "link").length]));
  try { await db.batch(statements); } catch { /* The same authoritative read reconciles conflicts and lost commit responses. */ }
  const saved = await rows(db,input.id);
  if (!saved.parent) throw new HTTPException(409, { message: "The Comment target changed before the submission was accepted" });
  if (saved.parent.actor_email !== actor || saved.parent.request_sha256 !== accepted.sha256 || saved.parent.request_input_json !== accepted.json) throw new HTTPException(409, { message: "This Comment submission ID already belongs to different content" });
  return c.json({id:input.id,deduplicated:saved.parent.operation_id !== operation,request:await getCommentAcceptanceState(c.env,actor,input.id)},saved.parent.operation_id === operation ? 201 : 200);
}
async function acceptedOwner(c: C) {
  const id = c.req.param("submissionId")!; const db = primaryD1(c.env.DB); const saved = await rows(db,id); requireAuthor(c.get("userEmail"),saved.canonical);
  if (!saved.parent) throw new HTTPException(409,{message:"This older unfinished Comment cannot resume uploads. Cancel it and create a new submission."});
  if (saved.parent.actor_email !== c.get("userEmail")) throw new HTTPException(404,{message:"Comment submission not found"});
  return { db, row:saved.parent, canonical:saved.canonical!, input:inputFor(saved.parent) };
}
export async function uploadAcceptedCommentItem(c: C) {
  c.header("Cache-Control","no-store"); const id=c.req.param("submissionId")!; const itemId=c.req.param("itemId")!;
  if (!validSubmissionId(id) || !validSubmissionId(itemId)) throw new HTTPException(400,{message:"Invalid upload identifier"});
  const {db,row,input}=await acceptedOwner(c); const item=input.items.find((entry)=>entry.id===itemId);
  if (!item) throw new HTTPException(404,{message:"Upload item not found"});
  if (item.kind === "link") throw new HTTPException(400,{message:"Link attachments do not receive file content"});
  if (Number(c.req.header("x-upload-size"))!==item.byteSize || c.req.header("content-type")!==item.mimeType || c.req.header("x-content-sha256")?.toLowerCase()!==item.sha256) throw new HTTPException(409,{message:"The file differs from the accepted Comment draft"});
  const stateBefore=await getCommentAcceptanceState(c.env,c.get("userEmail"),id);
  if (["cancelled","expired","unavailable"].includes(stateBefore.status) || stateBefore.items.find((entry)=>entry.id===itemId)?.status === "cancelled") return c.json({ok:false,request:stateBefore},409);
  if (!c.req.raw.body) throw new HTTPException(400,{message:"The upload body is missing"});
  let buffer:ArrayBuffer|undefined;
  if (item.kind === "comment_image") {
    buffer=await boundedBody(c.req.raw,5*1024*1024);
    if (buffer.byteLength!==item.byteSize || await sha256Hex(buffer)!==item.sha256) throw new HTTPException(409,{message:"The file differs from the accepted Comment draft"});
  }
  const getItem=()=>db.prepare("SELECT * FROM comment_item_acceptances WHERE item_id=? AND submission_id=?").bind(itemId,id).first<CommentItemAcceptanceRow>();
  let accepted=await getItem(); if(!accepted)failClosed();
  if (accepted.execution_token || accepted.status!=="pending" || row.status!=="pending") {
    if (!buffer) await verifyUploadBody(c.req.raw.body! as ReadableStream<Uint8Array>,{sha256:item.sha256!,byteSize:item.byteSize});
    const request=await getCommentAcceptanceState(c.env,c.get("userEmail"),id,{itemId});
    return c.json({ok:request.items.find((entry)=>entry.id===itemId)?.status==="ready",deduplicated:true,request},request.items.find((entry)=>entry.id===itemId)?.status==="ready"?200:request.status==="pending"?202:409);
  }
  const token=crypto.randomUUID(); const started=new Date().toISOString();
  try { await db.batch([
    db.prepare(`UPDATE comment_item_acceptances SET execution_token=?,started_at=? WHERE item_id=? AND submission_id=? AND status='pending' AND execution_token IS NULL
      AND EXISTS(SELECT 1 FROM comment_submission_acceptances ca JOIN comment_submissions cs ON cs.id=ca.submission_id JOIN comment_submission_items csi ON csi.submission_id=cs.id
        WHERE ca.submission_id=? AND ca.status='pending' AND ca.expires_at>? AND cs.status NOT IN('ready','cancelled') AND cs.retry_closed_at IS NULL AND cs.deleted_at IS NULL
          AND csi.id=? AND csi.status<>'cancelled' AND csi.deleted_at IS NULL AND ${visibleCommentTargetsSql("cs")})`).bind(token,started,itemId,id,id,started,itemId),
    assertSql(db,"changes()=1"),
    db.prepare(`UPDATE comment_submission_items SET status='uploading',error_message=NULL,updated_at=? WHERE id=? AND submission_id=? AND status<>'cancelled' AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM comment_item_acceptances WHERE item_id=? AND execution_token=?)`).bind(started,itemId,id,itemId,token),
    assertSql(db,"changes()=1"),
  ]); } catch { /* Claim ownership is decided only by authoritative readback. */ }
  accepted=await getItem(); if(!accepted)failClosed();
  if(accepted.execution_token!==token || accepted.status!=="pending") {
    if(!buffer) await verifyUploadBody(c.req.raw.body! as ReadableStream<Uint8Array>,{sha256:item.sha256!,byteSize:item.byteSize});
    const request=await getCommentAcceptanceState(c.env,c.get("userEmail"),id);
    return c.json({ok:false,request},request.status==="pending"?202:409);
  }
  let result:CommentAcceptedItemResult;
  try {
    if(item.kind==="comment_image") {
      await assertR2BootstrapProfile(db,c.env,accepted.storage_profile_id,accepted.storage_profile_revision);
      const value=await ingestR2Attachment(c.env,{bytes:buffer!,originalName:item.filename,mimeType:item.mimeType,actorEmail:c.get("userEmail"),registrationId:accepted.candidate_blob_id,objectKey:()=>accepted.candidate_object_key});
      result={...value.handle,blobRecordId:value.handle.blobRecordId,storeKind:"r2",provider:"r2",deduplicated:value.deduplicated};
      await assertR2BootstrapProfile(db,c.env,accepted.storage_profile_id,accepted.storage_profile_revision);
    } else {
      await assertManagedBootstrapProfile(db,c.env,accepted.storage_profile_id,accepted.storage_profile_revision);
      const storage=managedStorage(c.env); if(!storage)failClosed();
      const value=await ingestManagedAttachment(c.env,storage,{body:c.req.raw.body!,originalName:item.filename,mimeType:item.mimeType,actorEmail:c.get("userEmail"),byteSize:item.byteSize,sha256:item.sha256!,registrationId:accepted.candidate_blob_id,objectKey:()=>accepted.candidate_object_key});
      result={...value.handle,blobRecordId:value.handle.blobRecordId,storeKind:"managed",provider:"switchdrive",deduplicated:value.deduplicated};
      await assertManagedBootstrapProfile(db,c.env,accepted.storage_profile_id,accepted.storage_profile_revision);
    }
  } catch (error) {
    if (error instanceof AttachmentIngestionHashMismatchError) throw new HTTPException(400,{message:"Attachment checksum changed during upload"});
    if (error instanceof AttachmentIngestionByteSizeMismatchError) throw new HTTPException(400,{message:"Attachment size changed during upload"});
    failClosed();
  }
  const now=new Date().toISOString();
  try { await db.batch([
    db.prepare(`UPDATE comment_submission_items SET status='ready',${item.kind==="comment_image"?"asset_id":"storage_object_id"}=?,sha256=?,error_message=NULL,updated_at=?
      WHERE id=? AND submission_id=? AND status<>'cancelled' AND deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM comment_item_acceptances ia JOIN comment_submission_acceptances ca ON ca.submission_id=ia.submission_id
          JOIN comment_submissions cs ON cs.id=ca.submission_id WHERE ia.item_id=? AND ia.execution_token=? AND ia.status='pending'
          AND ca.status='pending' AND ca.expires_at>? AND cs.status NOT IN('ready','cancelled') AND cs.retry_closed_at IS NULL AND cs.deleted_at IS NULL AND ${visibleCommentTargetsSql("cs")})`)
      .bind(result.blobRecordId,item.sha256!,now,itemId,id,itemId,token,now),
    assertSql(db,"changes()=1"),
    db.prepare("UPDATE comment_item_acceptances SET status='ready',accepted_result_json=? WHERE item_id=? AND execution_token=?")
      .bind(stableJson(result),itemId,token),
    assertSql(db,"changes()=1 AND EXISTS(SELECT 1 FROM comment_item_acceptances WHERE item_id=? AND execution_token=? AND status='ready')",[itemId,token]),
  ]); } catch { /* Reconcile an uncertain atomic item publication without another PUT. */ }
  const request=await getCommentAcceptanceState(c.env,c.get("userEmail"),id);
  const ready=request.items.find((entry)=>entry.id===itemId)?.status==="ready";
  return c.json({ok:ready,deduplicated:result.deduplicated,request},ready?200:request.status==="pending"?202:409);
}
export async function finalizeAcceptedComment(c: C) {
  c.header("Cache-Control","no-store"); const id=c.req.param("submissionId")!; const {db,row,input}=await acceptedOwner(c);
  const state=await getCommentAcceptanceState(c.env,c.get("userEmail"),id,{allPending:true});
  if(state.status==="ready")return c.json({ok:true,status:"ready" as const,request:state});
  if(state.status!=="pending" || state.items.some((item)=>!["ready","cancelled"].includes(item.status)))return c.json({ok:false,request:state},409);
  const plan=planFor(row); const now=new Date().toISOString(); const actor=c.get("userEmail");
  const included=state.items.filter((item)=>item.status==="ready").map((item)=>item.id);
  const result={submissionId:id,completedAt:now,occurrenceIds:plan.occurrences.map((item)=>item.id),eventIds:plan.events.map((event)=>event.id),itemIds:included};
  const statements:D1PreparedStatement[]=[db.prepare(`UPDATE comment_submissions SET status='ready',error_message=NULL,completed_at=?,updated_at=?,last_mutation_id=?,retry_closed_at=?,retry_closed_by=?
    WHERE id=? AND status NOT IN('ready','cancelled') AND retry_closed_at IS NULL AND deleted_at IS NULL AND ${visibleCommentTargetsSql("comment_submissions")}
      AND EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE submission_id=? AND status='pending' AND expires_at>?)
      AND NOT EXISTS(SELECT 1 FROM comment_submission_items WHERE submission_id=? AND deleted_at IS NULL AND status NOT IN('ready','cancelled'))`)
    .bind(now,now,plan.mutationId,now,actor,id,id,now,id),assertSql(db,"changes()=1")];
  if(input.context.kind==="run_steps")for(const occurrence of plan.occurrences) {
    const target=input.context.targets[occurrence.targetIndex];
    statements.push(db.prepare(`INSERT INTO run_step_comments(id,run_step_id,scope,operation_group_id,submission_id,actor_email,created_at)
      SELECT ?,rs.id,?,?,?,?,? FROM run_steps rs JOIN runs r ON r.id=rs.run_id JOIN samples s ON s.id=r.sample_id
      WHERE rs.id=? AND r.id=? AND s.id=? AND rs.deleted_at IS NULL AND r.deleted_at IS NULL AND s.deleted_at IS NULL`)
      .bind(occurrence.id,input.context.scope,plan.operationGroupId,id,actor,now,target.stepId,target.runId,target.sampleId),assertSql(db,"changes()=1"));
    statements.push(db.prepare("UPDATE run_steps SET updated_at=?,updated_by=? WHERE id=? AND run_id=? AND deleted_at IS NULL").bind(now,actor,target.stepId,target.runId),assertSql(db,"changes()=1"));
  }
  for(const event of plan.events) {
    const targetIds=input.context.kind==="run_steps"?input.context.targets.filter((target)=>target.sampleId===event.sampleId).map((target)=>target.stepId):[];
    const body=input.context.kind==="sample"?input.body:`${input.context.scope==="common"?"Common step comment":"Step comment"}: ${input.body||"Files attached"}`;
    const metadata=input.context.kind==="sample"?{action:"comment_submission",submissionId:id}:{action:"comment_submission",submissionId:id,scope:input.context.scope,stepIds:targetIds};
    statements.push(db.prepare("INSERT INTO events(id,sample_id,kind,body,metadata_json,actor_email,created_at) SELECT ?,id,'comment',?,?,?,? FROM samples WHERE id=? AND deleted_at IS NULL")
      .bind(event.id,body,JSON.stringify(metadata),actor,now,event.sampleId),assertSql(db,"changes()=1"));
    statements.push(db.prepare("UPDATE samples SET updated_by=?,updated_at=? WHERE id=? AND deleted_at IS NULL").bind(actor,now,event.sampleId),assertSql(db,"changes()=1"));
  }
  statements.push(db.prepare("UPDATE comment_submission_acceptances SET status='ready',accepted_result_json=?,completed_at=? WHERE submission_id=? AND operation_id=?")
    .bind(stableJson(result),now,id,row.operation_id),assertSql(db,"changes()=1 AND EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE submission_id=? AND operation_id=? AND status='ready')",[id,row.operation_id]));
  try{await db.batch(statements);}catch{/* Reconcile finalization without regenerating any publication identity. */}
  const request=await getCommentAcceptanceState(c.env,actor,id);
  return c.json({ok:request.status==="ready",status:request.status,request},request.status==="ready"?200:409);
}
export async function cancelAcceptedComment(c:C) {
  c.header("Cache-Control","no-store"); const id=c.req.param("submissionId")!;const db=primaryD1(c.env.DB);const saved=await rows(db,id);requireAuthor(c.get("userEmail"),saved.canonical);
  if(saved.canonical!.status==="ready")throw new HTTPException(409,{message:"A completed Comment cannot be cancelled"});
  if(saved.canonical!.status!=="cancelled") {
    const now=new Date().toISOString();const mutation=crypto.randomUUID();
    try{await db.batch([
      db.prepare("UPDATE comment_submissions SET status='cancelled',cancelled_at=?,retry_closed_at=?,retry_closed_by=?,last_mutation_id=?,updated_at=?,error_message=NULL WHERE id=? AND status NOT IN('ready','cancelled') AND deleted_at IS NULL")
        .bind(now,now,c.get("userEmail"),mutation,now,id),assertSql(db,"changes()=1"),
      db.prepare("UPDATE comment_submission_items SET status='cancelled',updated_at=? WHERE submission_id=? AND status NOT IN('ready','cancelled') AND deleted_at IS NULL").bind(now,id),
      assertSql(db,"EXISTS(SELECT 1 FROM comment_submissions WHERE id=? AND status='cancelled')",[id]),
    ]);}catch{/* The current authoritative state determines whether cancellation won. */}
  }
  const request=await getCommentAcceptanceState(c.env,c.get("userEmail"),id);
  return c.json({ok:request.status==="cancelled",request},request.status==="cancelled"?200:409);
}
export function rethrowCommentAcceptanceError(error:unknown):never {
  if(error instanceof HTTPException)throw error;
  if(error instanceof ByteVerificationError && error.phase === "source" && ["hash_mismatch","size_mismatch"].includes(error.reason))
    throw new HTTPException(400,{message:error.reason === "hash_mismatch" ? "Attachment checksum changed during upload" : "Attachment size changed during upload"});
  throw new HTTPException(503,{message:"The Comment outcome could not be determined. Check the same submission again."});
}

export async function removeAcceptedCommentItem(c:C) {
  c.header("Cache-Control","no-store"); const id=c.req.param("submissionId")!;const itemId=c.req.param("itemId")!;
  const {db,input}=await acceptedOwner(c);if(!input.items.some((item)=>item.id===itemId))throw new HTTPException(404,{message:"Submission item not found"});
  let request=await getCommentAcceptanceState(c.env,c.get("userEmail"),id);
  if(request.items.find((item)=>item.id===itemId)?.status==="cancelled")return c.json({ok:true,request});
  if(request.status!=="pending")return c.json({ok:false,request},409);
  const now=new Date().toISOString();
  try{await db.batch([
    db.prepare(`UPDATE comment_submission_items SET status='cancelled',error_message=NULL,updated_at=? WHERE id=? AND submission_id=? AND status<>'cancelled' AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM comment_submissions cs JOIN comment_submission_acceptances ca ON ca.submission_id=cs.id WHERE cs.id=?
        AND cs.status NOT IN('ready','cancelled') AND cs.deleted_at IS NULL AND cs.retry_closed_at IS NULL AND ca.status='pending'
        AND ca.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${visibleCommentTargetsSql("cs")})
      AND NOT EXISTS(SELECT 1 FROM comment_submission_items image WHERE image.submission_id=? AND image.related_item_id=?
        AND image.kind='comment_image' AND image.status<>'cancelled' AND image.deleted_at IS NULL AND (lower(trim(image.original_filename,char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))) LIKE '%.tif' OR lower(trim(image.original_filename,char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))) LIKE '%.tiff' OR lower(trim(CASE WHEN instr(image.original_mime_type,';')>0 THEN substr(image.original_mime_type,1,instr(image.original_mime_type,';')-1) ELSE image.original_mime_type END ,char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))) IN('image/tiff','image/x-tiff')))`)
      .bind(now,itemId,id,id,id,itemId),assertSql(db,"changes()=1"),
  ]);}catch{/* A committed cancellation and its receipt are read back together. */}
  request=await getCommentAcceptanceState(c.env,c.get("userEmail"),id);
  const removed=request.items.find((item)=>item.id===itemId)?.status==="cancelled";
  return c.json({ok:removed,request},removed?200:409);
}
