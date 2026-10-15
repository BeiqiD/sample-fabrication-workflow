/** Public research records are a closed domain vocabulary. The table mapping is
 * implementation metadata; it is never serialized into a package. */
export type ResearchFieldType = "text" | "integer" | "number" | "json";
export interface ResearchField { type: ResearchFieldType; nullable?: boolean; values?: readonly string[] }
export interface ResearchRelation { field: string; kind: ResearchRecordKind; nullable?: boolean; external?: boolean }
export interface ResearchRecordDefinition {
  table: string; id: readonly string[]; fields: Record<string, ResearchField>;
  relations?: readonly ResearchRelation[];
  revision: { scheme: "integer" | "timestamp" | "contentHash" | "snapshot"; field?: string };
}
const text = { type: "text" } as const;
const nullableText = { type: "text", nullable: true } as const;
const integer = { type: "integer" } as const;
const nullableInteger = { type: "integer", nullable: true } as const;
const number = { type: "number" } as const;
const json = { type: "json" } as const;
const nullableJson = { type: "json", nullable: true } as const;
const timestamp = { scheme: "timestamp", field: "updated_at" } as const;
const snapshot = { scheme: "snapshot" } as const;
const rowRevision = { scheme: "integer", field: "revision" } as const;
const hashRevision = { scheme: "contentHash", field: "hash" } as const;
const deletion = { deleted_at: nullableText, deleted_by: nullableText };
const mutation = { last_mutation_id: nullableText };
const attribution = { created_by: text, created_at: text, updated_by: text, updated_at: text };
const supersession = { superseded_by_occurrence_id: nullableText, superseded_at: nullableText, superseded_by: nullableText, supersession_operation_id: nullableText };

export const RESEARCH_RECORD_KINDS = [
  "sample", "run", "runStep", "runPlanRevision", "runStepPlanLink", "comment", "commentItem", "commentTarget",
  "commentOccurrence", "project", "projectContent", "projectAttachment", "projectItem", "projectPlacement", "projectEdge",
  "reference", "recipeFamily", "recipeRevision", "templateStep", "state", "stateAsset", "stepDefinition", "event",
  "stateVerification", "verificationStep", "metrologyReference", "executionImage", "recipeChangeProposal", "fileAlias", "sourceImport", "fileDerivation", "attachmentDerivative",
] as const;
export type ResearchRecordKind = typeof RESEARCH_RECORD_KINDS[number];

export const RESEARCH_PACKAGE_CATALOG: Record<ResearchRecordKind, ResearchRecordDefinition> = {
  sample: { table: "samples", id: ["id"], revision: timestamp, fields: {
    code: text, title: text, description: nullableText, status: text, location: nullableText, parent_id: nullableText,
    pinned: integer, created_by: nullableText, created_at: text, updated_at: text, updated_by: nullableText,
    inherited_state_hash: nullableText, ...deletion, ...mutation,
  }, relations: [{ field: "parent_id", kind: "sample", nullable: true, external: true }, { field: "inherited_state_hash", kind: "state", nullable: true }] },
  run: { table: "runs", id: ["id"], revision: snapshot, fields: {
    sample_id: text, recipe_family_id: text, template_version_id: text, current_plan_revision_id: nullableText,
    predecessor_run_id: nullableText, anchor_step_id: nullableText, sequence_no: integer, run_group_id: text,
    template_name_snapshot: text, template_type_snapshot: text, template_version_snapshot: integer,
    status: text, created_by: nullableText, created_at: text, completed_at: nullableText, initial_state_hash: nullableText,
    run_kind: { ...text, values: ["process", "metrology"] }, ...deletion, ...mutation,
  }, relations: [{ field: "sample_id", kind: "sample" }, { field: "recipe_family_id", kind: "recipeFamily" },
    { field: "template_version_id", kind: "recipeRevision", nullable: true }, { field: "current_plan_revision_id", kind: "runPlanRevision", nullable: true },
    { field: "predecessor_run_id", kind: "run", nullable: true }, { field: "anchor_step_id", kind: "runStep", nullable: true }, { field: "initial_state_hash", kind: "state", nullable: true }] },
  runStep: { table: "run_steps", id: ["id"], revision: timestamp, fields: {
    run_id: text, previous_step_id: nullableText, position: integer, origin: text, plan_status: text, template_step_id: nullableText,
    logical_step_key: nullableText, definition_hash: nullableText, expected_state_hash: nullableText, title: nullableText, status: text,
    notes: nullableText, tool_name: nullableText, parameters_text: nullableText, comments_text: nullableText, deviation_note: nullableText,
    actualized_at: nullableText, created_at: text, updated_by: nullableText, updated_at: text, entry_kind: text, ...deletion, ...mutation,
  }, relations: [{ field: "run_id", kind: "run" }, { field: "previous_step_id", kind: "runStep", nullable: true },
    { field: "template_step_id", kind: "templateStep", nullable: true }, { field: "definition_hash", kind: "stepDefinition", nullable: true }, { field: "expected_state_hash", kind: "state", nullable: true }] },
  runPlanRevision: { table: "run_plan_revisions", id: ["id"], revision: { scheme: "integer", field: "revision_no" }, fields: {
    run_id: text, revision_no: integer, template_version_id: text, effective_after_step_id: nullableText, reason: nullableText, actor_email: nullableText, created_at: text,
  }, relations: [{ field: "run_id", kind: "run" }, { field: "template_version_id", kind: "recipeRevision" }, { field: "effective_after_step_id", kind: "runStep", nullable: true }] },
  runStepPlanLink: { table: "run_step_plan_links", id: ["run_plan_revision_id", "template_step_id", "run_step_id"], revision: snapshot,
    fields: { run_plan_revision_id: text, template_step_id: text, run_step_id: text, relation: text, created_at: text }, relations: [
      { field: "run_plan_revision_id", kind: "runPlanRevision" }, { field: "template_step_id", kind: "templateStep" }, { field: "run_step_id", kind: "runStep" }] },
  comment: { table: "comment_submissions", id: ["id"], revision: timestamp, fields: {
    context_kind: text, sample_id: nullableText, scope: nullableText, body: text, status: text, error_message: nullableText,
    actor_email: nullableText, created_at: text, updated_at: text, completed_at: nullableText, cancelled_at: nullableText,
    excluded_targets: json,
    ...deletion, ...mutation, deletion_operation_id: nullableText, retry_until: nullableText, retry_closed_at: nullableText, retry_closed_by: nullableText,
  }, relations: [{ field: "sample_id", kind: "sample", nullable: true, external: true }] },
  commentItem: { table: "comment_submission_items", id: ["id"], revision: timestamp, fields: {
    submission_id: text, kind: text, status: text, position: integer, filename: nullableText, mime_type: nullableText, byte_size: nullableInteger,
    original_filename: nullableText, original_mime_type: nullableText, original_byte_size: nullableInteger, title: nullableText, description: nullableText,
    external_url: nullableText, asset_id: nullableText, storage_object_id: nullableText, packageFileId: nullableText,
    sha256: nullableText, related_item_id: nullableText, error_message: nullableText, created_at: text, updated_at: text, ...deletion,
  }, relations: [{ field: "submission_id", kind: "comment" }, { field: "related_item_id", kind: "commentItem", nullable: true },
    { field: "asset_id", kind: "fileAlias", nullable: true }, { field: "storage_object_id", kind: "fileAlias", nullable: true }] },
  commentTarget: { table: "comment_submission_targets", id: ["submission_id", "run_step_id"], revision: snapshot,
    fields: { submission_id: text, sample_id: text, run_id: text, run_step_id: text, expected_updated_at: text }, relations: [
      { field: "submission_id", kind: "comment" }, { field: "sample_id", kind: "sample" }, { field: "run_id", kind: "run" }, { field: "run_step_id", kind: "runStep" }] },
  commentOccurrence: { table: "run_step_comments", id: ["id"], revision: snapshot, fields: {
    run_step_id: text, scope: text, operation_group_id: nullableText, asset_id: nullableText, packageFileId: nullableText, actor_email: nullableText,
    created_at: text, submission_id: nullableText, updated_at: nullableText, updated_by: nullableText, ...deletion,
    asset_deleted_at: nullableText, asset_deleted_by: nullableText, ...mutation, deletion_operation_id: nullableText, asset_deletion_operation_id: nullableText, legacy_body: nullableText,
  }, relations: [{ field: "run_step_id", kind: "runStep" }, { field: "submission_id", kind: "comment", nullable: true }, { field: "asset_id", kind: "fileAlias", nullable: true }] },
  project: { table: "projects", id: ["id"], revision: rowRevision,
    fields: { title: text, revision: integer, next_created_sequence: integer, ...mutation, ...attribution, ...deletion, deletion_operation_id: nullableText } },
  projectContent: { table: "project_contents", id: ["id"], revision: rowRevision, fields: {
    project_id: text, content_type: text, markdown_source: nullableText, attachment_caption: nullableText, attachment_source_url: nullableText,
    format_version: integer, revision: integer, ...mutation, ...attribution, ...deletion, deletion_operation_id: nullableText,
  }, relations: [{ field: "project_id", kind: "project" }] },
  projectAttachment: { table: "project_content_attachments", id: ["project_content_id"], revision: snapshot,
    fields: { project_content_id: text, asset_id: nullableText, storage_object_id: nullableText, packageFileId: text, original_name: text, mime_type: text,
      byte_size: integer, created_by: text, created_at: text, creation_operation_id: text }, relations: [{ field: "project_content_id", kind: "projectContent" },
      { field: "asset_id", kind: "fileAlias", nullable: true }, { field: "storage_object_id", kind: "fileAlias", nullable: true }] },
  projectItem: { table: "project_items", id: ["id"], revision: rowRevision, fields: {
    project_id: text, item_type: text, project_content_id: nullableText, reference_target_id: nullableText, created_sequence: integer,
    revision: integer, ...mutation, ...attribution, ...deletion, deletion_operation_id: nullableText,
  }, relations: [{ field: "project_id", kind: "project" }, { field: "project_content_id", kind: "projectContent", nullable: true }, { field: "reference_target_id", kind: "reference", nullable: true }] },
  projectPlacement: { table: "project_map_placements", id: ["id"], revision: rowRevision, fields: {
    project_item_id: text, x: number, y: number, width: number, height: number, z_index: integer, revision: integer, ...mutation, ...attribution,
  }, relations: [{ field: "project_item_id", kind: "projectItem" }] },
  projectEdge: { table: "project_edges", id: ["id"], revision: rowRevision, fields: {
    project_id: text, source_item_id: text, target_item_id: text, source_handle: text, target_handle: text, marker_start: text, marker_end: text,
    label: nullableText, revision: integer, ...mutation, ...attribution, ...deletion, deletion_operation_id: nullableText,
  }, relations: [{ field: "project_id", kind: "project" }, { field: "source_item_id", kind: "projectItem" }, { field: "target_item_id", kind: "projectItem" }] },
  reference: { table: "reference_targets", id: ["id"], revision: snapshot, fields: {
    registry_version: integer, target: json, contexts: json, resolution: { ...text, values: ["included", "unresolved", "deleted", "excluded"] },
    first_registered_at: text, last_validated_at: text, tombstoned_at: nullableText,
  } },
  recipeFamily: { table: "recipe_families", id: ["id"], revision: snapshot, fields: {
    name: text, template_type: text, created_at: text, created_by: nullableText, archived_at: nullableText, archived_by: nullableText,
  } },
  recipeRevision: { table: "template_versions", id: ["id"], revision: { scheme: "integer", field: "version" }, fields: {
    recipe_family_id: text, name: text, template_type: text, version: integer, manifest_hash: text, initial_state_hash: nullableText,
    source_filename: nullableText, sourcePackageFileId: nullableText, content_json: json, created_at: text, created_by: nullableText,
    locked_at: nullableText, locked_by: nullableText, archived_at: nullableText, archived_by: nullableText, ...deletion, template_kind: text, metrology_notes: nullableText,
  }, relations: [{ field: "recipe_family_id", kind: "recipeFamily" }, { field: "initial_state_hash", kind: "state", nullable: true }] },
  templateStep: { table: "template_steps", id: ["id"], revision: snapshot, fields: {
    template_version_id: text, logical_step_key: text, position: integer, source_row: nullableInteger, step_number: nullableText, section_name: nullableText,
    definition_hash: text, expected_state_hash: nullableText, raw_json: nullableJson,
  }, relations: [{ field: "template_version_id", kind: "recipeRevision" }, { field: "definition_hash", kind: "stepDefinition" }, { field: "expected_state_hash", kind: "state", nullable: true }] },
  state: { table: "state_representations", id: ["hash"], revision: hashRevision, fields: {
    hash_scheme: text, representation_type: text, logical_state_key: nullableText, content_json: json, created_at: text,
  } },
  stateAsset: { table: "state_representation_assets", id: ["state_hash", "asset_id"], revision: snapshot,
    fields: { state_hash: text, asset_id: text, position: integer, packageFileId: text }, relations: [{ field: "state_hash", kind: "state" }, { field: "asset_id", kind: "fileAlias" }] },
  stepDefinition: { table: "step_definitions", id: ["hash"], revision: hashRevision,
    fields: { hash_scheme: text, name: text, tool_name: nullableText, parameters_text: nullableText, comments_text: nullableText, canonical_json: json, created_at: text } },
  event: { table: "events", id: ["id"], revision: snapshot, fields: {
    sample_id: text, kind: text, body: nullableText, metadata: json, relationships: json, packageFileId: nullableText, thumbnailPackageFileId: nullableText,
    actor_email: nullableText, created_at: text,
  }, relations: [{ field: "sample_id", kind: "sample" }] },
  stateVerification: { table: "state_verifications", id: ["id"], revision: snapshot, fields: {
    sample_id: text, after_run_step_id: text, previous_verification_id: nullableText, run_plan_revision_id: nullableText, expected_state_hash: nullableText,
    result: text, evidence_asset_id: nullableText, evidencePackageFileId: nullableText, note: nullableText, status: text, actor_email: nullableText, created_at: text,
  }, relations: [{ field: "sample_id", kind: "sample" }, { field: "after_run_step_id", kind: "runStep" }, { field: "previous_verification_id", kind: "stateVerification", nullable: true },
    { field: "run_plan_revision_id", kind: "runPlanRevision", nullable: true }, { field: "expected_state_hash", kind: "state", nullable: true }, { field: "evidence_asset_id", kind: "fileAlias", nullable: true }] },
  verificationStep: { table: "state_verification_steps", id: ["verification_id", "run_step_id"], revision: snapshot,
    fields: { verification_id: text, run_step_id: text, ordinal: integer }, relations: [{ field: "verification_id", kind: "stateVerification" }, { field: "run_step_id", kind: "runStep" }] },
  metrologyReference: { table: "metrology_template_references", id: ["id"], revision: snapshot, fields: {
    template_version_id: text, asset_id: text, packageFileId: text, display_name: nullableText, position: integer, actor_email: nullableText, created_at: text,
    ...deletion, ...supersession,
  }, relations: [{ field: "template_version_id", kind: "recipeRevision" }, { field: "asset_id", kind: "fileAlias" }, { field: "superseded_by_occurrence_id", kind: "metrologyReference", nullable: true }] },
  executionImage: { table: "run_step_assets", id: ["id"], revision: snapshot, fields: {
    run_step_id: text, asset_id: text, packageFileId: text, role: text, position: integer, actor_email: nullableText, created_at: text, ...deletion,
    ...mutation, ...supersession, filename: nullableText, mime_type: nullableText, byte_size: nullableInteger,
  }, relations: [{ field: "run_step_id", kind: "runStep" }, { field: "asset_id", kind: "fileAlias" }, { field: "superseded_by_occurrence_id", kind: "executionImage", nullable: true }] },
  recipeChangeProposal: { table: "recipe_change_proposals", id: ["id"], revision: snapshot,
    fields: { recipe_family_id: text, source_template_version_id: text, source_verification_id: nullableText, change_type: text, body: text, status: text, actor_email: nullableText, created_at: text },
    relations: [{ field: "recipe_family_id", kind: "recipeFamily" }, { field: "source_template_version_id", kind: "recipeRevision" }, { field: "source_verification_id", kind: "stateVerification", nullable: true }] },
  fileAlias: { table: "assets", id: ["id"], revision: snapshot, fields: {
    alias_kind: { ...text, values: ["asset", "managed"] }, packageFileId: text, original_name: text, mime_type: text, byte_size: integer, sha256: text, created_at: text,
  } },
  sourceImport: { table: "imports", id: ["id"], revision: snapshot, fields: {
    status: text, source_filename: text, source_sha256: text, sheet_name: text, template_type: text, recipe_family_id: nullableText,
    template_version_id: nullableText, workbookPackageFileId: nullableText, manifestPackageFileId: nullableText, warning_count: integer,
    error_message: nullableText, actor_email: nullableText, created_at: text, completed_at: nullableText,
  }, relations: [{ field: "recipe_family_id", kind: "recipeFamily", nullable: true }, { field: "template_version_id", kind: "recipeRevision", nullable: true }] },
  fileDerivation: { table: "file_derivations", id: ["id"], revision: snapshot, fields: {
    sourcePackageFileId: text, derivedPackageFileId: text, generator: text, generator_version: text, parameters_sha256: text,
    source_sha256: text, derived_sha256: text, trust_state: { ...text, values: ["imported_unverified"] }, created_at: text,
  } },
  attachmentDerivative: { table: "attachment_derivatives", id: ["id"], revision: timestamp, fields: {
    source_sha256: text, source_byte_size: integer, derivative_kind: { ...text, values: ["browser_preview"] }, generator_version: text,
    derived_asset_id: nullableText, derivedPackageFileId: nullableText, status: text, error_code: nullableText, retain_until: nullableText,
    actor_email: nullableText, created_at: text, updated_at: text, trust_state: { ...text, values: ["imported_unverified"] },
  }, relations: [{ field: "derived_asset_id", kind: "fileAlias", nullable: true }] },
};

/** Only these historical JSON positions carry typed identities. User prose and
 * raw cells remain literal provenance and are never searched/replaced. */
export const RESEARCH_EVENT_RELATIONSHIP_FIELDS = {
  parentId: { kind: "sample", array: false }, childIds: { kind: "sample", array: true },
  sampleId: { kind: "sample", array: false }, runId: { kind: "run", array: false },
  runIds: { kind: "run", array: true }, stepId: { kind: "runStep", array: false }, stepIds: { kind: "runStep", array: true },
  coveredStepIds: { kind: "runStep", array: true }, afterStepId: { kind: "runStep", array: false },
  templateVersionId: { kind: "recipeRevision", array: false }, planRevisionId: { kind: "runPlanRevision", array: false },
  verificationId: { kind: "stateVerification", array: false }, previousVerificationId: { kind: "stateVerification", array: false },
  runStepAssetId: { kind: "executionImage", array: false }, submissionId: { kind: "comment", array: false },
  originalEventId: { kind: "event", array: false }, assetId: { kind: "fileAlias", array: false },
  thumbnailAssetId: { kind: "fileAlias", array: false }, evidenceAssetId: { kind: "fileAlias", array: false },
  inheritedStateHash: { kind: "state", array: false }, expectedStateHash: { kind: "state", array: false },
  operationGroupId: { kind: "group", array: false }, deletionOperationId: { kind: "operation", array: false },
  operationId: { kind: "operation", array: false },
} as const;

export function researchCompositeSourceId(parts: readonly string[]): string { return JSON.stringify(parts); }
export function isResearchRecordKind(value: unknown): value is ResearchRecordKind {
  return typeof value === "string" && (RESEARCH_RECORD_KINDS as readonly string[]).includes(value);
}
