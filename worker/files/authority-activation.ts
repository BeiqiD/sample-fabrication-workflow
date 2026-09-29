import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { requireFileEvidenceOperator } from "./evidence-operator";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const activationBindingStatements = [
  "UPDATE state_representation_assets SET file_id=(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='state_representation_asset' AND b.consumer_id=state_hash AND b.consumer_sub_id=asset_id AND b.file_slot='primary')\n  WHERE file_id IS NULL",
  "UPDATE run_step_assets SET file_id=(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='run_step_asset' AND b.consumer_id=run_step_assets.id AND b.file_slot='primary') WHERE file_id IS NULL",
  "UPDATE metrology_template_references SET file_id=(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='metrology_template_reference' AND b.consumer_id=metrology_template_references.id AND b.file_slot='primary') WHERE file_id IS NULL",
  "UPDATE run_step_comments SET file_id=(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='run_step_comment' AND b.consumer_id=run_step_comments.id AND b.file_slot='primary') WHERE file_id IS NULL",
  "UPDATE state_verifications SET evidence_file_id=(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='state_verification' AND b.consumer_id=state_verifications.id AND b.file_slot='evidence') WHERE evidence_file_id IS NULL",
  "UPDATE comment_submission_items SET file_id=(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='comment_submission_item' AND b.consumer_id=comment_submission_items.id AND b.file_slot='primary') WHERE file_id IS NULL",
  "UPDATE project_content_attachments SET file_id=(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='project_content_attachment' AND b.consumer_id=project_content_attachments.project_content_id AND b.file_slot='primary') WHERE file_id IS NULL",
  "UPDATE attachment_derivatives SET derived_file_id=(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='attachment_derivative' AND b.consumer_id=attachment_derivatives.id AND b.file_slot='derived') WHERE derived_file_id IS NULL",
  "UPDATE events SET asset_file_id=COALESCE(asset_file_id,(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='event' AND b.consumer_id=events.id AND b.file_slot='primary')),\n thumbnail_file_id=COALESCE(thumbnail_file_id,(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='event' AND b.consumer_id=events.id AND b.file_slot='thumbnail'))",
  "UPDATE imports SET workbook_file_id=COALESCE(workbook_file_id,(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='import' AND b.consumer_id=imports.id AND b.file_slot='workbook')),\n manifest_file_id=COALESCE(manifest_file_id,(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='import' AND b.consumer_id=imports.id AND b.file_slot='manifest'))",
  "UPDATE template_versions SET source_file_id=(SELECT b.file_id FROM file_authority_activation_bindings b\n  WHERE b.consumer_kind='template_version' AND b.consumer_id=template_versions.id AND b.file_slot='source') WHERE source_file_id IS NULL"
];
export async function readFileAuthorityStatus(database: D1Database) {
  return primaryD1(database).prepare(`SELECT a.mode,a.updated_at,a.activated_at,c.epoch,
    r.incarnation,r.enabled,r.enabled_by,r.updated_at runtime_updated_at,s.enabled shadow_enabled,s.incarnation shadow_incarnation,
    (SELECT count(*) FROM file_shadow_heads WHERE present=1) current_count,
    (SELECT count(*) FROM file_authority_activation_bindings) resolved_count,
    (SELECT count(*) FROM file_shadow_attempts WHERE state IN('staged','write_started','unknown','verified')) unfinished_attempts,
    (SELECT count(*) FROM r2_upload_requests WHERE status='pending')+
    (SELECT count(*) FROM metrology_reference_upload_requests WHERE status='pending')+
    (SELECT count(*) FROM comment_submission_acceptances WHERE status='pending')+
    (SELECT count(*) FROM comment_item_acceptances WHERE status='pending')+
    (SELECT count(*) FROM imports WHERE status='pending') pending_receipts,
    (SELECT count(*) FROM imports i WHERE i.operation_id IS NOT NULL AND i.finalization_id IS NULL
      AND i.status='failed' AND i.recovery_operation_id IS NULL AND (i.template_version_id IS NOT NULL
       OR i.workbook_asset_key IS NOT NULL OR i.manifest_asset_key IS NOT NULL OR EXISTS(SELECT 1 FROM assets a WHERE a.import_id=i.id))) unfinished_failed_imports,
    (SELECT count(*) FROM r2_upload_requests r WHERE r.status='ready' AND r.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
     AND NOT EXISTS(SELECT 1 FROM file_authority_activation_bindings b JOIN file_shadow_occurrences occurrence ON occurrence.id=b.occurrence_id
       JOIN file_usable_publications f ON f.file_id=b.file_id JOIN assets a
        ON a.id=json_extract(r.accepted_result_json,'$.id') AND a.r2_key=json_extract(r.accepted_result_json,'$.key')
       WHERE occurrence.legacy_store_kind='r2' AND occurrence.legacy_object_key=a.r2_key
        AND f.purpose=r.purpose AND f.access_scope=r.request_scope AND f.verified_byte_size=json_extract(r.request_input_json,'$.file.byteSize')
        AND f.verified_sha256=json_extract(r.request_input_json,'$.file.sha256') AND a.byte_size=f.verified_byte_size AND a.sha256=f.verified_sha256)) unattached_ready_uploads,
    (SELECT count(*) FROM file_acceptance_candidates WHERE state='candidate') unpublished_candidates,
    (SELECT count(*) FROM blob_gc_ledger WHERE state='deleting') legacy_deleting,
    (SELECT count(*) FROM file_location_gc_ledger WHERE state='deleting') file_deleting
    FROM file_authority_control a JOIN file_shadow_control c ON c.singleton=a.singleton
    JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
    JOIN file_shadow_runtime_guard s ON s.singleton=a.singleton WHERE a.singleton=1`).first();
}

/** The checkpoint and control update commit together. Native control triggers
 * re-read the whole current occurrence set, drain pending work, fill every
 * typed binding and enable local execution in the same atomic D1 batch. */
export async function activateFileAuthority(database: D1Database, actor: string, input: {
  requestId: string; expectedEpoch: number; expectedShadowIncarnation: string | null;
}) {
  const db = primaryD1(database);
  const previous = await db.prepare(`SELECT c.id FROM file_shadow_checkpoints c JOIN file_authority_runtime_guard r
    ON r.incarnation=c.id JOIN file_authority_control a ON a.singleton=r.singleton
    WHERE c.id=? AND c.captured_by=? AND a.mode='active'`).bind(input.requestId, actor).first();
  if (previous) return readFileAuthorityStatus(db);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_shadow_control c JOIN file_shadow_runtime_guard r ON r.singleton=c.singleton
      JOIN file_authority_control a ON a.singleton=c.singleton WHERE c.singleton=1 AND c.epoch=? AND r.incarnation IS ?
      AND r.enabled=0 AND a.mode='overlap') THEN 1 ELSE json('File activation cutoff changed') END`)
      .bind(input.expectedEpoch, input.expectedShadowIncarnation),
    db.prepare(`INSERT INTO file_shadow_checkpoints(id,captured_epoch,current_count,resolved_count,unresolved_count,pending_count,captured_by,captured_at)
      SELECT ?,?,(SELECT count(*) FROM file_shadow_heads WHERE present=1),
      (SELECT count(*) FROM file_shadow_heads WHERE present=1),0,0,?,?`)
      .bind(input.requestId, input.expectedEpoch, actor, now),
    db.prepare("UPDATE file_authority_runtime_guard SET incarnation=?,enabled_by=?,updated_at=? WHERE singleton=1 AND enabled=0")
      .bind(input.requestId, actor, now),
    ...activationBindingStatements.map(sql => db.prepare(sql)),
    db.prepare("UPDATE file_authority_control SET mode='active',updated_at=? WHERE singleton=1 AND mode='overlap'").bind(now),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_control c JOIN file_authority_runtime_guard r ON r.singleton=c.singleton
      WHERE c.mode='active' AND r.enabled=1 AND r.incarnation=? AND r.enabled_by=?)
      THEN 1 ELSE json('File activation did not commit') END`).bind(input.requestId, actor),
  ]);
  return readFileAuthorityStatus(db);
}

export async function enableRecoveredFileAuthority(database: D1Database, actor: string, input: {
  requestId: string; expectedIncarnation: string | null;
}) {
  const db = primaryD1(database);
  const previous = await db.prepare("SELECT 1 FROM file_authority_runtime_guard WHERE singleton=1 AND incarnation=? AND enabled_by=? AND enabled=1")
    .bind(input.requestId, actor).first();
  if (previous) return readFileAuthorityStatus(db);
  await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_control c JOIN file_authority_runtime_guard r ON r.singleton=c.singleton
      WHERE c.mode='active' AND r.enabled=0 AND r.incarnation IS ?) THEN 1 ELSE json('File runtime admission changed') END`)
      .bind(input.expectedIncarnation),
    db.prepare("UPDATE file_authority_runtime_guard SET incarnation=?,enabled=1,enabled_by=?,updated_at=? WHERE singleton=1")
      .bind(input.requestId, actor, new Date().toISOString()),
  ]);
  return readFileAuthorityStatus(db);
}

export const fileAuthorityRoutes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
fileAuthorityRoutes.use("/files/authority/*", requireFileEvidenceOperator);
fileAuthorityRoutes.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status)
  : c.json({ error: "File authority changed or still has unfinished work. Inspect its current status before retrying." }, 409));
fileAuthorityRoutes.get("/files/authority/status", async c => c.json(await readFileAuthorityStatus(c.env.DB)));
async function command(request: Request, expectedKeys: string[]): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 2048) throw new HTTPException(400, { message: "Invalid File authority command" });
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { throw new HTTPException(400, { message: "Invalid File authority command" }); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== expectedKeys.sort().join(",") || !UUID.test(String(value.requestId))) {
    throw new HTTPException(400, { message: "Invalid File authority command" });
  }
  return value;
}
fileAuthorityRoutes.post("/files/authority/activate", async c => {
  const input = await command(c.req.raw, ["requestId", "expectedEpoch", "expectedShadowIncarnation"]);
  if (typeof input.expectedEpoch !== "number" || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0
    || input.expectedShadowIncarnation !== null && !UUID.test(String(input.expectedShadowIncarnation))) throw new HTTPException(400);
  return c.json(await activateFileAuthority(c.env.DB, c.get("userEmail"), input as unknown as Parameters<typeof activateFileAuthority>[2]));
});
fileAuthorityRoutes.post("/files/authority/enable-recovered", async c => {
  const input = await command(c.req.raw, ["requestId", "expectedIncarnation", "previousInstallationStopped"]);
  if (input.previousInstallationStopped !== true
    || input.expectedIncarnation !== null && !UUID.test(String(input.expectedIncarnation))) throw new HTTPException(400);
  return c.json(await enableRecoveredFileAuthority(c.env.DB, c.get("userEmail"), input as unknown as Parameters<typeof enableRecoveredFileAuthority>[2]));
});
