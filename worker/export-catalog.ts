import { SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS } from "../shared/contracts/export-system-recovery-evidence";
import { FILE_SHADOW_ADJUDICATION_EXPORT_COLUMNS } from "../shared/contracts/file-shadow-adjudication";
import { FILE_SHADOW_WITHDRAWAL_EXPORT_COLUMNS } from "../shared/contracts/file-shadow-withdrawal";
import { FILE_SHADOW_EXPORT_COLUMNS, FILE_SHADOW_EXPORTED_VIEW_COLUMNS } from "../shared/contracts/file-shadow-schema";
import { fileShadowArchiveColumn } from "../shared/contracts/file-shadow-rowid";

// The full-system export inventories every canonical application table and
// the retention projection in stable order within one D1 snapshot batch.
export const FULL_EXPORT_V8_TABLE_QUERIES = {
  // Freeze these physical fields for schema 7 while compatibility readers are
  // deployed. Future bridge columns require the negotiated archive upgrade.
  samples: `SELECT id, code, title, description, status, location, parent_id, pinned,
    process_revision, created_by, updated_by, last_mutation_id, created_at, updated_at,
    inherited_state_hash, deleted_at, deleted_by FROM samples ORDER BY created_at, id`,
  events: "SELECT * FROM events ORDER BY created_at, id",
  recipe_families: "SELECT * FROM recipe_families ORDER BY created_at, id",
  step_definitions: "SELECT * FROM step_definitions ORDER BY hash",
  state_representations: "SELECT * FROM state_representations ORDER BY hash",
  state_representation_assets: "SELECT * FROM state_representation_assets ORDER BY state_hash, position",
  template_versions: "SELECT * FROM template_versions ORDER BY created_at, id",
  template_steps: "SELECT * FROM template_steps ORDER BY template_version_id, position",
  metrology_template_references: "SELECT * FROM metrology_template_references ORDER BY template_version_id, position, id",
  runs: "SELECT * FROM runs ORDER BY created_at, id",
  run_plan_revisions: "SELECT * FROM run_plan_revisions ORDER BY run_id, revision_no",
  run_steps: "SELECT * FROM run_steps ORDER BY run_id, position",
  run_step_plan_links: "SELECT * FROM run_step_plan_links ORDER BY run_plan_revision_id, template_step_id",
  run_step_comments: `SELECT id, run_step_id, scope, operation_group_id, body, asset_id,
    actor_email, created_at, submission_id, updated_at, updated_by, deleted_at,
    deleted_by, asset_deleted_at, asset_deleted_by, last_mutation_id,
    deletion_operation_id, asset_deletion_operation_id
    FROM run_step_comments ORDER BY run_step_id, created_at, id`,
  run_step_assets: "SELECT * FROM run_step_assets ORDER BY run_step_id, role, position",
  state_verifications: "SELECT * FROM state_verifications ORDER BY sample_id, created_at, id",
  state_verification_steps: "SELECT * FROM state_verification_steps ORDER BY verification_id, ordinal",
  recipe_change_proposals: "SELECT * FROM recipe_change_proposals ORDER BY created_at, id",
  imports: `SELECT id, status, source_filename, source_sha256, sheet_name, template_type, recipe_family_id,
    template_version_id, workbook_asset_key, manifest_asset_key, warning_count, error_message, actor_email,
    created_at, completed_at, operation_id, lease_expires_at, finalization_id, recovery_operation_id
    FROM imports ORDER BY created_at, id`,
  assets: "SELECT * FROM assets ORDER BY created_at, id",
  attachment_derivatives: `SELECT * FROM attachment_derivatives
    ORDER BY source_sha256, source_byte_size, derivative_kind, generator_version, id`,
  comment_submissions: "SELECT * FROM comment_submissions ORDER BY created_at, id",
  comment_submission_targets: "SELECT * FROM comment_submission_targets ORDER BY submission_id, run_step_id",
  comment_submission_items: "SELECT * FROM comment_submission_items ORDER BY submission_id, position",
  managed_storage_objects: "SELECT * FROM managed_storage_objects ORDER BY created_at, id",
  reference_targets: "SELECT * FROM reference_targets ORDER BY target_type, target_id",
  projects: "SELECT * FROM projects ORDER BY created_at, id",
  project_contents: "SELECT * FROM project_contents ORDER BY project_id, created_at, id",
  project_content_attachments: "SELECT * FROM project_content_attachments ORDER BY project_content_id",
  project_items: "SELECT * FROM project_items ORDER BY project_id, created_sequence, id",
  project_map_placements: "SELECT * FROM project_map_placements ORDER BY project_item_id, id",
  project_edges: "SELECT * FROM project_edges ORDER BY project_id, created_at, id",
  blob_gc_ledger: "SELECT * FROM blob_gc_ledger ORDER BY store_kind, provider, object_key",
  blob_integrity_quarantine: "SELECT * FROM blob_integrity_quarantine ORDER BY store_kind, provider, object_key",
  blob_retention_edges: `SELECT * FROM blob_retention_edges
    ORDER BY store_kind, provider, object_key, source_type, source_id, occurrence_type, occurrence_id`,
} as const;

// Schema 9 classifies all four dormant, non-secret mapping tables as canonical
// metadata. They neither add byte download roots nor authorize runtime writes.
export const FULL_EXPORT_V9_TABLE_QUERIES = {
  ...FULL_EXPORT_V8_TABLE_QUERIES,
  storage_profiles: "SELECT * FROM storage_profiles ORDER BY id",
  files: "SELECT * FROM files ORDER BY id",
  file_locations: "SELECT * FROM file_locations ORDER BY id",
  legacy_file_mappings: "SELECT * FROM legacy_file_mappings ORDER BY file_id",
} as const;

// Schema 10 also preserves the durable import request and accepted result.
export const FULL_EXPORT_V10_TABLE_QUERIES = {
  ...FULL_EXPORT_V9_TABLE_QUERIES,
  imports: "SELECT * FROM imports ORDER BY created_at, id",
} as const;

// Schema 11 retains accepted ordinary R2 upload decisions without adding bytes.
export const FULL_EXPORT_V11_TABLE_QUERIES = {
  ...FULL_EXPORT_V10_TABLE_QUERIES,
  r2_upload_requests: "SELECT * FROM r2_upload_requests ORDER BY created_at, id",
} as const;

// Schema 12 preserves metrology occurrence publication without new byte roots.
export const FULL_EXPORT_V12_TABLE_QUERIES = {
  ...FULL_EXPORT_V11_TABLE_QUERIES,
  metrology_reference_upload_requests: "SELECT * FROM metrology_reference_upload_requests ORDER BY created_at, id",
} as const;

// Schema 13 records Comment acceptance separately from canonical Comment rows.
// Keep this catalog frozen: a v13 request must never silently describe a
// post-transition physical schema.
export const FULL_EXPORT_V13_TABLE_QUERIES = {
  ...FULL_EXPORT_V12_TABLE_QUERIES,
  comment_submission_acceptances: "SELECT * FROM comment_submission_acceptances ORDER BY created_at, submission_id",
  comment_item_acceptances: "SELECT * FROM comment_item_acceptances ORDER BY submission_id, item_id",
} as const;

// Schema 14 additions are appended below once the transition migration has
// established their exact physical contract. file_registry_rowid_claims is a
// verified, rebuildable local-rowid guard and is deliberately not serialized.
export const FULL_EXPORT_V14_TABLE_QUERIES = {
  ...FULL_EXPORT_V13_TABLE_QUERIES,
  file_authority_control: "SELECT * FROM file_authority_control ORDER BY singleton",
  storage_profile_runtime: "SELECT * FROM storage_profile_runtime ORDER BY storage_profile_id",
  file_location_publications: "SELECT * FROM file_location_publications ORDER BY location_id",
  file_publications: "SELECT * FROM file_publications ORDER BY file_id",
  file_derivations: "SELECT * FROM file_derivations ORDER BY id",
  file_holds: "SELECT * FROM file_holds ORDER BY id",
  file_location_holds: "SELECT * FROM file_location_holds ORDER BY id",
  file_location_gc_ledger: "SELECT * FROM file_location_gc_ledger ORDER BY location_id",
  file_location_integrity_quarantine: "SELECT * FROM file_location_integrity_quarantine ORDER BY location_id",
  file_consumer_migration_decisions: "SELECT * FROM file_consumer_migration_decisions ORDER BY id",
  file_acceptance_candidates: "SELECT * FROM file_acceptance_candidates ORDER BY acceptance_kind, acceptance_id, item_id",
  file_consumer_relational_projection: "SELECT * FROM file_consumer_relational_projection ORDER BY consumer_kind, consumer_id, consumer_sub_id, file_slot",
  file_consumer_content_projection: "SELECT * FROM file_consumer_content_projection ORDER BY consumer_kind, consumer_id, consumer_sub_id, file_slot",
  file_consumer_direct_projection: "SELECT * FROM file_consumer_direct_projection ORDER BY consumer_kind, consumer_id, consumer_sub_id, file_slot",
  file_consumer_projection: "SELECT * FROM file_consumer_projection ORDER BY consumer_kind, consumer_id, consumer_sub_id, file_slot",
  file_relational_retention_edges: "SELECT * FROM file_relational_retention_edges ORDER BY file_id, source_type, source_id, occurrence_type, occurrence_id",
  file_content_retention_edges: "SELECT * FROM file_content_retention_edges ORDER BY file_id, source_type, source_id, occurrence_type, occurrence_id",
  file_direct_retention_edges: "SELECT * FROM file_direct_retention_edges ORDER BY file_id, source_type, source_id, occurrence_type, occurrence_id",
  file_retention_edges: "SELECT * FROM file_retention_edges ORDER BY file_id, source_type, source_id, occurrence_type, occurrence_id",
  file_location_retention_edges: "SELECT * FROM file_location_retention_edges ORDER BY location_id, source_type, source_id, occurrence_type, occurrence_id",
  file_location_availability: "SELECT * FROM file_location_availability ORDER BY location_id",
} as const;

// The unversioned catalog names the current writer without redefining its
// schema contract. Historical and current snapshotters use frozen catalogs.
export const FULL_EXPORT_V15_TABLE_QUERIES = {
  ...FULL_EXPORT_V14_TABLE_QUERIES,
  ...Object.fromEntries(Object.entries({ ...FILE_SHADOW_EXPORT_COLUMNS, ...FILE_SHADOW_EXPORTED_VIEW_COLUMNS })
    .map(([name, columns]) => [name, `SELECT ${columns.map((column) => fileShadowArchiveColumn(name, column)).join(", ")} FROM ${name} ORDER BY ${columns.join(", ")}`])),
} as const;
// V16 preserves the durable no-claim ledger without adding byte roots.
export const FULL_EXPORT_V16_TABLE_QUERIES = {
  ...FULL_EXPORT_V15_TABLE_QUERIES,
  ...Object.fromEntries(Object.entries(FILE_SHADOW_WITHDRAWAL_EXPORT_COLUMNS)
    .map(([name, columns]) => [name, `SELECT ${columns.join(", ")} FROM ${name} ORDER BY operation_id`])),
} as const;
// V17 retains occurrence-scoped adjudications, corrections and accepted bindings.
export const FULL_EXPORT_V17_TABLE_QUERIES = {
  ...FULL_EXPORT_V16_TABLE_QUERIES,
  ...Object.fromEntries(Object.entries(FILE_SHADOW_ADJUDICATION_EXPORT_COLUMNS)
    .map(([name, columns]) => [name, `SELECT ${columns.join(", ")} FROM ${name} ORDER BY ${columns[0]}`])),
} as const;
// V18 changes native guards and publication semantics without adding canonical tables.
export const FULL_EXPORT_V18_TABLE_QUERIES = { ...FULL_EXPORT_V17_TABLE_QUERIES } as const;
// V19 additionally retains immutable role defaults and the new Comment decision column.
export const FULL_EXPORT_V19_TABLE_QUERIES = {
  ...FULL_EXPORT_V18_TABLE_QUERIES,
  storage_role_defaults: "SELECT * FROM storage_role_defaults ORDER BY role",
} as const;
// V20 adds immutable S3 admission evidence without admitting any S3 byte root.
export const FULL_EXPORT_V20_TABLE_QUERIES = {
  ...FULL_EXPORT_V19_TABLE_QUERIES,
  storage_profile_admissions: "SELECT * FROM storage_profile_admissions ORDER BY operation_id",
} as const;
// V21 retains native execution provenance and each import item's immutable
// accepted target. Installation credential bindings are deliberately excluded.
export const FULL_EXPORT_V21_TABLE_QUERIES = {
  ...FULL_EXPORT_V20_TABLE_QUERIES,
  storage_profile_activations: "SELECT * FROM storage_profile_activations ORDER BY created_at, operation_id",
  storage_role_policy_revisions: "SELECT * FROM storage_role_policy_revisions ORDER BY policy_revision, role",
  import_file_acceptances: "SELECT * FROM import_file_acceptances ORDER BY import_id, item_id",
} as const;
// The live executor projection is rebuilt from a disabled local guard on restore.
export const FULL_EXPORT_V22_TABLE_QUERIES = {
  ...FULL_EXPORT_V21_TABLE_QUERIES,
  file_migration_jobs: "SELECT * FROM file_migration_jobs ORDER BY accepted_at, id",
  file_migration_items: "SELECT * FROM file_migration_items ORDER BY job_id, file_id",
  file_migration_attempts: "SELECT * FROM file_migration_attempts ORDER BY job_id, file_id, created_at, id",
} as const;
// Package staging and immutable copy provenance are portable audit history.
// Installation cleanup grants and the live executor projections are rebuilt.
export const FULL_EXPORT_V23_TABLE_QUERIES = {
  ...FULL_EXPORT_V22_TABLE_QUERIES,
  research_package_source_identity: "SELECT * FROM research_package_source_identity ORDER BY singleton",
  research_package_jobs: "SELECT * FROM research_package_jobs ORDER BY accepted_at, id",
  research_package_requests: "SELECT * FROM research_package_requests ORDER BY actor, request_id",
  research_package_records: "SELECT * FROM research_package_records ORDER BY job_id, ordinal, record_kind, source_id",
  research_package_files: "SELECT * FROM research_package_files ORDER BY job_id, logical_file_id",
  research_package_attempts: "SELECT * FROM research_package_attempts ORDER BY job_id, logical_file_id, created_at, id",
  research_package_identity_maps: "SELECT * FROM research_package_identity_maps ORDER BY job_id, entity_kind, source_id",
} as const;
export const FULL_EXPORT_V24_TABLE_QUERIES = {
  ...FULL_EXPORT_V23_TABLE_QUERIES,
  ...Object.fromEntries(Object.entries(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS)
    .map(([name, columns]) => [name, `SELECT ${columns.join(", ")} FROM ${name} ORDER BY ${columns.join(", ")}`])),
} as const;
export const FULL_EXPORT_TABLE_QUERIES = FULL_EXPORT_V24_TABLE_QUERIES;
