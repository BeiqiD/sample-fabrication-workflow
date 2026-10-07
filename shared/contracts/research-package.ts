import type { FilePurpose } from "./files";
import {
  checkedResearchRoot, RESEARCH_PACKAGE_MAX_FILES, RESEARCH_PACKAGE_MAX_FILE_BYTES, RESEARCH_PACKAGE_MAX_METADATA_BYTES,
  RESEARCH_PACKAGE_MAX_RECORDS, RESEARCH_PACKAGE_MAX_ROOTS, type ResearchRoot,
} from "./research-package-api";
import { isResearchRecordKind, RESEARCH_PACKAGE_CATALOG, RESEARCH_EVENT_RELATIONSHIP_FIELDS, type ResearchRecordKind } from "./research-package-catalog";
import { hashRecipeManifest, hashStepDefinition, sha256Hex, stableJson, STEP_HASH_SCHEME, STATE_HASH_SCHEME, SUBSTRATE_STATE_HASH_SCHEME } from "../domain/content-addressing";
import { validateResearchDomainRelations } from "./research-package-relations";

export const RESEARCH_PACKAGE_SCHEMA = "research-package/1" as const;
export const RESEARCH_RECORDS_SCHEMA = "research-records/1" as const;
export const RESEARCH_PACKAGE_FIXED_MEMBERS = ["manifest.json", "records.json", "report/index.html", "report/report.md"] as const;
export const RESEARCH_PACKAGE_MAX_PUBLICATION_STATEMENTS = 128;
export const RESEARCH_PACKAGE_MAX_RECORD_BYTES = 64 * 1024;
/** The persisted ZIP index and manifest share this bound at job admission.
 * The public manifest alone must fit before any object write is attempted. */
export const RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES = 1024 * 1024;
/** Import publication freezes one bounded local plan before provider copy. */
export const RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES = 1024 * 1024;
export type ResearchDependencyResolution = "included" | "unresolved" | "deleted" | "excluded";
export interface ResearchEntityRef { kind: ResearchRecordKind; sourceId: string }
export interface ResearchEventRelationship {
  field: string; target: { kind: ResearchRecordKind | "group" | "operation"; sourceId: string }; resolution: ResearchDependencyResolution;
}
export interface ResearchSourceRevision { scheme: "integer" | "timestamp" | "contentHash" | "snapshot"; value: number | string }
export interface ResearchDomainRecord {
  kind: ResearchRecordKind; sourceId: string; sourceRevision: ResearchSourceRevision; data: Record<string, unknown>;
}
export interface ResearchDependency {
  owner: ResearchEntityRef; field: string; target: ResearchEntityRef;
  resolution: ResearchDependencyResolution; reason: string | null;
}
export interface ResearchPackageFile {
  packageFileId: string; path: string; purpose: FilePurpose; byteSize: number; sha256: string; mediaType: string | null;
}
export interface ResearchPackageManifestV1 {
  schema: typeof RESEARCH_PACKAGE_SCHEMA; kind: "data_package"; packageId: string; sourceInstallationId: string; createdAt: string;
  roots: ResearchRoot[]; files: ResearchPackageFile[]; dependencies: ResearchDependency[];
  completeness: "complete" | "partial"; counts: { records: number; files: number; bytes: number };
  recordsSha256: string; report: { htmlPath: "report/index.html"; markdownPath: "report/report.md" };
}
export interface ResearchRecordsV1 { schema: typeof RESEARCH_RECORDS_SCHEMA; records: ResearchDomainRecord[] }
export interface ResearchPackageV1 extends ResearchPackageManifestV1 { records: ResearchDomainRecord[] }
export interface ResearchReportManifestV1 extends Omit<ResearchPackageManifestV1, "schema" | "kind"> {
  schema: "research-report/1"; kind: "report";
}
export interface ResearchReportV1 extends ResearchReportManifestV1 { records: ResearchDomainRecord[] }
export class ResearchPackageValidationError extends Error {
  constructor(readonly code: string) { super(`Invalid research package: ${code}`); this.name = "ResearchPackageValidationError"; }
}
function fail(code: string): never { throw new ResearchPackageValidationError(code); }
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("object");
  const result = value as Record<string, unknown>;
  if (keys && (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)))) fail("fields");
  return result;
}
function id(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")
    || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) !== value) fail("identity");
  return value;
}
function hash(value: unknown): string { const result = id(value, 64); if (!/^[a-f0-9]{64}$/.test(result)) fail("sha256"); return result; }
function count(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) fail("count"); return value as number;
}
function instant(value: unknown): string {
  const result = id(value, 200);
  if (!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(result)
    || !Number.isFinite(Date.parse(result.replace(" ", "T") + (/(?:Z|[+-]\d\d:\d\d)$/.test(result) ? "" : "Z")))) fail("timestamp");
  return result;
}
export function researchRecordKey(kind: ResearchRecordKind, sourceId: string): string { return `${kind}\0${sourceId}`; }
export function researchPackageFilePath(packageFileId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(packageFileId)) fail("file_identity"); return `files/${packageFileId}`;
}
function entity(value: unknown): ResearchEntityRef {
  const row = object(value, ["kind", "sourceId"]); if (!isResearchRecordKind(row.kind)) fail("record_kind");
  return { kind: row.kind, sourceId: id(row.sourceId) };
}
function jsonValue(value: unknown, depth = 0): void {
  if (depth > 32) fail("json_depth");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const child of value) jsonValue(child, depth + 1); return; }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") fail("json_key");
      jsonValue(child, depth + 1);
    }
    return;
  }
  fail("json_value");
}
export function checkedResearchDomainRecord(value: unknown): ResearchDomainRecord {
  if (new TextEncoder().encode(stableJson(value)).byteLength > RESEARCH_PACKAGE_MAX_RECORD_BYTES) fail("record_limit");
  const row = object(value, ["kind", "sourceId", "sourceRevision", "data"]);
  if (!isResearchRecordKind(row.kind)) fail("record_kind");
  const kind = row.kind, definition = RESEARCH_PACKAGE_CATALOG[kind], sourceId = id(row.sourceId);
  const revision = object(row.sourceRevision, ["scheme", "value"]);
  if (revision.scheme !== definition.revision.scheme) fail("revision_scheme");
  if (revision.scheme === "integer") count(revision.value, Number.MAX_SAFE_INTEGER);
  else if (revision.scheme === "contentHash") { if (hash(revision.value) !== sourceId) fail("revision_hash"); }
  else instant(revision.value);
  const data = object(row.data, Object.keys(definition.fields));
  for (const [field, rule] of Object.entries(definition.fields)) {
    const value = data[field]; if (value === null && rule.nullable) continue;
    if (rule.type === "text") {
      if (typeof value !== "string" || value.includes("\0") || value.length > RESEARCH_PACKAGE_MAX_METADATA_BYTES
        || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) !== value) fail("text_field");
      if (rule.values && !rule.values.includes(value)) fail("enum_field");
    } else if (rule.type === "integer") { if (!Number.isSafeInteger(value)) fail("integer_field"); }
    else if (rule.type === "number") { if (typeof value !== "number" || !Number.isFinite(value)) fail("number_field"); }
    else jsonValue(value);
  }
  if (definition.revision.field && definition.revision.scheme !== "contentHash" && data[definition.revision.field] !== revision.value) fail("revision_value");
  for (const field of Object.keys(data)) if (/PackageFileId$/.test(field) || field === "packageFileId") {
    if (data[field] !== null) researchPackageFilePath(id(data[field], 128));
  }
  return { kind, sourceId, sourceRevision: revision as unknown as ResearchSourceRevision, data };
}

export function checkedResearchPackageManifest(value: unknown): ResearchPackageManifestV1 {
  if (new TextEncoder().encode(stableJson(value)).byteLength > RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES) fail("manifest_limit");
  const row = object(value, ["schema", "kind", "packageId", "sourceInstallationId", "createdAt", "roots", "files", "dependencies", "completeness", "counts", "recordsSha256", "report"]);
  if (row.schema !== RESEARCH_PACKAGE_SCHEMA || row.kind !== "data_package") fail("schema");
  if (!Array.isArray(row.roots) || !row.roots.length || row.roots.length > RESEARCH_PACKAGE_MAX_ROOTS) fail("roots");
  const roots = row.roots.map(checkedResearchRoot);
  if (new Set(roots.map(root => `${root.kind}:${root.id}`)).size !== roots.length) fail("root_duplicate");
  if (!Array.isArray(row.files) || row.files.length > RESEARCH_PACKAGE_MAX_FILES) fail("files");
  const files = row.files.map((value): ResearchPackageFile => {
    const file = object(value, ["packageFileId", "path", "purpose", "byteSize", "sha256", "mediaType"]);
    const packageFileId = id(file.packageFileId, 128);
    if (file.path !== researchPackageFilePath(packageFileId)
      || !["research_source", "embedded_content", "derived_preview", "provenance", "job_output"].includes(String(file.purpose))) fail("file");
    if (file.mediaType !== null && (typeof file.mediaType !== "string" || file.mediaType.length > 200 || !/^[\x20-\x7e]+$/.test(file.mediaType))) fail("media_type");
    return { packageFileId, path: file.path as string, purpose: file.purpose as FilePurpose,
      byteSize: count(file.byteSize, RESEARCH_PACKAGE_MAX_FILE_BYTES), sha256: hash(file.sha256), mediaType: file.mediaType as string | null };
  });
  if (new Set(files.map(file => file.packageFileId)).size !== files.length) fail("file_duplicate");
  const bytes = files.reduce((sum, file) => sum + file.byteSize, 0); count(bytes, RESEARCH_PACKAGE_MAX_FILE_BYTES);
  if (!Array.isArray(row.dependencies) || row.dependencies.length > RESEARCH_PACKAGE_MAX_RECORDS * 8) fail("dependencies");
  const dependencies = row.dependencies.map((value): ResearchDependency => {
    const dependency = object(value, ["owner", "field", "target", "resolution", "reason"]);
    if (!["included", "unresolved", "deleted", "excluded"].includes(String(dependency.resolution))) fail("dependency_resolution");
    if (dependency.reason !== null && (typeof dependency.reason !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(dependency.reason))) fail("dependency_reason");
    return { owner: entity(dependency.owner), field: id(dependency.field), target: entity(dependency.target),
      resolution: dependency.resolution as ResearchDependencyResolution, reason: dependency.reason as string | null };
  });
  const counts = object(row.counts, ["records", "files", "bytes"]);
  if (count(counts.files, RESEARCH_PACKAGE_MAX_FILES) !== files.length || count(counts.bytes, RESEARCH_PACKAGE_MAX_FILE_BYTES) !== bytes) fail("inventory_count");
  if (row.completeness !== "complete" && row.completeness !== "partial") fail("completeness");
  const report = object(row.report, ["htmlPath", "markdownPath"]);
  if (report.htmlPath !== "report/index.html" || report.markdownPath !== "report/report.md") fail("report_path");
  return { schema: RESEARCH_PACKAGE_SCHEMA, kind: "data_package", packageId: id(row.packageId, 128), sourceInstallationId: id(row.sourceInstallationId, 128),
    createdAt: instant(row.createdAt), roots, files, dependencies, completeness: row.completeness,
    counts: { records: count(counts.records, RESEARCH_PACKAGE_MAX_RECORDS), files: files.length, bytes }, recordsSha256: hash(row.recordsSha256),
    report: { htmlPath: "report/index.html", markdownPath: "report/report.md" } };
}

/** Report envelopes have the same bounded inventory, but can contain missing
 * source placeholders. They never enter the native import validator. */
export function checkedResearchReportManifest(value: unknown): ResearchReportManifestV1 {
  const row = object(value);
  if (row.schema !== "research-report/1" || row.kind !== "report") fail("report_schema");
  const checked = checkedResearchPackageManifest({ ...row, schema: RESEARCH_PACKAGE_SCHEMA, kind: "data_package" });
  return { ...checked, schema: "research-report/1", kind: "report" };
}

const REFERENCE_KIND: Record<string, ResearchRecordKind> = {
  sample: "sample", run: "run", run_step: "runStep", comment: "comment", comment_occurrence: "commentOccurrence",
  comment_attachment: "commentItem", execution_image: "executionImage", metrology_reference: "metrologyReference", recipe_revision: "recipeRevision",
};
export function researchReferenceKind(type: string): ResearchRecordKind | null { return REFERENCE_KIND[type] ?? null; }
export function researchRecordsDocument(records: ResearchDomainRecord[]): ResearchRecordsV1 { return { schema: RESEARCH_RECORDS_SCHEMA, records }; }

/** ZIP readers independently authenticate member bytes first. This validator
 * authenticates the closed domain graph and canonical content hashes, never SQL. */
export async function validateResearchPackage(manifestValue: unknown, recordsValue: unknown): Promise<ResearchPackageV1> {
  const manifest = checkedResearchPackageManifest(manifestValue), document = object(recordsValue, ["schema", "records"]);
  if (document.schema !== RESEARCH_RECORDS_SCHEMA || !Array.isArray(document.records) || document.records.length > RESEARCH_PACKAGE_MAX_RECORDS) fail("records");
  // The aggregate metadata budget covers the actual two documents here;
  // the ZIP admission layer also adds both independently rendered reports.
  if (new TextEncoder().encode(stableJson(manifest)).byteLength
    + new TextEncoder().encode(stableJson(document)).byteLength > RESEARCH_PACKAGE_MAX_METADATA_BYTES) fail("metadata_limit");
  if (await sha256Hex(stableJson(document)) !== manifest.recordsSha256) fail("records_digest");
  const records = document.records.map(checkedResearchDomainRecord);
  if (records.length !== manifest.counts.records) fail("record_count");
  const indexed = new Map<string, ResearchDomainRecord>();
  for (const record of records) { const key = researchRecordKey(record.kind, record.sourceId); if (indexed.has(key)) fail("record_duplicate"); indexed.set(key, record); }
  const dependencies = new Map<string, ResearchDependency>();
  for (const dependency of manifest.dependencies) {
    const owner = researchRecordKey(dependency.owner.kind, dependency.owner.sourceId), target = researchRecordKey(dependency.target.kind, dependency.target.sourceId);
    const key = `${owner}\0${dependency.field}\0${target}`;
    if (!indexed.has(owner) || dependencies.has(key) || dependency.resolution === "included" && !indexed.has(target)
      || dependency.resolution === "excluded" && indexed.has(target)) fail("dependency_identity");
    dependencies.set(key, dependency);
  }
  const files = new Map(manifest.files.map(file => [file.packageFileId, file])), usedFiles = new Set<string>();
  const external = (owner: ResearchDomainRecord, field: string, target: ResearchEntityRef): boolean =>
    dependencies.has(`${researchRecordKey(owner.kind, owner.sourceId)}\0${field}\0${researchRecordKey(target.kind, target.sourceId)}`);
  for (const record of records) {
    for (const relation of RESEARCH_PACKAGE_CATALOG[record.kind].relations ?? []) {
      const value = record.data[relation.field]; if (value === null && relation.nullable) continue;
      const target = { kind: relation.kind, sourceId: id(value) };
      if (!indexed.has(researchRecordKey(target.kind, target.sourceId)) && !(relation.external && external(record, relation.field, target))) fail("relation_missing");
    }
    for (const [field, value] of Object.entries(record.data)) if ((/PackageFileId$/.test(field) || field === "packageFileId") && value !== null) {
      if (typeof value !== "string" || !files.has(value)) fail("file_missing"); usedFiles.add(value);
    }
    if (record.kind === "fileAlias") {
      const file = files.get(String(record.data.packageFileId))!;
      if (record.data.sha256 !== file.sha256 || record.data.byte_size !== file.byteSize) fail("alias_content");
    }
    if (record.kind === "reference") {
      const target = entity(record.data.target), exists = indexed.has(researchRecordKey(target.kind, target.sourceId));
      if (!Object.values(REFERENCE_KIND).includes(target.kind)) fail("reference_kind");
      if (record.data.resolution === "included" && !exists || record.data.resolution === "excluded" && exists) fail("reference_resolution");
      if (!Array.isArray(record.data.contexts)) fail("reference_contexts");
      for (const context of record.data.contexts) {
        const value = object(context, ["segments"]); if (!Array.isArray(value.segments)) fail("reference_contexts");
        for (const segment of value.segments) {
          const value = object(segment, ["target", "label", "deletedAt", "archivedAt", "resolution"]), target = entity(value.target);
          if (!["sample", "run", "runStep", "recipeRevision"].includes(target.kind)) fail("reference_context_kind");
          if (typeof value.label !== "string" || value.deletedAt !== null && typeof value.deletedAt !== "string"
            || value.archivedAt !== null && typeof value.archivedAt !== "string" || !["included", "unresolved", "deleted", "excluded"].includes(String(value.resolution))) fail("reference_context");
        }
      }
    }
    if (record.kind === "event") {
      const metadata = object(record.data.metadata);
      for (const key of Object.keys(RESEARCH_EVENT_RELATIONSHIP_FIELDS)) if (Object.hasOwn(metadata, key)) fail("untyped_event_identity");
      for (const key of ["thumbnailKey", "assetKey", "r2_key", "object_key", "objectKey", "fileId", "storageProfileId", "storageProfileRevision", "provider", "storeKind", "sourceLocator"]) {
        if (Object.hasOwn(metadata, key)) fail("event_locator");
      }
      if (!Array.isArray(record.data.relationships)) fail("event_relationships");
      const seen = new Set<string>(), arrays = new Map<string, number[]>();
      for (const entry of record.data.relationships) {
        const value = object(entry, ["field", "target", "resolution"]), field = id(value.field), match = /^([A-Za-z]+)(?:\[(\d+)\])?$/.exec(field);
        if (!match || seen.has(field)) fail("event_relationship_field"); seen.add(field);
        const rule = RESEARCH_EVENT_RELATIONSHIP_FIELDS[match[1] as keyof typeof RESEARCH_EVENT_RELATIONSHIP_FIELDS];
        const target = object(value.target, ["kind", "sourceId"]); id(target.sourceId);
        if (!rule || rule.kind !== target.kind || rule.array !== (match[2] !== undefined)
          || !["included", "unresolved", "deleted", "excluded"].includes(String(value.resolution))) fail("event_relationship_target");
        if (match[2] !== undefined) arrays.set(match[1], [...(arrays.get(match[1]) ?? []), Number(match[2])]);
        if (isResearchRecordKind(target.kind)) {
          const included = indexed.has(researchRecordKey(target.kind, target.sourceId as string));
          if (value.resolution === "included" && !included || value.resolution === "excluded" && included) fail("event_relationship_resolution");
        }
      }
      for (const indices of arrays.values()) if (indices.sort((a, b) => a - b).some((value, index) => value !== index)) fail("event_relationship_array");
    }
    if (record.kind === "stepDefinition") {
      const data = record.data, expected = await hashStepDefinition({ name: String(data.name), toolName: data.tool_name as string | null,
        parametersText: data.parameters_text as string | null, commentsText: data.comments_text as string | null });
      if (data.hash_scheme !== STEP_HASH_SCHEME || expected.hash !== record.sourceId || stableJson(expected.canonical) !== stableJson(data.canonical_json)) fail("definition_hash");
    }
    if (record.kind === "state") {
      const data = record.data, canonical = object(data.content_json);
      if (![STATE_HASH_SCHEME, SUBSTRATE_STATE_HASH_SCHEME].includes(String(data.hash_scheme)) || canonical.schema !== data.hash_scheme
        || canonical.type !== data.representation_type || await sha256Hex(stableJson(canonical)) !== record.sourceId) fail("state_hash");
      if (!Array.isArray(canonical.assetHashes) || canonical.assetHashes.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) fail("state_assets");
      const expectedKeys = data.hash_scheme === STATE_HASH_SCHEME ? ["schema", "type", "assetHashes"]
        : ["schema", "type", "assetHashes", "name", "toolName", "parametersText", "commentsText", "stepNumber", "rawCells"];
      object(canonical, expectedKeys);
      if (data.hash_scheme === STATE_HASH_SCHEME && canonical.type !== "diagram" || data.hash_scheme === SUBSTRATE_STATE_HASH_SCHEME && canonical.type !== "substrate") fail("state_type");
      const associations = records.filter(value => value.kind === "stateAsset" && value.data.state_hash === record.sourceId)
        .sort((left, right) => Number(left.data.position) - Number(right.data.position) || left.sourceId.localeCompare(right.sourceId));
      if (stableJson(associations.map(value => files.get(String(value.data.packageFileId))!.sha256)) !== stableJson(canonical.assetHashes)) fail("state_asset_order");
    }
    if (record.kind === "recipeRevision") {
      const content = object(record.data.content_json, ["initialSubstrateStep", "provenance"]);
      const provenance = object(content.provenance, ["schemaVersion", "importedTitle", "objectKind", "warningCount"]);
      if (provenance.schemaVersion !== null && !Number.isSafeInteger(provenance.schemaVersion)
        || provenance.warningCount !== null && (!Number.isSafeInteger(provenance.warningCount) || Number(provenance.warningCount) < 0)
        || [provenance.importedTitle, provenance.objectKind].some(value => value !== null && typeof value !== "string")) fail("recipe_provenance");
      if (content.initialSubstrateStep !== null) {
        const initial = object(content.initialSubstrateStep, ["name", "toolName", "parametersText", "commentsText", "stepNumber", "sourceRow", "rawCells"]);
        if ([initial.name, initial.toolName, initial.parametersText, initial.commentsText, initial.stepNumber].some(value => value !== null && typeof value !== "string")
          || initial.sourceRow !== null && !Number.isSafeInteger(initial.sourceRow)) fail("recipe_substrate_provenance");
        object(initial.rawCells);
      }
      const steps = records.filter(value => value.kind === "templateStep" && value.data.template_version_id === record.sourceId)
        .sort((left, right) => Number(left.data.position) - Number(right.data.position));
      if (new Set(steps.map(value => value.data.position)).size !== steps.length
        || await hashRecipeManifest(steps.map(value => ({ logicalStepKey: String(value.data.logical_step_key), definitionHash: String(value.data.definition_hash), expectedStateHash: value.data.expected_state_hash as string | null }))) !== record.data.manifest_hash) fail("recipe_manifest_hash");
    }
  }
  for (const root of manifest.roots) if (!indexed.has(researchRecordKey(root.kind, root.id))) fail("root_missing");
  if (usedFiles.size !== files.size) fail("unused_file");
  validateResearchDomainRelations(records, manifest.files);
  return { ...manifest, records };
}
