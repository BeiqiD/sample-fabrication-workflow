import { configurationSqlInteger } from "../runtime/configuration-sql";
import type { FileAuthoritySqlDatabase, FileAuthoritySqlStatement } from "../runtime/file-authority-sql";

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
export async function readSqlFileAuthorityStatus(database: FileAuthoritySqlDatabase) {
  const row = await database.primary().prepare(`SELECT a.mode,a.updated_at,a.activated_at,c.epoch,
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
  if (!row) return null;
  const output = { ...row };
  for (const name of ["epoch", "enabled", "shadow_enabled", "current_count", "resolved_count", "unfinished_attempts", "pending_receipts",
    "unfinished_failed_imports", "unattached_ready_uploads", "unpublished_candidates", "legacy_deleting", "file_deleting"])
    output[name] = configurationSqlInteger(row[name], `fileAuthorityStatus.${name}`);
  return output;
}

/** Stages the same mature activation checkpoint/bindings/control batch.
 * Operator authority and native transaction ownership belong to the genuine
 * composer. Preparing these statements does not activate File or any provider. */
export function prepareSqlFileAuthorityActivation(database: FileAuthoritySqlDatabase, actor: string, input: {
  requestId: string; expectedEpoch: number; expectedShadowIncarnation: string | null;
}, now: string): FileAuthoritySqlStatement[] {
  input = Object.freeze({ ...input });
  const db = database.primary();
  return [
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
  ];
}

/** The checkpoint and control update commit together. Native control triggers
 * re-read the whole current occurrence set, drain pending work, fill every
 * typed binding and enable local execution in the same atomic D1 batch. */
export async function activateSqlFileAuthority(database: FileAuthoritySqlDatabase, actor: string, input: {
  requestId: string; expectedEpoch: number; expectedShadowIncarnation: string | null;
}) {
  input = Object.freeze({ ...input });
  const db = database.primary();
  const previous = await db.prepare(`SELECT c.id FROM file_shadow_checkpoints c JOIN file_authority_runtime_guard r
    ON r.incarnation=c.id JOIN file_authority_control a ON a.singleton=r.singleton
    WHERE c.id=? AND c.captured_by=? AND a.mode='active'`).bind(input.requestId, actor).first();
  if (previous) return readSqlFileAuthorityStatus(db);
  const now = new Date().toISOString();
  await db.batch(prepareSqlFileAuthorityActivation(db, actor, input, now));
  return readSqlFileAuthorityStatus(db);
}

export async function enableSqlRecoveredFileAuthority(database: FileAuthoritySqlDatabase, actor: string, input: {
  requestId: string; expectedIncarnation: string | null;
}) {
  input = Object.freeze({ ...input });
  const db = database.primary();
  const previous = await db.prepare("SELECT 1 FROM file_authority_runtime_guard WHERE singleton=1 AND incarnation=? AND enabled_by=? AND enabled=1")
    .bind(input.requestId, actor).first();
  if (previous) return readSqlFileAuthorityStatus(db);
  await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_control c JOIN file_authority_runtime_guard r ON r.singleton=c.singleton
      WHERE c.mode='active' AND r.enabled=0 AND r.incarnation IS ?) THEN 1 ELSE json('File runtime admission changed') END`)
      .bind(input.expectedIncarnation),
    db.prepare("UPDATE file_authority_runtime_guard SET incarnation=?,enabled=1,enabled_by=?,updated_at=? WHERE singleton=1")
      .bind(input.requestId, actor, new Date().toISOString()),
  ]);
  return readSqlFileAuthorityStatus(db);
}

