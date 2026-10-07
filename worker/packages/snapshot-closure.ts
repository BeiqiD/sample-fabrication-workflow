import type { ResearchRoot } from "../../shared/contracts/research-package-api";
import { packageUnionAllCtes } from "./snapshot-sql";

const consumerColumns = ["kind", "id", "sub", "slot", "alias_id", "file_id", "expected_purpose"] as const;

export const PACKAGE_SNAPSHOT_ROOTS_SQL = `WITH RECURSIVE
 capture AS MATERIALIZED(SELECT ? AS roots_json,? AS job_id,? AS captured_at),
 roots AS MATERIALIZED(SELECT json_extract(value,'$.kind') kind,json_extract(value,'$.id') id FROM capture,json_each(roots_json))`;

/** Business capture statements evaluate this closure inside the same primary
 * batch; root admission needs only PACKAGE_SNAPSHOT_ROOTS_SQL. Identity sets
 * use their canonical primary keys and OR membership to avoid recursively
 * expanding nonrecursive compound SELECTs during native D1 preparation.
 * Definitions never traverse back to their consumers. Common Comments include
 * only the already selected targets, while their canonical body/items are shared. */
export const PACKAGE_SNAPSHOT_CONTEXT_CLOSURE_SQL = `${PACKAGE_SNAPSHOT_ROOTS_SQL},
 selected_projects AS MATERIALIZED(SELECT p.* FROM projects p JOIN roots r ON r.kind='project' AND r.id=p.id),
 selected_project_items AS MATERIALIZED(SELECT i.* FROM project_items i JOIN selected_projects p ON p.id=i.project_id),
 selected_references AS MATERIALIZED(SELECT DISTINCT r.* FROM reference_targets r JOIN selected_project_items i ON i.reference_target_id=r.id),
 ref AS MATERIALIZED(SELECT target_type kind,target_id id FROM selected_references WHERE tombstoned_at IS NULL),
 explicit_comments AS MATERIALIZED(SELECT c.* FROM comment_submissions c WHERE c.id IN(SELECT id FROM ref WHERE kind='comment')
   OR c.id IN(SELECT submission_id FROM comment_submission_items WHERE id IN(SELECT id FROM ref WHERE kind='comment_attachment'))),
 full_samples AS MATERIALIZED(SELECT s.* FROM samples s WHERE s.id IN(SELECT id FROM roots WHERE kind='sample')
   OR s.id IN(SELECT id FROM ref WHERE kind='sample')),
 base_run_ids AS MATERIALIZED(SELECT r.id FROM runs r WHERE r.id IN(SELECT id FROM ref WHERE kind='run')
   OR r.id IN(SELECT rs.run_id FROM run_steps rs WHERE rs.id IN(SELECT id FROM ref WHERE kind='run_step'))
   OR r.id IN(SELECT rs.run_id FROM run_step_comments c JOIN run_steps rs ON rs.id=c.run_step_id WHERE c.id IN(SELECT id FROM ref WHERE kind='comment_occurrence'))
   OR r.id IN(SELECT rs.run_id FROM run_step_assets a JOIN run_steps rs ON rs.id=a.run_step_id WHERE a.id IN(SELECT id FROM ref WHERE kind='execution_image'))
   OR r.id IN(SELECT t.run_id FROM comment_submission_targets t JOIN explicit_comments c ON c.id=t.submission_id)
   OR r.sample_id IN(SELECT id FROM full_samples)),
 verification_ids(id) AS(SELECT v.id FROM state_verifications v WHERE v.sample_id IN(SELECT id FROM full_samples)
   OR v.after_run_step_id IN(SELECT id FROM run_steps WHERE run_id IN(SELECT id FROM base_run_ids))
   UNION SELECT v.previous_verification_id FROM state_verifications v JOIN verification_ids i ON i.id=v.id WHERE v.previous_verification_id IS NOT NULL),
 selected_verifications AS MATERIALIZED(SELECT v.* FROM state_verifications v JOIN verification_ids i ON i.id=v.id),
 selected_verification_steps AS MATERIALIZED(SELECT l.* FROM state_verification_steps l JOIN selected_verifications v ON v.id=l.verification_id),
 seed_run_ids AS MATERIALIZED(SELECT r.id FROM runs r WHERE r.id IN(SELECT id FROM base_run_ids)
   OR r.id IN(SELECT run_id FROM run_steps WHERE id IN(SELECT after_run_step_id FROM selected_verifications))
   OR r.id IN(SELECT run_id FROM run_steps WHERE id IN(SELECT run_step_id FROM selected_verification_steps))
   OR r.id IN(SELECT run_id FROM run_plan_revisions WHERE id IN(SELECT run_plan_revision_id FROM selected_verifications))),
 run_ids(id) AS(SELECT id FROM seed_run_ids UNION SELECT r.predecessor_run_id FROM runs r JOIN run_ids p ON p.id=r.id WHERE r.predecessor_run_id IS NOT NULL),
 selected_runs AS MATERIALIZED(SELECT r.* FROM runs r JOIN run_ids i ON i.id=r.id),
 selected_samples AS MATERIALIZED(SELECT s.* FROM samples s WHERE s.id IN(SELECT id FROM full_samples) OR s.id IN(SELECT sample_id FROM selected_runs)
   OR s.id IN(SELECT sample_id FROM explicit_comments WHERE context_kind='sample')),
 selected_run_steps AS MATERIALIZED(SELECT rs.* FROM run_steps rs JOIN selected_runs r ON r.id=rs.run_id)`;

export const PACKAGE_SNAPSHOT_CLOSURE_SQL = `${PACKAGE_SNAPSHOT_CONTEXT_CLOSURE_SQL},
 selected_run_plan_revisions AS MATERIALIZED(SELECT p.* FROM run_plan_revisions p JOIN selected_runs r ON r.id=p.run_id),
 selected_run_step_plan_links AS MATERIALIZED(SELECT l.* FROM run_step_plan_links l JOIN selected_run_plan_revisions p ON p.id=l.run_plan_revision_id),
 selected_comment_occurrences AS MATERIALIZED(SELECT c.* FROM run_step_comments c JOIN selected_run_steps rs ON rs.id=c.run_step_id),
 selected_comments AS MATERIALIZED(SELECT c.* FROM comment_submissions c WHERE
   (c.context_kind='sample' AND c.sample_id IN(SELECT id FROM full_samples))
   OR c.id IN(SELECT submission_id FROM selected_comment_occurrences WHERE submission_id IS NOT NULL)
   OR c.id IN(SELECT submission_id FROM comment_submission_targets WHERE run_step_id IN(SELECT id FROM selected_run_steps))
   OR c.id IN(SELECT id FROM ref WHERE kind='comment')
   OR c.id IN(SELECT submission_id FROM comment_submission_items WHERE id IN(SELECT id FROM ref WHERE kind='comment_attachment'))),
 selected_comment_targets AS MATERIALIZED(SELECT t.* FROM comment_submission_targets t JOIN selected_comments c ON c.id=t.submission_id
   JOIN selected_run_steps rs ON rs.id=t.run_step_id),
 selected_comment_items AS MATERIALIZED(SELECT i.* FROM comment_submission_items i JOIN selected_comments c ON c.id=i.submission_id),
 selected_execution_images AS MATERIALIZED(SELECT a.* FROM run_step_assets a JOIN selected_run_steps rs ON rs.id=a.run_step_id),
 selected_proposals AS MATERIALIZED(SELECT p.* FROM recipe_change_proposals p WHERE p.source_verification_id IN(SELECT id FROM selected_verifications)),
 selected_recipe_revisions AS MATERIALIZED(SELECT v.* FROM template_versions v WHERE v.id IN(SELECT template_version_id FROM selected_runs)
   OR v.id IN(SELECT template_version_id FROM selected_run_plan_revisions)
   OR v.id IN(SELECT source_template_version_id FROM selected_proposals)
   OR v.id IN(SELECT id FROM ref WHERE kind='recipe_revision')
   OR v.id IN(SELECT template_version_id FROM metrology_template_references WHERE id IN(SELECT id FROM ref WHERE kind='metrology_reference'))
   OR v.id IN(SELECT template_version_id FROM template_steps WHERE id IN(SELECT template_step_id FROM selected_run_steps))),
 selected_template_steps AS MATERIALIZED(SELECT ts.* FROM template_steps ts JOIN selected_recipe_revisions v ON v.id=ts.template_version_id),
 selected_families AS MATERIALIZED(SELECT f.* FROM recipe_families f WHERE f.id IN(SELECT recipe_family_id FROM selected_recipe_revisions)
   OR f.id IN(SELECT recipe_family_id FROM selected_runs) OR f.id IN(SELECT recipe_family_id FROM selected_proposals)),
 selected_states AS MATERIALIZED(SELECT s.* FROM state_representations s WHERE s.hash IN(SELECT inherited_state_hash FROM selected_samples)
   OR s.hash IN(SELECT initial_state_hash FROM selected_runs) OR s.hash IN(SELECT initial_state_hash FROM selected_recipe_revisions)
   OR s.hash IN(SELECT expected_state_hash FROM selected_run_steps) OR s.hash IN(SELECT expected_state_hash FROM selected_template_steps)
   OR s.hash IN(SELECT expected_state_hash FROM selected_verifications)),
 selected_state_assets AS MATERIALIZED(SELECT a.* FROM state_representation_assets a JOIN selected_states s ON s.hash=a.state_hash),
 selected_definitions AS MATERIALIZED(SELECT d.* FROM step_definitions d WHERE d.hash IN(SELECT definition_hash FROM selected_run_steps)
   OR d.hash IN(SELECT definition_hash FROM selected_template_steps)),
 selected_metrology_references AS MATERIALIZED(SELECT m.* FROM metrology_template_references m JOIN selected_recipe_revisions v ON v.id=m.template_version_id),
 selected_events AS MATERIALIZED(SELECT e.* FROM events e JOIN full_samples s ON s.id=e.sample_id),
 selected_project_contents AS MATERIALIZED(SELECT c.* FROM project_contents c JOIN selected_projects p ON p.id=c.project_id),
 selected_project_attachments AS MATERIALIZED(SELECT a.* FROM project_content_attachments a JOIN selected_project_contents c ON c.id=a.project_content_id),
 selected_project_placements AS MATERIALIZED(SELECT p.* FROM project_map_placements p JOIN selected_project_items i ON i.id=p.project_item_id),
 selected_project_edges AS MATERIALIZED(SELECT e.* FROM project_edges e JOIN selected_projects p ON p.id=e.project_id),
 selected_source_imports AS MATERIALIZED(SELECT i.* FROM imports i JOIN selected_recipe_revisions v ON v.id=i.template_version_id),
 selected_attachment_derivatives AS MATERIALIZED(SELECT d.* FROM attachment_derivatives d WHERE d.derived_file_id IN(SELECT file_id FROM selected_comment_items)
   OR d.derived_asset_id IN(SELECT asset_id FROM selected_comment_items)),
 ${packageUnionAllCtes("required_consumers", consumerColumns, [
   `SELECT 'state_representation_asset',state_hash,asset_id,'primary','asset:'||asset_id,file_id,'embedded_content' FROM selected_state_assets`,
   `SELECT 'run_step_asset',id,'','primary','asset:'||asset_id,file_id,NULL FROM selected_execution_images`,
   `SELECT 'metrology_template_reference',id,'','primary','asset:'||asset_id,file_id,NULL FROM selected_metrology_references`,
   `SELECT 'run_step_comment',id,'','primary','asset:'||asset_id,file_id,'embedded_content' FROM selected_comment_occurrences WHERE asset_id IS NOT NULL OR file_id IS NOT NULL`,
   `SELECT 'state_verification',id,'','evidence','asset:'||evidence_asset_id,evidence_file_id,'embedded_content' FROM selected_verifications WHERE evidence_asset_id IS NOT NULL OR evidence_file_id IS NOT NULL`,
   `SELECT 'comment_submission_item',id,'','primary',COALESCE('asset:'||asset_id,'managed:'||storage_object_id),file_id,
     CASE WHEN kind='attachment' THEN 'research_source' WHEN kind='comment_image' AND related_item_id IS NOT NULL THEN 'derived_preview' ELSE 'embedded_content' END
     FROM selected_comment_items WHERE asset_id IS NOT NULL OR storage_object_id IS NOT NULL OR file_id IS NOT NULL`,
   `SELECT 'project_content_attachment',project_content_id,'','primary',COALESCE('asset:'||asset_id,'managed:'||storage_object_id),file_id,NULL FROM selected_project_attachments`,
   `SELECT 'attachment_derivative',id,'','derived','asset:'||derived_asset_id,derived_file_id,'derived_preview' FROM selected_attachment_derivatives WHERE derived_asset_id IS NOT NULL OR derived_file_id IS NOT NULL`,
   `SELECT 'event',id,'','primary','asset:'||json_extract(metadata_json,'$.assetId'),asset_file_id,'embedded_content' FROM selected_events WHERE asset_file_id IS NOT NULL OR NULLIF(trim(asset_key),'') IS NOT NULL`,
   `SELECT 'event',id,'','thumbnail','asset:'||json_extract(metadata_json,'$.thumbnailAssetId'),thumbnail_file_id,'derived_preview' FROM selected_events WHERE thumbnail_file_id IS NOT NULL
     OR(json_valid(metadata_json) AND json_type(metadata_json,'$.thumbnailKey')='text' AND NULLIF(trim(json_extract(metadata_json,'$.thumbnailKey')),'') IS NOT NULL)`,
   `SELECT 'import',id,'','workbook',NULL,workbook_file_id,'provenance' FROM selected_source_imports WHERE workbook_file_id IS NOT NULL OR NULLIF(trim(workbook_asset_key),'') IS NOT NULL`,
   `SELECT 'import',id,'','manifest',NULL,manifest_file_id,'provenance' FROM selected_source_imports WHERE manifest_file_id IS NOT NULL OR NULLIF(trim(manifest_asset_key),'') IS NOT NULL`,
   `SELECT 'template_version',id,'','source',NULL,source_file_id,'provenance' FROM selected_recipe_revisions WHERE source_file_id IS NOT NULL OR NULLIF(trim(source_asset_key),'') IS NOT NULL`,
 ])},
 base_bindings AS MATERIALIZED(SELECT c.*,CASE WHEN c.file_id IS NOT NULL THEN 'resolved'
   WHEN d.decision='admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END resolution_state FROM required_consumers c
   LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind=c.kind AND d.consumer_id=c.id AND d.consumer_sub_id=c.sub AND d.file_slot=c.slot),
 selected_derived_file_ids AS MATERIALIZED(SELECT f.id file_id FROM files f WHERE
   f.id IN(SELECT file_id FROM selected_comment_items WHERE kind='comment_image' AND related_item_id IS NOT NULL)
   OR f.id IN(SELECT thumbnail_file_id FROM selected_events)
   OR f.id IN(SELECT derived_file_id FROM selected_attachment_derivatives)
   OR f.id IN(SELECT file_id FROM selected_execution_images)
   OR f.id IN(SELECT file_id FROM selected_metrology_references)
   OR f.id IN(SELECT file_id FROM selected_project_attachments)),
 imported_claims AS MATERIALIZED(SELECT r.record_kind,r.record_json,m.destination_id,
   derived.result_file_id derived_file_id,derived.candidate_asset_id derived_asset_id,derived.purpose derived_purpose,
   original.result_file_id source_file_id,original.candidate_asset_id source_asset_id,original.purpose source_purpose
   FROM research_package_records r JOIN research_package_jobs j ON j.id=r.job_id AND j.kind='import' AND j.state='completed' AND j.phase='done'
   JOIN research_package_identity_maps m ON m.job_id=j.id AND m.entity_kind=r.record_kind AND m.source_id=r.source_id
   JOIN research_package_files derived ON derived.job_id=j.id AND derived.entry_kind='payload' AND derived.state='published'
     AND derived.logical_file_id=json_extract(r.record_json,'$.data.derivedPackageFileId')
   LEFT JOIN research_package_files original ON original.job_id=j.id AND original.entry_kind='payload' AND original.state='published'
     AND original.logical_file_id=json_extract(r.record_json,'$.data.sourcePackageFileId')
   WHERE r.record_kind IN('fileDerivation','attachmentDerivative') AND derived.purpose='derived_preview'
     AND derived.result_file_id IN(SELECT file_id FROM selected_derived_file_ids)
     AND (r.record_kind='attachmentDerivative' OR original.result_file_id IS NOT NULL)),
 ${packageUnionAllCtes("required_bindings", [...consumerColumns, "resolution_state"], [
   `SELECT * FROM base_bindings`,
   `SELECT 'package_claim',destination_id,'','derived','asset:'||derived_asset_id,derived_file_id,derived_purpose,'resolved' FROM imported_claims`,
   `SELECT 'package_claim',destination_id,'','source','asset:'||source_asset_id,source_file_id,source_purpose,'resolved' FROM imported_claims WHERE source_file_id IS NOT NULL`,
 ])},
 selected_files AS MATERIALIZED(SELECT DISTINCT f.* FROM required_bindings b JOIN file_usable_publications f ON f.file_id=b.file_id
   WHERE b.resolution_state='resolved' AND (b.expected_purpose IS NULL OR b.expected_purpose=f.purpose) AND f.access_scope='system'),
 selected_representations AS MATERIALIZED(SELECT DISTINCT f.*,b.alias_id FROM selected_files f JOIN required_bindings b ON b.file_id=f.file_id),
 selected_derivations AS MATERIALIZED(SELECT d.* FROM file_derivations d JOIN selected_files s ON s.file_id=d.source_file_id JOIN selected_files f ON f.file_id=d.derived_file_id),
 selected_assets AS MATERIALIZED(SELECT a.* FROM assets a WHERE a.id IN(SELECT asset_id FROM selected_state_assets)
   OR a.id IN(SELECT asset_id FROM selected_execution_images) OR a.id IN(SELECT asset_id FROM selected_metrology_references)
   OR a.id IN(SELECT asset_id FROM selected_comment_occurrences) OR a.id IN(SELECT asset_id FROM selected_comment_items)
   OR a.id IN(SELECT evidence_asset_id FROM selected_verifications) OR a.id IN(SELECT asset_id FROM selected_project_attachments)
   OR a.id IN(SELECT derived_asset_id FROM selected_attachment_derivatives)
   OR a.id IN(SELECT substr(alias_id,7) FROM required_bindings WHERE kind IN('event','package_claim'))),
 selected_managed AS MATERIALIZED(SELECT m.* FROM managed_storage_objects m WHERE m.id IN(SELECT storage_object_id FROM selected_comment_items)
   OR m.id IN(SELECT storage_object_id FROM selected_project_attachments)),
 captured_files AS MATERIALIZED(SELECT * FROM research_package_files WHERE job_id=(SELECT job_id FROM capture) AND entry_kind='source')`;

export function packageCaptureBindings(roots: ResearchRoot[], jobId: string, createdAt: string): [string, string, string] {
  return [JSON.stringify(roots), jobId, createdAt];
}
