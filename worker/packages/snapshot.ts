import type { JobSqlDatabase, JobSqlStatement } from "../files/jobs/sql-repository";
import {
  RESEARCH_PACKAGE_MAX_FILE_BYTES, RESEARCH_PACKAGE_MAX_FILES, RESEARCH_PACKAGE_MAX_METADATA_BYTES, RESEARCH_PACKAGE_MAX_RECORDS,
  checkedResearchExportPlanInput, type ResearchExportKind, type ResearchRoot, type ResearchPackagePreview,
} from "../../shared/contracts/research-package-api";
import { RESEARCH_PACKAGE_CATALOG, RESEARCH_RECORD_KINDS, RESEARCH_EVENT_RELATIONSHIP_FIELDS, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import {
  researchRecordKey, researchReferenceKind, type ResearchDomainRecord, type ResearchDependency, type ResearchPackageFile,
  researchRecordsDocument, type ResearchEntityRef, type ResearchDependencyResolution, type ResearchPackageV1, type ResearchReportV1,
  RESEARCH_PACKAGE_MAX_RECORD_BYTES, checkedResearchPackageManifest, checkedResearchReportManifest,
} from "../../shared/contracts/research-package";
import { sha256Hex, stableJson } from "../../shared/domain/content-addressing";
import { PACKAGE_SNAPSHOT_CLOSURE_SQL, PACKAGE_SNAPSHOT_CONTEXT_CLOSURE_SQL, PACKAGE_SNAPSHOT_ROOTS_SQL, packageCaptureBindings } from "./snapshot-closure";
import { packageUnionAllCtes } from "./snapshot-sql";

export interface PackageSnapshotInput {
  jobId: string; actor: string; roots: ResearchRoot[]; packageId: string; sourceInstallationId: string; createdAt: string; kind?: ResearchExportKind;
}
const selected: Record<ResearchRecordKind, string> = {
  sample: "selected_samples", run: "selected_runs", runStep: "selected_run_steps", runPlanRevision: "selected_run_plan_revisions",
  runStepPlanLink: "selected_run_step_plan_links", comment: "selected_comments", commentItem: "selected_comment_items",
  commentTarget: "selected_comment_targets", commentOccurrence: "selected_comment_occurrences", project: "selected_projects",
  projectContent: "selected_project_contents", projectAttachment: "selected_project_attachments", projectItem: "selected_project_items",
  projectPlacement: "selected_project_placements", projectEdge: "selected_project_edges", reference: "selected_references",
  recipeFamily: "selected_families", recipeRevision: "selected_recipe_revisions", templateStep: "selected_template_steps",
  state: "selected_states", stateAsset: "selected_state_assets", stepDefinition: "selected_definitions", event: "selected_events",
  stateVerification: "selected_verifications", verificationStep: "selected_verification_steps", metrologyReference: "selected_metrology_references",
  executionImage: "selected_execution_images", recipeChangeProposal: "selected_proposals", fileAlias: "selected_assets",
  sourceImport: "selected_source_imports", fileDerivation: "selected_derivations", attachmentDerivative: "selected_attachment_derivatives",
};
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function filePointer(sourceFileId: string, sourceAliasId = "NULL") {
  // The earlier statements already pinned and guarded the exact File/alias
  // representations. Resolve serialization against that immutable capture;
  // expanding the entire selective graph again for every JSON field exceeds
  // SQLite's table-reference budget on a real imported graph.
  return `(SELECT f.logical_file_id FROM captured_files f
    WHERE f.source_file_id=${sourceFileId} AND f.source_alias_id IS ${sourceAliasId})`;
}
const pointer: Partial<Record<ResearchRecordKind, Record<string, string>>> = {
  stateAsset: { packageFileId: filePointer("s.file_id", "'asset:'||s.asset_id") },
  executionImage: { packageFileId: filePointer("s.file_id", "'asset:'||s.asset_id") },
  metrologyReference: { packageFileId: filePointer("s.file_id", "'asset:'||s.asset_id") },
  commentOccurrence: { packageFileId: filePointer("s.file_id", "'asset:'||s.asset_id") },
  stateVerification: { evidencePackageFileId: filePointer("s.evidence_file_id", "'asset:'||s.evidence_asset_id") },
  commentItem: { packageFileId: filePointer("s.file_id", "COALESCE('asset:'||s.asset_id,'managed:'||s.storage_object_id)") },
  projectAttachment: { packageFileId: filePointer("s.file_id", "COALESCE('asset:'||s.asset_id,'managed:'||s.storage_object_id)") },
  event: { packageFileId: filePointer("s.asset_file_id", "'asset:'||json_extract(s.metadata_json,'$.assetId')"),
    thumbnailPackageFileId: filePointer("s.thumbnail_file_id", "'asset:'||json_extract(s.metadata_json,'$.thumbnailAssetId')") },
  sourceImport: { workbookPackageFileId: filePointer("s.workbook_file_id"), manifestPackageFileId: filePointer("s.manifest_file_id") },
  recipeRevision: { sourcePackageFileId: filePointer("s.source_file_id") },
  attachmentDerivative: { derivedPackageFileId: filePointer("s.derived_file_id", "'asset:'||s.derived_asset_id") },
};

const eventKeys = Object.keys(RESEARCH_EVENT_RELATIONSHIP_FIELDS);
const removedMetadataKeys = [...eventKeys, "thumbnailKey", "assetKey", "r2_key", "object_key", "objectKey", "fileId", "storageProfileId", "storageProfileRevision", "provider", "storeKind", "sourceLocator"];
function eventRelationshipsSql() {
  const scalar = Object.entries(RESEARCH_EVENT_RELATIONSHIP_FIELDS).filter(([, value]) => !value.array)
    .map(([field, value]) => `SELECT ${quote(field)} field,${quote(value.kind)} kind,${value.kind === "fileAlias" ? "'asset:'||" : ""}json_extract(s.metadata_json,${quote(`$.${field}`)}) id
      WHERE json_type(s.metadata_json,${quote(`$.${field}`)})='text'`);
  const arrays = Object.entries(RESEARCH_EVENT_RELATIONSHIP_FIELDS).filter(([, value]) => value.array)
    .map(([field, value]) => `SELECT ${quote(field)}||'['||j.key||']',${quote(value.kind)},j.value FROM json_each(s.metadata_json,${quote(`$.${field}`)}) j WHERE j.type='text'`);
  return `json(COALESCE((WITH ${packageUnionAllCtes("event_relationships", ["field", "kind", "id"], [...scalar, ...arrays])}
    SELECT json_group_array(json_object('field',field,'target',json_object('kind',kind,'sourceId',id),'resolution','unresolved'))
    FROM event_relationships), '[]'))`;
}
function referenceTargetSql() {
  const branches = Object.entries({ sample: "sample", run: "run", run_step: "runStep", comment: "comment", comment_occurrence: "commentOccurrence",
    comment_attachment: "commentItem", execution_image: "executionImage", metrology_reference: "metrologyReference", recipe_revision: "recipeRevision" });
  return `json_object('kind',CASE s.target_type ${branches.map(([type, kind]) => `WHEN ${quote(type)} THEN ${quote(kind)}`).join(" ")} END,'sourceId',s.target_id)`;
}
function referenceContextsSql() {
  const kinds = `CASE json_extract(segment.value,'$.type') WHEN 'sample' THEN 'sample' WHEN 'run' THEN 'run'
    WHEN 'run_step' THEN 'runStep' WHEN 'recipe_revision' THEN 'recipeRevision' END`;
  return `json(COALESCE((SELECT json_group_array(json_object('segments',json(COALESCE((SELECT json_group_array(json_object(
    'target',json_object('kind',${kinds},'sourceId',json_extract(segment.value,'$.id')),
    'label',json_extract(segment.value,'$.label'),'deletedAt',json_extract(segment.value,'$.deletedAt'),
    'archivedAt',json_extract(segment.value,'$.archivedAt'),'resolution','excluded'))
    FROM json_each(context.value,'$.segments') segment),'[]')))) FROM json_each(s.last_known_contexts_json) context),'[]'))`;
}

function dataExpression(kind: ResearchRecordKind, field: string, managed = false): string {
  if (pointer[kind]?.[field]) return pointer[kind]![field];
  if (field === "storage_object_id") return "CASE WHEN s.storage_object_id IS NOT NULL THEN 'managed:'||s.storage_object_id END";
  if (field === "asset_id" || field === "evidence_asset_id" || field === "derived_asset_id") return `'asset:'||s.${field}`;
  if (kind === "attachmentDerivative" && field === "trust_state") return "'imported_unverified'";
  if (kind === "fileAlias") {
    if (field === "alias_kind") return quote(managed ? "managed" : "asset");
    if (field === "packageFileId") return `(SELECT logical_file_id FROM captured_files WHERE source_alias_id=${managed ? "'managed:'||s.id" : "'asset:'||s.id"})`;
    if (field === "sha256" || field === "byte_size") return `COALESCE(s.${field},(SELECT ${field === "sha256" ? "sha256" : "byte_size"} FROM captured_files
      WHERE source_alias_id=${managed ? "'managed:'||s.id" : "'asset:'||s.id"}))`;
  }
  if (kind === "reference") {
    if (field === "target") return referenceTargetSql();
    if (field === "contexts") return referenceContextsSql();
    if (field === "resolution") return "CASE WHEN s.tombstoned_at IS NOT NULL THEN 'deleted' ELSE 'unresolved' END";
  }
  if (kind === "comment" && field === "excluded_targets") return `json(COALESCE((SELECT json_group_array(json_object(
    'sample',json_object('kind','sample','sourceId',t.sample_id),'run',json_object('kind','run','sourceId',t.run_id),
    'step',json_object('kind','runStep','sourceId',t.run_step_id),'resolution','excluded'))
    FROM comment_submission_targets t WHERE t.submission_id=s.id AND t.run_step_id NOT IN(SELECT id FROM selected_run_steps)),'[]'))`;
  if (kind === "event") {
    if (field === "metadata") return `json(json_remove(s.metadata_json,${removedMetadataKeys.map(key => quote(`$.${key}`)).join(",")}))`;
    if (field === "relationships") return eventRelationshipsSql();
  }
  if (kind === "recipeRevision" && field === "content_json") {
    // Imported image/local IDs were source staging identities. The immutable
    // State and its ordered File associations carry the live identity instead.
    return `json_object('initialSubstrateStep',CASE WHEN json_type(s.content_json,'$.initialSubstrateStep')='object' THEN
      json_object('name',json_extract(s.content_json,'$.initialSubstrateStep.name'),
        'toolName',json_extract(s.content_json,'$.initialSubstrateStep.toolName'),
        'parametersText',json_extract(s.content_json,'$.initialSubstrateStep.parametersText'),
        'commentsText',json_extract(s.content_json,'$.initialSubstrateStep.commentsText'),
        'stepNumber',json_extract(s.content_json,'$.initialSubstrateStep.stepNumber'),
        'sourceRow',json_extract(s.content_json,'$.initialSubstrateStep.sourceRow'),
        'rawCells',json(COALESCE(json_extract(s.content_json,'$.initialSubstrateStep.rawCells'),'{}'))) ELSE NULL END,'provenance',
      json_object('schemaVersion',json_extract(s.content_json,'$.schemaVersion'),'importedTitle',json_extract(s.content_json,'$.importedTitle'),
        'objectKind',json_extract(s.content_json,'$.objectKind'),'warningCount',json_extract(s.content_json,'$.warningCount')))`;
  }
  if (kind === "fileDerivation") {
    if (field === "sourcePackageFileId" || field === "derivedPackageFileId") return `(SELECT logical_file_id FROM captured_files
      WHERE source_file_id=s.${field === "sourcePackageFileId" ? "source_file_id" : "derived_file_id"}
      ORDER BY source_alias_id,logical_file_id LIMIT 1)`;
    if (field === "source_sha256" || field === "derived_sha256") return `(SELECT sha256 FROM captured_files
      WHERE source_file_id=s.${field === "source_sha256" ? "source_file_id" : "derived_file_id"} ORDER BY source_alias_id,logical_file_id LIMIT 1)`;
    if (field === "trust_state") return "'imported_unverified'";
  }
  const rule = RESEARCH_PACKAGE_CATALOG[kind].fields[field];
  return rule.type === "json" ? `json(s.${field})` : `s.${field}`;
}
function recordSelectSql(kind: ResearchRecordKind, ordinal: number, managed = false) {
  const definition = RESEARCH_PACKAGE_CATALOG[kind], ids = definition.id.map(field => field === "asset_id" ? `'asset:'||s.${field}` : `s.${field}`);
  const sourceId = kind === "fileAlias" ? `${managed ? "'managed:'" : "'asset:'"}||s.id` : ids.length === 1 ? ids[0] : `json_array(${ids.join(",")})`;
  const revision = definition.revision.scheme === "snapshot" ? "(SELECT captured_at FROM capture)"
    : definition.revision.scheme === "contentHash" ? sourceId : `s.${definition.revision.field}`;
  const data = `json_object(${Object.keys(definition.fields).flatMap(field => [quote(field), dataExpression(kind, field, managed)]).join(",")})`;
  return `SELECT (SELECT job_id FROM capture),${quote(kind)},${sourceId},
      json_object('kind',${quote(kind)},'sourceId',${sourceId}||'','sourceRevision',json_object('scheme',${quote(definition.revision.scheme)},'value',${revision}),'data',${data}),
      ${ordinal} FROM ${managed ? "selected_managed" : selected[kind]} s`;
}
function importedClaimSelectSql() {
  const currentFile = (field: "source" | "derived") => `(SELECT logical_file_id FROM captured_files
    WHERE source_file_id=c.${field}_file_id AND source_alias_id IS ('asset:'||c.${field}_asset_id))`;
  return `SELECT (SELECT job_id FROM capture),c.record_kind,c.destination_id,
    CASE WHEN c.record_kind='fileDerivation' THEN json_set(c.record_json,'$.sourceId',c.destination_id,
      '$.sourceRevision',json_object('scheme','snapshot','value',(SELECT captured_at FROM capture)),
      '$.data.trust_state','imported_unverified','$.data.derivedPackageFileId',${currentFile("derived")},'$.data.sourcePackageFileId',${currentFile("source")})
    ELSE json_set(c.record_json,'$.sourceId',c.destination_id,'$.data.trust_state','imported_unverified',
      '$.data.derivedPackageFileId',${currentFile("derived")},'$.data.derived_asset_id','asset:'||c.derived_asset_id) END,
    ${RESEARCH_RECORD_KINDS.length} FROM imported_claims c`;
}

/** Caller inserts the immutable job first and executes ALL returned statements
 * in one fresh-primary batch. No source read, object I/O, or hold occurs earlier. */
export function buildPackageSnapshotStatements(db: JobSqlDatabase, input: PackageSnapshotInput): JobSqlStatement[] {
  const kind = input.kind ?? "data_package", plan = checkedResearchExportPlanInput({ kind, roots: input.roots });
  const bindings = packageCaptureBindings(plan.roots, input.jobId, input.createdAt);
  const statements = [db.prepare(`${PACKAGE_SNAPSHOT_ROOTS_SQL} SELECT iif(
    (SELECT count(*) FROM roots)=(SELECT count(*) FROM roots r WHERE
      (r.kind='sample' AND EXISTS(SELECT 1 FROM samples s WHERE s.id=r.id AND s.deleted_at IS NULL))
      OR(r.kind='project' AND EXISTS(SELECT 1 FROM projects p WHERE p.id=r.id AND p.deleted_at IS NULL)))
    AND EXISTS(SELECT 1 FROM research_package_jobs j JOIN research_package_source_identity s ON s.singleton=1
      WHERE j.id=? AND j.actor=? AND j.package_id=? AND j.source_installation_id=? AND j.source_installation_id=s.installation_id
        AND j.accepted_at=? AND j.kind=?),1,json('Package source authorization or identity changed'))`)
    .bind(...bindings, input.jobId, input.actor, input.packageId, input.sourceInstallationId, input.createdAt, kind)];
  if (kind === "data_package") statements.push(db.prepare(`${PACKAGE_SNAPSHOT_CLOSURE_SQL} SELECT iif(
    NOT EXISTS(SELECT 1 FROM required_bindings b WHERE b.file_id IS NULL OR b.resolution_state<>'resolved'
      OR NOT EXISTS(SELECT 1 FROM selected_files f WHERE f.file_id=b.file_id AND (b.expected_purpose IS NULL OR b.expected_purpose=f.purpose)))
    AND(NOT EXISTS(SELECT 1 FROM required_bindings) OR EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'))
    AND NOT EXISTS(SELECT alias_id FROM required_bindings WHERE alias_id IS NOT NULL GROUP BY alias_id HAVING count(DISTINCT file_id)>1),
    1,json('Package source has unresolved or unavailable File authority'))`).bind(...bindings));
  // Archive paths are part of immutable file identity, so compute them in the
  // insert through one generated-ID projection rather than updating afterwards.
  statements.push(db.prepare(`${PACKAGE_SNAPSHOT_CLOSURE_SQL},
    representations AS MATERIALIZED(SELECT f.*, 'f_'||lower(hex(randomblob(16))) logical_id FROM selected_representations f)
    INSERT INTO research_package_files(job_id,logical_file_id,entry_kind,purpose,byte_size,sha256,archive_path,media_type,
      source_file_id,source_location_id,source_profile_id,source_profile_revision,source_namespace,source_object_key,source_alias_id,
      hold_operation_id,state,updated_at)
    SELECT (SELECT job_id FROM capture),f.logical_id,'source',f.purpose,f.verified_byte_size,f.verified_sha256,
      'files/'||f.logical_id,COALESCE((SELECT mime_type FROM selected_assets a WHERE 'asset:'||a.id=f.alias_id),
        (SELECT mime_type FROM selected_managed m WHERE 'managed:'||m.id=f.alias_id),'application/octet-stream'),
      f.file_id,l.location_id,l.storage_profile_id,p.configuration_revision,p.namespace_identity,l.object_key,
      f.alias_id,lower(hex(randomblob(16))),'pending',(SELECT captured_at FROM capture)
    FROM representations f JOIN file_location_publications l ON l.location_id=f.active_location_id
    JOIN storage_profiles p ON p.id=l.storage_profile_id ORDER BY f.file_id,f.alias_id`).bind(...bindings));
  statements.push(db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
    SELECT 'package_'||hold_operation_id,source_location_id,'export',hold_operation_id,'Frozen research package source',?
    FROM research_package_files WHERE job_id=? AND entry_kind='source'`).bind(input.createdAt, input.jobId));
  statements.push(db.prepare(`${PACKAGE_SNAPSHOT_CLOSURE_SQL},
    ${packageUnionAllCtes("captured_records", ["job_id", "record_kind", "source_id", "record_json", "ordinal"],
      [...RESEARCH_RECORD_KINDS.map((recordKind, index) => recordSelectSql(recordKind, index)),
        recordSelectSql("fileAlias", RESEARCH_RECORD_KINDS.indexOf("fileAlias"), true), importedClaimSelectSql()])}
    INSERT INTO research_package_records(job_id,record_kind,source_id,record_json,ordinal)
    SELECT * FROM captured_records`).bind(...bindings));
  statements.push(db.prepare(`SELECT iif((SELECT count(*) FROM research_package_records WHERE job_id=?)<=?
    AND NOT EXISTS(SELECT 1 FROM research_package_records WHERE job_id=? AND length(CAST(record_json AS BLOB))>?)
    AND COALESCE((SELECT sum(length(CAST(record_json AS BLOB))) FROM research_package_records WHERE job_id=?),0)<=?
    AND (SELECT count(*) FROM research_package_files WHERE job_id=? AND entry_kind='source')<=?
    AND COALESCE((SELECT sum(byte_size) FROM research_package_files WHERE job_id=? AND entry_kind='source'),0)<=?,1,json('Package capture budget exceeded'))`)
    .bind(input.jobId, RESEARCH_PACKAGE_MAX_RECORDS, input.jobId, RESEARCH_PACKAGE_MAX_RECORD_BYTES, input.jobId, RESEARCH_PACKAGE_MAX_METADATA_BYTES,
      input.jobId, RESEARCH_PACKAGE_MAX_FILES, input.jobId, RESEARCH_PACKAGE_MAX_FILE_BYTES));
  return statements;
}

export interface CapturedPackageSnapshot { records: ResearchDomainRecord[]; files: ResearchPackageFile[]; dependencies: ResearchDependency[] }
function capturedReferenceContexts(records: ResearchDomainRecord[], target: ResearchEntityRef) {
  const index = new Map(records.map(record => [researchRecordKey(record.kind, record.sourceId), record]));
  const get = (kind: ResearchRecordKind, id: unknown) => index.get(researchRecordKey(kind, String(id)));
  const segment = (record: ResearchDomainRecord) => ({ target: { kind: record.kind, sourceId: record.sourceId },
    label: String(record.data.code ?? record.data.title ?? record.data.name ?? record.data.template_name_snapshot ?? record.sourceId),
    deletedAt: record.data.deleted_at ?? null, archivedAt: record.data.archived_at ?? null,
    resolution: record.data.deleted_at ? "deleted" : "included" });
  const stepContext = (stepId: unknown) => {
    const step = get("runStep", stepId), run = get("run", step?.data.run_id), sample = get("sample", run?.data.sample_id);
    return step && run && sample ? [{ segments: [segment(sample), segment(run), segment(step)] }] : [];
  };
  const record = get(target.kind, target.sourceId); if (!record) return [];
  if (target.kind === "sample" || target.kind === "recipeRevision") return [{ segments: [segment(record)] }];
  if (target.kind === "run") { const sample = get("sample", record.data.sample_id); return sample ? [{ segments: [segment(sample), segment(record)] }] : []; }
  if (target.kind === "runStep") return stepContext(record.sourceId);
  if (target.kind === "commentOccurrence" || target.kind === "executionImage") return stepContext(record.data.run_step_id);
  if (target.kind === "metrologyReference") { const recipe = get("recipeRevision", record.data.template_version_id); return recipe ? [{ segments: [segment(recipe)] }] : []; }
  const comment = target.kind === "comment" ? record : target.kind === "commentItem" ? get("comment", record.data.submission_id) : undefined;
  if (!comment) return [];
  if (comment.data.context_kind === "sample") { const sample = get("sample", comment.data.sample_id); return sample ? [{ segments: [segment(sample)] }] : []; }
  return records.filter(record => record.kind === "commentTarget" && record.data.submission_id === comment.sourceId).flatMap(record => stepContext(record.data.run_step_id));
}
export function packageSnapshotDependencies(records: ResearchDomainRecord[]): ResearchDependency[] {
  const index = new Map(records.map(record => [researchRecordKey(record.kind, record.sourceId), record])), dependencies: ResearchDependency[] = [];
  const resolution = (target: ResearchEntityRef): ResearchDependencyResolution => {
    const record = index.get(researchRecordKey(target.kind, target.sourceId));
    return record ? record.data.deleted_at ? "deleted" : "included" : "excluded";
  };
  for (const record of records) {
    const owner = { kind: record.kind, sourceId: record.sourceId };
    for (const relation of RESEARCH_PACKAGE_CATALOG[record.kind].relations ?? []) {
      const value = record.data[relation.field]; if (value === null) continue;
      const target = { kind: relation.kind, sourceId: String(value) }, outcome = resolution(target);
      if (outcome !== "included") dependencies.push({ owner, field: relation.field, target, resolution: outcome, reason: outcome === "excluded" ? "outside_selected_roots" : "source_deleted" });
    }
    if (record.kind === "reference") {
      const target = record.data.target as ResearchEntityRef, outcome = record.data.tombstoned_at ? "deleted" : resolution(target);
      const currentContexts = capturedReferenceContexts(records, target);
      if (currentContexts.length) record.data.contexts = currentContexts;
      record.data.resolution = outcome === "excluded" || outcome === "included" && !currentContexts.length ? "unresolved" : outcome;
      dependencies.push({ owner, field: "target", target, resolution: record.data.resolution as ResearchDependencyResolution, reason: outcome === "excluded" ? "source_not_included" : null });
      for (const context of record.data.contexts as Array<{ segments: Array<{ target: ResearchEntityRef; resolution: ResearchDependencyResolution }> }>) {
        for (const segment of context.segments) segment.resolution = resolution(segment.target);
      }
    }
    if (record.kind === "comment") for (const excluded of record.data.excluded_targets as Array<{ sample: ResearchEntityRef; run: ResearchEntityRef; step: ResearchEntityRef }>) {
      dependencies.push({ owner, field: "excluded_targets", target: excluded.step, resolution: "excluded", reason: "outside_selected_roots" });
    }
    if (record.kind === "event") for (const relationship of record.data.relationships as Array<{ field: string; target: ResearchEntityRef; resolution: ResearchDependencyResolution }>) {
      if (relationship.target.kind === ("group" as ResearchRecordKind) || relationship.target.kind === ("operation" as ResearchRecordKind)) continue;
      relationship.resolution = resolution(relationship.target);
      dependencies.push({ owner, field: `metadata.${relationship.field}`, target: relationship.target, resolution: relationship.resolution, reason: relationship.resolution === "excluded" ? "outside_selected_roots" : null });
    }
  }
  return dependencies;
}
export async function readPackageSnapshot(db: JobSqlDatabase, jobId: string): Promise<ResearchPackageV1 | ResearchReportV1> {
  const primary = db.primary();
  const job = await primary.prepare("SELECT kind,input_json,package_id,source_installation_id,accepted_at FROM research_package_jobs WHERE id=?")
    .bind(jobId).first<{ kind: ResearchExportKind; input_json: string; package_id: string; source_installation_id: string; accepted_at: string }>();
  if (!job || !["data_package", "report"].includes(job.kind)) throw new Error("Package capture does not exist");
  const rows = await primary.prepare("SELECT record_json FROM research_package_records WHERE job_id=? ORDER BY ordinal,source_id").bind(jobId).all<{ record_json: string }>();
  const records = rows.results.map(row => JSON.parse(row.record_json) as ResearchDomainRecord);
  const inventory = await primary.prepare(`SELECT logical_file_id,archive_path,purpose,byte_size,sha256,media_type FROM research_package_files
    WHERE job_id=? AND entry_kind='source' ORDER BY archive_path`).bind(jobId).all<{ logical_file_id: string; archive_path: string; purpose: ResearchPackageFile["purpose"]; byte_size: number; sha256: string; media_type: string }>();
  const files = inventory.results.map(row => ({ packageFileId: row.logical_file_id, path: row.archive_path, purpose: row.purpose,
    byteSize: row.byte_size, sha256: row.sha256, mediaType: row.media_type }));
  const dependencies = packageSnapshotDependencies(records), roots = (JSON.parse(job.input_json) as { roots: ResearchRoot[] }).roots;
  const missingMandatory = dependencies.some(dependency => dependency.resolution === "unresolved"
    || dependency.resolution === "excluded" && (RESEARCH_PACKAGE_CATALOG[dependency.owner.kind].relations ?? [])
      .some(relation => relation.field === dependency.field && !relation.external));
  // Outside-scope Common Comment targets and optional context are supported
  // selective provenance. They do not make the selected research incomplete.
  const missingReportBytes = job.kind === "report" && records.some(record =>
    ["fileAlias", "executionImage", "metrologyReference", "projectAttachment", "stateAsset"].includes(record.kind) && record.data.packageFileId === null
    || record.kind === "commentItem" && record.data.kind !== "link" && record.data.status === "ready" && record.data.packageFileId === null
    || record.kind === "event" && record.data.kind === "image" && record.data.packageFileId === null);
  const common = { packageId: job.package_id, sourceInstallationId: job.source_installation_id, createdAt: job.accepted_at, roots, files, records, dependencies,
    completeness: missingMandatory || missingReportBytes ? "partial" as const : "complete" as const,
    counts: { records: records.length, files: files.length, bytes: files.reduce((sum, file) => sum + file.byteSize, 0) },
    recordsSha256: await sha256Hex(stableJson(researchRecordsDocument(records))), report: { htmlPath: "report/index.html" as const, markdownPath: "report/report.md" as const } };
  const { records: capturedRecords, ...manifest } = common;
  // Bound the standalone public manifest here too. Runtime admission also
  // accounts for the exact measured ZIP index before starting artifact PUT.
  return job.kind === "report"
    ? { ...checkedResearchReportManifest({ ...manifest, schema: "research-report/1", kind: "report" }), records: capturedRecords }
    : { ...checkedResearchPackageManifest({ ...manifest, schema: "research-package/1", kind: "data_package" }), records: capturedRecords };
}

/** Preview is advisory and unheld. Acceptance always reruns capture in its own
 * fresh-primary transaction rather than trusting these counts or File pointers. */
export async function previewPackageSnapshot(db: JobSqlDatabase, input: { actor: string; roots: ResearchRoot[]; kind: ResearchExportKind }): Promise<ResearchPackagePreview> {
  const plan = checkedResearchExportPlanInput({ kind: input.kind, roots: input.roots }), primary = db.primary();
  const context = (kind: string, label: string) => `json_object('targetType',${quote(kind)},'id',s.id,
    'outcome',iif(s.deleted_at IS NULL,'included','tombstoned'),
    'reason',iif(s.deleted_at IS NULL,'owning_context','source_deleted'),
    'label',substr(COALESCE(${label},s.id),1,1000))`;
  const query = `${PACKAGE_SNAPSHOT_CLOSURE_SQL} SELECT
    (SELECT count(*) FROM selected_representations) files,COALESCE((SELECT sum(verified_byte_size) FROM selected_representations),0) bytes,
    (NOT EXISTS(SELECT 1 FROM required_bindings) OR EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')) authority,
    (SELECT count(*) FROM required_bindings b WHERE b.file_id IS NULL OR b.resolution_state<>'resolved'
      OR NOT EXISTS(SELECT 1 FROM selected_files f WHERE f.file_id=b.file_id AND(b.expected_purpose IS NULL OR b.expected_purpose=f.purpose))) unavailable,
    (SELECT count(*) FROM roots r WHERE(r.kind='sample' AND EXISTS(SELECT 1 FROM samples s WHERE s.id=r.id AND s.deleted_at IS NULL))
      OR(r.kind='project' AND EXISTS(SELECT 1 FROM projects p WHERE p.id=r.id AND p.deleted_at IS NULL))) roots`;
  // All reads share one primary batch. Per-kind counts avoid spending native
  // expression depth on a large scalar projection. Context reads attach only
  // their owning closure and return <=1,200 small rows, without jobs or holds.
  const bindings = packageCaptureBindings(plan.roots, "preview", new Date().toISOString());
  const contexts = [
    ["sample", "selected_samples", "printf('%s: %s',s.code,s.title)"],
    ["run", "selected_runs", "printf('%s #%d',s.template_name_snapshot,s.sequence_no)"],
    ["runStep", "selected_run_steps", "printf('Step %d',s.position+1)"],
  ];
  const countTables = [...Object.values(selected), "selected_managed", "imported_claims"];
  const result = await primary.batch([primary.prepare(query).bind(...bindings), ...countTables.map(table =>
    primary.prepare(`${PACKAGE_SNAPSHOT_CLOSURE_SQL} SELECT count(*) records FROM ${table}`).bind(...bindings)), ...contexts.map(([kind, table, label]) =>
    primary.prepare(`${PACKAGE_SNAPSHOT_CONTEXT_CLOSURE_SQL} SELECT ${context(kind, label)} context_json FROM ${table} s
      WHERE(SELECT count(*) FROM ${table})<=${RESEARCH_PACKAGE_MAX_RECORDS} ORDER BY s.id`).bind(...bindings))]);
  if (!Array.isArray(result) || result.length !== 1 + countTables.length + contexts.length) throw new Error("Package preview read results are unavailable");
  const rows = <T>(index: number): T[] => {
    const group: unknown = result[index];
    if (Array.isArray(group)) return group as T[];
    if (group && typeof group === "object" && "results" in group && Array.isArray(group.results)) return group.results as T[];
    throw new Error("Package preview read results are unavailable");
  };
  const source = rows<{ files: number; bytes: number; unavailable: number; authority: number; roots: number }>(0)[0];
  let records = 0;
  for (let index = 0; index < countTables.length; index++) {
    const count = rows<{ records: number }>(index + 1)[0]?.records;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Package preview counts are unavailable");
    records += count;
  }
  if (!Number.isSafeInteger(records)) throw new Error("Package preview counts are unavailable");
  const row = source ? { ...source, records } : null;
  if (!row || row.roots !== plan.roots.length) throw new Error("Package source is unavailable");
  const bounded = row.records <= RESEARCH_PACKAGE_MAX_RECORDS && row.files <= RESEARCH_PACKAGE_MAX_FILES && row.bytes <= RESEARCH_PACKAGE_MAX_FILE_BYTES;
  const reasons = [...(!bounded ? ["package_budget_exceeded"] : []), ...(row.unavailable ? ["unresolved_file_authority"] : []), ...(!row.authority ? ["file_authority_inactive"] : [])];
  return { schema: "research-package-preview/1", kind: plan.kind, roots: plan.roots,
    counts: { records: row.records, files: row.files, bytes: row.bytes }, archiveBytes: null, metadataBytes: 0,
    warnings: row.unavailable ? ["unresolved_file_authority"] : [], complete: !row.unavailable,
    capabilities: { dataPackage: { available: !reasons.length, reasons }, report: { available: bounded, reasons: bounded ? [] : ["package_budget_exceeded"] } },
    dependencies: (row.records <= RESEARCH_PACKAGE_MAX_RECORDS ? contexts.flatMap((_, index) => rows<{ context_json: string }>(1 + countTables.length + index)) : []).map(row => {
      const context = JSON.parse(row.context_json) as ResearchPackagePreview["dependencies"][number];
      // Labels are presentation only. Normalize broken UTF-16, remove controls,
      // and bound Unicode scalars before the checked client DTO sees them.
      const normalized = new TextDecoder().decode(new TextEncoder().encode(context.label ?? ""))
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
      return { ...context, label: Array.from(normalized).slice(0, 1000).join("").trim() || null };
    }), source: null, naming: null, targets: [], existingImportJobId: null, rolePolicyRevision: null };
}
