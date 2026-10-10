import type { VersionedRecoveryRecords } from "./versioned-catalog";
import type { ExportRow } from "../../shared/contracts/export";
import type { FilePurpose } from "../../shared/contracts/files";
import type { SystemBackupBinding, SystemBackupFile } from "../../shared/contracts/system-backup";
import type { SystemRecoveryStorageMapping } from "../../shared/contracts/system-recovery";
import { sha256Hex, stableJson } from "../../shared/domain/content-addressing";
import { SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS } from "../../shared/contracts/export-system-recovery-evidence";
import { STORAGE_PROFILE_ADMISSIONS_EXPORT_COLUMNS } from "../../shared/contracts/export-file-native-admission";
import { FILE_NATIVE_RUNTIME_TABLE_COLUMNS } from "../../shared/contracts/file-native-runtime";
import type { Env } from "../types";
import { writeVerifiedBytes } from "../files/byte-writer";
import { ByteVerificationError, type VerifiedBytes } from "../files/byte-verification";
import { openShadowProfile } from "../files/shadow-profile";

/** These descriptors originate in the installation's admitted profile registry,
 * never in an uploaded archive or a caller-supplied provider URL. */
export interface RecoveryDestinationProfile {
  id: string;
  adapterType: "r2" | "s3";
  namespaceIdentity: string;
  configurationRevision: number;
  configurationSource?: "bootstrap" | "system";
  credentialReference?: null;
  createdAt: string;
  runtime?: { state: string; registered_at: string; activated_at: string | null; retired_at: string | null };
  metadataRows?: Array<{ table: "storage_profile_admissions" | "storage_profile_activations" | "file_shadow_dependency_versions" | "file_shadow_profile_enablements"; row: Record<string, string | number | null> }>;
  metadataSha256?: string;
  transportFenceSha256?: string;
}
export interface RecoveryFileCellChange {
  table: string;
  keys: Record<string, string>;
  column: string;
  value: string | null;
}
export interface RecoveryPlannedFile {
  id: string;
  sourceId: string;
  archivePath: string;
  sourceProfileId: string;
  destinationProfileId: string;
  configurationRevision: number;
  destinationNamespaceIdentity: string;
  destinationAdapterType: "r2" | "s3";
  incarnation: string;
  fileId: string;
  purpose: FilePurpose;
  createFile: boolean;
  nativePublicationExists: boolean;
  publishAsActive: boolean;
  locationId: string;
  objectKey: string;
  byteSize: number;
  sha256: string;
  contentType: string;
  filename: string;
  bindings: SystemBackupBinding[];
  aliases: RecoveryFileCellChange[];
  backupId: string;
  sourceImageSha256: string;
  destinationMetadataSha256: string;
  sourceLocatorJson: string;
  originalAliases: Array<{ table: "assets" | "managed_storage_objects"; row: ExportRow }>;
  bindingEvidence: Array<{ binding: SystemBackupBinding; rowSha256: string; previewOriginJson: string }>;
}
export class RecoveryFilePlanError extends Error {
  constructor(readonly code: string) { super(`Recovery File plan rejected: ${code}`); this.name = "RecoveryFilePlanError"; }
}
function ensure(value: unknown, code: string): asserts value { if (!value) throw new RecoveryFilePlanError(code); }
const purposes: readonly FilePurpose[] = ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"];
function isPurpose(value: unknown): value is FilePurpose { return purposes.includes(value as FilePurpose); }
function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
    && new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value;
}
function transportContentType(value: unknown): string {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(value)
    ? value : "application/octet-stream";
}

/** A stable namespace label for legacy inventories without a native profile.
 * The mapping must still name an exact admitted destination profile. */
export function recoverySourceProfileId(file: Pick<SystemBackupFile, "source">): string {
  return file.source.storageProfileId ?? `legacy:${file.source.storeKind}:${file.source.provider}`;
}

export interface ReviewedRecoveryBinding {
  table: string;
  column: string;
  keys: Record<string, string>;
  purpose: FilePurpose;
}
/** All SQL identifiers are owned by this closed thirteen-slot projection. */
export function reviewedRecoveryBinding(binding: SystemBackupBinding): ReviewedRecoveryBinding {
  const { consumerKind: kind, consumerId: id, consumerSubId: sub, fileSlot: slot } = binding;
  ensure(safeText(id, 256) && typeof sub === "string" && !sub.includes("\0"), "binding_identity");
  let result: ReviewedRecoveryBinding | undefined;
  if (kind === "state_representation_asset" && slot === "primary") {
    ensure(safeText(sub, 256), "binding_identity");
    result = { table: "state_representation_assets", column: "file_id", keys: { state_hash: id, asset_id: sub }, purpose: "embedded_content" };
  } else if (sub === "") {
    if (kind === "run_step_asset" && slot === "primary") result = { table: "run_step_assets", column: "file_id", keys: { id }, purpose: "embedded_content" };
    else if (kind === "metrology_template_reference" && slot === "primary") result = { table: "metrology_template_references", column: "file_id", keys: { id }, purpose: "research_source" };
    else if (kind === "run_step_comment" && slot === "primary") result = { table: "run_step_comments", column: "file_id", keys: { id }, purpose: "embedded_content" };
    else if (kind === "state_verification" && slot === "evidence") result = { table: "state_verifications", column: "evidence_file_id", keys: { id }, purpose: "embedded_content" };
    else if (kind === "comment_submission_item" && slot === "primary") {
      ensure(isPurpose(binding.purpose) && ["research_source", "embedded_content", "derived_preview"].includes(binding.purpose), "comment_binding_purpose");
      result = { table: "comment_submission_items", column: "file_id", keys: { id }, purpose: binding.purpose };
    } else if (kind === "project_content_attachment" && slot === "primary") result = { table: "project_content_attachments", column: "file_id", keys: { project_content_id: id }, purpose: "research_source" };
    else if (kind === "attachment_derivative" && slot === "derived") result = { table: "attachment_derivatives", column: "derived_file_id", keys: { id }, purpose: "derived_preview" };
    else if (kind === "event" && slot === "primary") result = { table: "events", column: "asset_file_id", keys: { id }, purpose: "embedded_content" };
    else if (kind === "event" && slot === "thumbnail") result = { table: "events", column: "thumbnail_file_id", keys: { id }, purpose: "derived_preview" };
    else if (kind === "import" && slot === "workbook") result = { table: "imports", column: "workbook_file_id", keys: { id }, purpose: "provenance" };
    else if (kind === "import" && slot === "manifest") result = { table: "imports", column: "manifest_file_id", keys: { id }, purpose: "provenance" };
    else if (kind === "template_version" && slot === "source") result = { table: "template_versions", column: "source_file_id", keys: { id }, purpose: "provenance" };
  }
  ensure(result, "unsupported_binding");
  ensure(binding.purpose === null || binding.purpose === result.purpose, "binding_purpose");
  return result;
}
function physicalAliases(records: VersionedRecoveryRecords, file: SystemBackupFile) {
  const aliases: Array<{ table: "assets" | "managed_storage_objects"; row: ExportRow }> = [];
  for (const row of records.content.tables.assets ?? []) {
    if (file.source.storeKind === "r2" && row.r2_key === file.source.objectKey
      || typeof row.file_id === "string" && file.fileIds.includes(row.file_id)) aliases.push({ table: "assets", row });
  }
  for (const row of records.content.tables.managed_storage_objects ?? []) {
    if (file.source.storeKind === "managed" && row.provider === file.source.provider && row.object_key === file.source.objectKey
      || typeof row.file_id === "string" && file.fileIds.includes(row.file_id)) aliases.push({ table: "managed_storage_objects", row });
  }
  return aliases;
}

/** Pure planning after archive admission. No new provider binding, File writer,
 * target table or source cell is modified. A physical payload can represent
 * several File purposes; those remain separate logical Files and copies. */
export async function planRecoveryFiles(
  records: VersionedRecoveryRecords,
  files: readonly SystemBackupFile[],
  mappings: readonly SystemRecoveryStorageMapping[],
  destinationProfiles: readonly RecoveryDestinationProfile[],
  incarnation: string,
): Promise<RecoveryPlannedFile[]> {
  ensure(safeText(incarnation, 128) && /^[A-Za-z0-9_-]+$/.test(incarnation), "incarnation");
  ensure(files.length <= 100, "file_budget");
  const profiles = new Map<string, RecoveryDestinationProfile>();
  for (const profile of destinationProfiles) {
    ensure(!profiles.has(profile.id) && safeText(profile.id, 256) && safeText(profile.namespaceIdentity, 2048)
      && ["r2", "s3"].includes(profile.adapterType) && profile.configurationRevision === 1
      && safeText(profile.createdAt, 200)
      && (profile.configurationSource === undefined || profile.configurationSource === (profile.adapterType === "r2" ? "bootstrap" : "system"))
      && (profile.credentialReference === undefined || profile.credentialReference === null), "destination_profile");
    profiles.set(profile.id, { ...profile });
  }
  const mapping = new Map<string, SystemRecoveryStorageMapping>();
  for (const item of mappings) {
    ensure(!mapping.has(item.sourceProfileId) && safeText(item.sourceProfileId, 256), "mapping_duplicate");
    const profile = profiles.get(item.destinationProfileId);
    ensure(profile && profile.configurationRevision === item.configurationRevision, "mapping_destination");
    mapping.set(item.sourceProfileId, { ...item });
  }
  const native = new Map((records.content.tables.files ?? []).map(row => [String(row.id), row]));
  const sourceImageSha256 = await sha256Hex(stableJson(records.image));
  const publications = new Map((records.content.tables.file_publications ?? []).map(row => [String(row.file_id), row]));
  const plan: RecoveryPlannedFile[] = [], seenSources = new Set<string>();
  const identities = new Map<string, { purpose: FilePurpose; byteSize: number; sha256: string }>();
  for (const source of files) {
    ensure(!seenSources.has(source.id), "source_duplicate"); seenSources.add(source.id);
    ensure(source.outcome === "packaged" && safeText(source.path, 4096) && Number.isSafeInteger(source.byteSize)
      && source.byteSize! >= 0 && typeof source.sha256 === "string" && /^[a-f0-9]{64}$/.test(source.sha256), "missing_payload");
    const sourceProfileId = recoverySourceProfileId(source), selected = mapping.get(sourceProfileId);
    ensure(selected, "mapping_missing");
    const destination = profiles.get(selected.destinationProfileId)!;
    const candidates = new Map<string, { purpose: FilePurpose; existing: boolean; bindings: SystemBackupBinding[] }>();
    for (const id of source.fileIds) {
      const row = native.get(id);
      ensure(row, "native_file_missing");
      if (!isPurpose(row.purpose)) continue; // Retain ambiguous historical observations unchanged.
      ensure(row.access_scope === "system" && (row.expected_byte_size === null || row.expected_byte_size === source.byteSize)
        && (row.expected_sha256 === null || row.expected_sha256 === source.sha256), "native_file_bytes");
      const published = publications.get(id);
      ensure(!published || published.purpose === row.purpose && published.access_scope === "system"
        && published.verified_byte_size === source.byteSize && published.verified_sha256 === source.sha256, "native_publication_bytes");
      candidates.set(id, { purpose: row.purpose, existing: true, bindings: [] });
    }
    for (const binding of source.bindings) {
      const spec = reviewedRecoveryBinding(binding);
      // A retained legacy locator can overlap a canonically bound native File
      // without a legacy_file_mapping. Preserve that existing identity only
      // when its immutable purpose and independently verified bytes agree.
      if(binding.fileId && !candidates.has(binding.fileId) && native.has(binding.fileId)){
        const existing=native.get(binding.fileId)!,publication=publications.get(binding.fileId);
        ensure(existing.purpose===spec.purpose && existing.access_scope==='system'
          && publication?.purpose===spec.purpose && publication.state==='ready'
          && publication.verified_byte_size===source.byteSize && publication.verified_sha256===source.sha256
          && (existing.expected_byte_size===null||existing.expected_byte_size===source.byteSize)
          && (existing.expected_sha256===null||existing.expected_sha256===source.sha256),'bound_native_file_bytes');
        candidates.set(binding.fileId,{purpose:spec.purpose,existing:true,bindings:[]});
      }
      let id = binding.fileId && candidates.has(binding.fileId) ? binding.fileId : null;
      if (id) ensure(candidates.get(id)!.purpose === spec.purpose && publications.get(id)?.state !== "retired", "retired_or_wrong_binding");
      if (!id) id = [...candidates].find(([candidateId, item]) => item.purpose === spec.purpose && publications.get(candidateId)?.state !== "retired")?.[0] ?? null;
      if (!id) {
        id = `fp5-file:${incarnation}:${await sha256Hex(stableJson({ source: source.id, purpose: spec.purpose }))}`;
        ensure(!native.has(id), "new_file_identity_conflict");
        candidates.set(id, { purpose: spec.purpose, existing: false, bindings: [] });
      }
      candidates.get(id)!.bindings.push({ ...binding, purpose: spec.purpose });
    }
    if (!candidates.size) {
      const purpose: FilePurpose = source.source.storeKind === "managed" ? "research_source" : "embedded_content";
      const id = `fp5-file:${incarnation}:${await sha256Hex(stableJson({ source: source.id, purpose }))}`;
      ensure(!native.has(id), "new_file_identity_conflict");
      candidates.set(id, { purpose, existing: false, bindings: [] });
    }
    for (const [fileId, candidate] of candidates) {
      const previous = identities.get(fileId);
      ensure(!previous || previous.purpose === candidate.purpose && previous.byteSize === source.byteSize && previous.sha256 === source.sha256, "conflicting_file_sources");
      identities.set(fileId, { purpose: candidate.purpose, byteSize: source.byteSize!, sha256: source.sha256! });
      const digest = await sha256Hex(stableJson({ incarnation, source: source.id, fileId, destination: destination.id, namespace: destination.namespaceIdentity }));
      const aliases = physicalAliases(records, source);
      const descriptor = aliases[0]?.row;
      plan.push({ id: `rf_${digest}`, sourceId: source.id, archivePath: source.path!, sourceProfileId,
        destinationProfileId: destination.id, configurationRevision: destination.configurationRevision,
        destinationNamespaceIdentity: destination.namespaceIdentity, destinationAdapterType: destination.adapterType,
        incarnation, fileId, purpose: candidate.purpose, createFile: !candidate.existing,
        nativePublicationExists: publications.has(fileId), publishAsActive: publications.get(fileId)?.state !== "retired",
        locationId: `fp5-location:${incarnation}:${digest}`, objectKey: `fp5-recovery/${incarnation}/${digest}`,
        byteSize: source.byteSize!, sha256: source.sha256!,
        contentType: transportContentType(descriptor?.mime_type),
        filename: safeText(descriptor?.original_name, 4096) && !/[\r\n]/.test(descriptor.original_name) ? descriptor.original_name : source.id,
        bindings: candidate.bindings, aliases: [], backupId: records.backupId, sourceImageSha256,
        destinationMetadataSha256: destination.metadataSha256 ?? await sha256Hex(stableJson(destination)),
        sourceLocatorJson: stableJson({ sourceId: source.id, locatorId: source.source.locatorId, storeKind: source.source.storeKind,
          provider: source.source.provider, byteAuthority: source.source.byteAuthority, storageProfileId: source.source.storageProfileId,
          storageProfileRevision: source.source.storageProfileRevision, locationId: source.source.locationId, objectKey: source.source.objectKey,
          expectedByteSize: source.source.expectedByteSize, expectedSha256: source.source.expectedSha256?.toLowerCase() ?? null }),
        originalAliases: [], bindingEvidence: [] });
    }
    const entries = plan.filter(file => file.sourceId === source.id);
    for (const alias of physicalAliases(records, source)) {
      const original = typeof alias.row.file_id === "string" ? entries.find(file => file.fileId === alias.row.file_id && file.publishAsActive) : undefined;
      const preferred = original ?? entries.find(file => file.publishAsActive && file.purpose === "embedded_content")
        ?? entries.find(file => file.publishAsActive && file.purpose === "research_source") ?? entries.find(file => file.publishAsActive);
      if (preferred) {
        ensure(new TextEncoder().encode(stableJson(alias.row)).byteLength <= 24_576, "alias_evidence_budget");
        preferred.originalAliases.push({ table: alias.table, row: { ...alias.row } });
        if (alias.row.file_id !== preferred.fileId) preferred.aliases.push({ table: alias.table, keys: { id: String(alias.row.id) }, column: "file_id", value: preferred.fileId });
      }
    }
  }
  // Several physical roots may retain one immutable File. Publish exactly one
  // destination head, preferring the source's previously active publication.
  for (const fileId of identities.keys()) {
    const entries = plan.filter(file => file.fileId === fileId && file.publishAsActive);
    const active = publications.get(fileId)?.active_location_id;
    const chosen = entries.find(file => files.find(source => source.id === file.sourceId)?.source.locationId === active) ?? entries[0];
    for (const file of entries) file.publishAsActive = file === chosen;
  }
  const boundFile = (kind: string, id: string, slot: string) => plan.find(file => file.bindings.some(binding => binding.consumerKind === kind && binding.consumerId === id && binding.consumerSubId === "" && binding.fileSlot === slot))?.fileId ?? null;
  for (const file of plan) for (const binding of file.bindings) {
    const spec = reviewedRecoveryBinding(binding), row = (records.content.tables[spec.table] ?? []).find(row => Object.entries(spec.keys).every(([key, value]) => row[key] === value));
    ensure(row, "binding_source_row");
    let origin: Record<string, unknown> = { kind: "none" };
    if (file.purpose === "derived_preview") {
      if (spec.table === "events") origin = { kind: "event_thumbnail", parentFileId: boundFile("event", binding.consumerId, "primary") ?? row.asset_file_id };
      else if (spec.table === "comment_submission_items") {
        const original = (records.content.tables.comment_submission_items ?? []).find(original => original.id === row.related_item_id);
        ensure(row.kind === "comment_image" && original?.kind === "attachment" && original.submission_id === row.submission_id, "preview_source_relationship");
        origin = { kind: "comment_preview", relatedItemId: row.related_item_id, submissionId: row.submission_id,
          parentFileId: boundFile("comment_submission_item", String(original.id), "primary") ?? original.file_id,
          originalKind: original.kind, originalRelatedItemId: original.related_item_id };
      } else {
        ensure(spec.table === "attachment_derivatives", "preview_source_kind");
        origin = { kind: "attachment_derivative", derivativeKind: row.derivative_kind, generatorVersion: row.generator_version,
          sourceSha256: row.source_sha256, sourceByteSize: row.source_byte_size };
      }
    }
    file.bindingEvidence.push({ binding: { ...binding }, rowSha256: await sha256Hex(stableJson(row)), previewOriginJson: stableJson(origin) });
  }
  // A consumer or alias cannot receive different logical Files merely because
  // the archive retained multiple physical sources for it.
  ensure(plan.length <= 100 && plan.reduce((sum, file) => sum + file.byteSize, 0) <= 96 * 1024 * 1024, "copy_plan_budget");
  const changes = new Map<string, string | null>();
  for (const change of recoveryFileCellChanges(plan)) {
    const key = stableJson({ table: change.table, keys: change.keys, column: change.column });
    ensure(!changes.has(key) || changes.get(key) === change.value, "conflicting_binding_sources");
    changes.set(key, change.value);
  }
  return plan;
}

/** Exact deviations from the preserved typed image, for target verification. */
export function recoveryFileCellChanges(files: readonly RecoveryPlannedFile[]): RecoveryFileCellChange[] {
  return files.flatMap(file => [
    ...(file.publishAsActive && file.nativePublicationExists ? [{ table: "file_publications", keys: { file_id: file.fileId }, column: "active_location_id", value: file.locationId }] : []),
    ...file.bindings.map(binding => { const spec = reviewedRecoveryBinding(binding); return { table: spec.table, keys: spec.keys, column: spec.column, value: file.fileId }; }),
    ...file.aliases,
  ]);
}
function changeStatement(db: D1Database, change: RecoveryFileCellChange) {
  const allowed = new Set(["assets:file_id", "managed_storage_objects:file_id", "state_representation_assets:file_id", "run_step_assets:file_id", "metrology_template_references:file_id", "run_step_comments:file_id", "state_verifications:evidence_file_id", "comment_submission_items:file_id", "project_content_attachments:file_id", "attachment_derivatives:derived_file_id", "events:asset_file_id", "events:thumbnail_file_id", "imports:workbook_file_id", "imports:manifest_file_id", "template_versions:source_file_id"]);
  ensure(allowed.has(`${change.table}:${change.column}`), "unsupported_cell_change");
  const keys = Object.keys(change.keys);
  ensure(keys.length > 0 && keys.every(key => ["id", "state_hash", "asset_id", "project_content_id"].includes(key)), "unsupported_cell_keys");
  const where = keys.map(key => `"${key}"=?`).join(" AND "), values = keys.map(key => change.keys[key]);
  return [db.prepare(`UPDATE "${change.table}" SET "${change.column}"=? WHERE ${where}`).bind(change.value, ...values),
    db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM "${change.table}" WHERE ${where} AND "${change.column}"=?)=1 THEN 1 ELSE json('Recovery File binding changed') END`).bind(...values, change.value)];
}

/** Exact approved appended rows, shared by publication and target verification. */
export function recoveryFileEvidenceRows(file: RecoveryPlannedFile, now: string): Record<string, ExportRow[]> {
  ensure(safeText(now, 200) && Number.isFinite(Date.parse(now)), "publication_clock");
  return {
    recovery_file_evidence: [{ id: file.id, backup_id: file.backupId, source_image_sha256: file.sourceImageSha256,
      destination_metadata_sha256: file.destinationMetadataSha256, source_locator_json: file.sourceLocatorJson,
      source_file_id: file.createFile ? null : file.fileId, destination_file_id: file.fileId, location_id: file.locationId,
      profile_id: file.destinationProfileId, profile_revision: file.configurationRevision,
      namespace_identity: file.destinationNamespaceIdentity, object_key: file.objectKey, purpose: file.purpose,
      byte_size: file.byteSize, sha256: file.sha256, verification_operation_id: `fp5:${file.id}`,
      verified_at: now, published_at: now, producer_trust: file.purpose === "derived_preview" ? "untrusted_import" : "opaque_recovery", created_at: now }],
    recovery_file_alias_evidence: file.originalAliases.map(alias => ({ evidence_id: file.id, table_name: alias.table,
      alias_id: String(alias.row.id), original_json: stableJson(alias.row), destination_file_id: file.fileId })),
    recovery_file_binding_evidence: file.bindingEvidence.map(value => ({ evidence_id: file.id,
      consumer_kind: value.binding.consumerKind, consumer_id: value.binding.consumerId,
      consumer_sub_id: value.binding.consumerSubId, file_slot: value.binding.fileSlot, purpose: value.binding.purpose!,
      source_file_id: value.binding.fileId, row_sha256: value.rowSha256, preview_origin_json: value.previewOriginJson })),
  };
}
function appendExactRow(db: D1Database, table: string, row: ExportRow, keys: readonly string[], columns: readonly string[]): D1PreparedStatement[] {
  ensure(stableJson(Object.keys(row).sort()) === stableJson([...columns].sort()), "append_row_columns");
  const where = keys.map(key => `"${key}" IS ?`).join(" AND "), keyValues = keys.map(key => row[key]);
  const values = columns.map(column => row[column]);
  ensure(values.every(value => value === null || typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)), "append_row_cells");
  return [db.prepare(`INSERT INTO "${table}"(${columns.map(column => `"${column}"`).join(",")}) SELECT ${columns.map(() => "?").join(",")}
    WHERE NOT EXISTS(SELECT 1 FROM "${table}" WHERE ${where})`).bind(...values, ...keyValues),
  db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM "${table}" WHERE ${columns.map(column => `"${column}" IS ?`).join(" AND ")})=1
    THEN 1 ELSE json('Recovery appended identity changed') END`).bind(...values)];
}

/** The target is exclusively claimed, unserved, and its application triggers
 * are temporarily removed by the reviewed target installer. The parent must
 * prepend its persisted target/job/owner/generation publication fence and
 * commit these statements together with the verified target-file ledger ACK. */
export function recoveryFilePublicationStatements(
  db: D1Database, file: RecoveryPlannedFile, verified: Readonly<VerifiedBytes>, now: string,
): D1PreparedStatement[] {
  ensure(verified.byteSize === file.byteSize && verified.sha256 === file.sha256, "verification_mismatch");
  ensure(safeText(now, 200) && Number.isFinite(Date.parse(now)), "publication_clock");
  const statements: D1PreparedStatement[] = [];
  if (file.createFile) statements.push(db.prepare(`INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,verified_sha256,state,active_location_id,created_at)
    SELECT ?,?,'system',?,?,NULL,'unresolved',NULL,? WHERE NOT EXISTS(SELECT 1 FROM files WHERE id=?)`)
    .bind(file.fileId, file.purpose, file.byteSize, file.sha256, now, file.fileId));
  statements.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM files WHERE id=? AND purpose=? AND access_scope='system'
    AND (expected_byte_size IS NULL OR expected_byte_size=?) AND (expected_sha256 IS NULL OR expected_sha256=?))
    THEN 1 ELSE json('Recovery File identity changed') END`).bind(file.fileId, file.purpose, file.byteSize, file.sha256),
  ...appendExactRow(db, "file_locations", { id: file.locationId, file_id: file.fileId, storage_profile_id: file.destinationProfileId,
    object_key: file.objectKey, state: "unresolved", created_at: now }, ["id"], ["id", "file_id", "storage_profile_id", "object_key", "state", "created_at"]),
  ...appendExactRow(db, "file_location_publications", { location_id: file.locationId, file_id: file.fileId, storage_profile_id: file.destinationProfileId,
    object_key: file.objectKey, verified_byte_size: file.byteSize, verified_sha256: file.sha256,
    verification_method: "full_read_sha256", verification_operation_id: `fp5:${file.id}`, verified_at: now, published_at: now }, ["location_id"],
    ["location_id", "file_id", "storage_profile_id", "object_key", "verified_byte_size", "verified_sha256", "verification_method", "verification_operation_id", "verified_at", "published_at"]));
  if (file.publishAsActive) {
    if (file.nativePublicationExists) statements.push(db.prepare(`UPDATE file_publications SET active_location_id=? WHERE file_id=?
      AND purpose=? AND access_scope='system' AND state='ready' AND verified_byte_size=? AND verified_sha256=?`)
      .bind(file.locationId, file.fileId, file.purpose, file.byteSize, file.sha256));
    else statements.push(...appendExactRow(db, "file_publications", { file_id: file.fileId, purpose: file.purpose, access_scope: "system",
      verified_byte_size: file.byteSize, verified_sha256: file.sha256, active_location_id: file.locationId, state: "ready", published_at: now, retired_at: null },
    ["file_id"], ["file_id", "purpose", "access_scope", "verified_byte_size", "verified_sha256", "active_location_id", "state", "published_at", "retired_at"]));
    statements.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_publications WHERE file_id=? AND active_location_id=?
      AND purpose=? AND state='ready' AND verified_byte_size=? AND verified_sha256=?) THEN 1 ELSE json('Recovery publication changed') END`)
      .bind(file.fileId, file.locationId, file.purpose, file.byteSize, file.sha256));
  }
  const evidenceRows = recoveryFileEvidenceRows(file, now);
  for (const [table, columns] of Object.entries(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS)) for (const row of evidenceRows[table]) {
    const keys = table === "recovery_file_evidence" ? ["id"] : table === "recovery_file_alias_evidence" ? ["evidence_id", "table_name", "alias_id"]
      : ["evidence_id", "consumer_kind", "consumer_id", "consumer_sub_id", "file_slot"];
    statements.push(...appendExactRow(db, table, row, keys, columns));
  }
  for (const binding of file.bindings) {
    const spec = reviewedRecoveryBinding(binding);
    ensure(spec.purpose === file.purpose, "publication_binding_purpose");
    statements.push(...changeStatement(db, { table: spec.table, keys: spec.keys, column: spec.column, value: file.fileId }));
  }
  for (const alias of file.aliases) statements.push(...changeStatement(db, alias));
  return statements;
}

export const RECOVERY_DESTINATION_METADATA_COLUMNS = {
  storage_profile_admissions: STORAGE_PROFILE_ADMISSIONS_EXPORT_COLUMNS.storage_profile_admissions,
  storage_profile_activations: FILE_NATIVE_RUNTIME_TABLE_COLUMNS.storage_profile_activations,
  file_shadow_dependency_versions: ["dependency_kind", "dependency_key", "revision", "present", "snapshot_json"],
  file_shadow_profile_enablements: ["storage_profile_id", "configuration_revision", "enabled_by", "enabled_at"],
} as const;
/** Preserve every existing source profile/runtime cell. New destinations keep
 * their frozen nonsecret registration and activation history; local execution
 * guards and credential bindings remain disabled in the parent installer. */
export function recoveryDestinationProfileStatements(db: D1Database, profiles: readonly RecoveryDestinationProfile[]): D1PreparedStatement[] {
  return profiles.flatMap(profile => {
    ensure(["r2", "s3"].includes(profile.adapterType) && profile.configurationRevision === 1
      && safeText(profile.id, 256) && safeText(profile.namespaceIdentity, 2048), "destination_profile");
    const source = profile.adapterType === "r2" ? "bootstrap" : "system";
    const runtime = profile.runtime ?? { state: "read_only", registered_at: profile.createdAt, activated_at: null, retired_at: null };
    ensure(["read_only", "read_write", "retired"].includes(runtime.state) && runtime.registered_at === profile.createdAt
      && (runtime.state === "read_only" ? runtime.activated_at === null && runtime.retired_at === null
        : runtime.state === "read_write" ? runtime.activated_at !== null && runtime.retired_at === null : runtime.retired_at !== null), "destination_runtime");
    const statements = [db.prepare(`INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
      SELECT ?,?,?,?,NULL,1,'historical',? WHERE NOT EXISTS(SELECT 1 FROM storage_profiles WHERE id=?)`)
      .bind(profile.id, profile.adapterType, profile.namespaceIdentity, source, profile.createdAt, profile.id),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM storage_profiles WHERE id=? AND adapter_type=? AND namespace_identity=?
      AND configuration_source=? AND credential_reference IS NULL AND configuration_revision=1 AND state='historical')
      THEN 1 ELSE json('Recovery destination profile changed') END`).bind(profile.id, profile.adapterType, profile.namespaceIdentity, source),
    db.prepare(`INSERT INTO storage_profile_runtime(storage_profile_id,state,registered_at,activated_at,retired_at)
      SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM storage_profile_runtime WHERE storage_profile_id=?)`)
      .bind(profile.id, runtime.state, runtime.registered_at, runtime.activated_at, runtime.retired_at, profile.id)];
    for (const metadata of profile.metadataRows ?? []) {
      const columns = RECOVERY_DESTINATION_METADATA_COLUMNS[metadata.table]; ensure(columns, "destination_metadata_table");
      const row = metadata.row;
      if (metadata.table === "storage_profile_admissions") ensure(row.native_profile_id === profile.id, "destination_metadata_owner");
      else if (metadata.table === "file_shadow_dependency_versions") {
        ensure(["storage_profiles", "storage_profile_runtime"].includes(String(row.dependency_kind)) && row.dependency_key === stableJson([profile.id]), "destination_metadata_owner");
      } else ensure(row.storage_profile_id === profile.id, "destination_metadata_owner");
      const keys = metadata.table === "file_shadow_dependency_versions" ? ["dependency_kind", "dependency_key", "revision"]
        : metadata.table === "file_shadow_profile_enablements" ? ["storage_profile_id"] : ["operation_id"];
      statements.push(...appendExactRow(db, metadata.table, row, keys, columns));
    }
    return statements;
  });
}

/** Recorded source runtime and audit history remain exact. Execution quarantine
 * lives in installation-local guards, independently of recorded audit cells. */
export function recoveryDestinationProfileCellChanges(
  profiles: readonly RecoveryDestinationProfile[], records?: VersionedRecoveryRecords,
): RecoveryFileCellChange[] {
  void profiles; void records; return [];
}

export interface RecoveryFileWriteLifecycle {
  signal?: AbortSignal;
  /** Exact target claim, persisted attempt tuple, owner and generation. */
  current(): Promise<boolean>;
  /** Atomically save write_started before PUT. False forbids this transport. */
  writeStarted(file: Readonly<RecoveryPlannedFile>): Promise<boolean>;
}
/** One acknowledged PUT followed by full readback. Any thrown transport error
 * may follow a committed write: the caller records unknown and must reconcile
 * this key read-only rather than replaying it. This function never retries,
 * publishes, deletes, or enables the restored installation. */
export async function writeRecoveryFile(
  sourceEnv: Env, file: RecoveryPlannedFile,
  body: ReadableStream<Uint8Array> | ArrayBuffer, lifecycle: RecoveryFileWriteLifecycle,
): Promise<VerifiedBytes> {
  const frozen = { ...file }, env = { ...sourceEnv };
  const current = async () => !lifecycle.signal?.aborted && sourceEnv.DB === env.DB && await lifecycle.current() === true;
  let verificationStarted = false;
  try {
    if (!await current()) throw new ByteVerificationError("destination", "unavailable");
    const destination = await openShadowProfile(sourceEnv, { profileId: frozen.destinationProfileId, configurationRevision: frozen.configurationRevision }, "write", {
      signal: lifecycle.signal, beforeRequest: current,
    });
    if (!destination.writer || destination.storage.namespaceIdentity !== frozen.destinationNamespaceIdentity
      || destination.storage.adapterType !== frozen.destinationAdapterType) throw new ByteVerificationError("destination", "unavailable");
    let started = false;
    verificationStarted = true;
    return await writeVerifiedBytes({ reader: destination.reader, createHash: destination.createHash, writer: {
      accepts: destination.writer.accepts,
      async write(input) {
        if (started || !await current() || await lifecycle.writeStarted(frozen) !== true || !await current()) throw new ByteVerificationError("destination", "unavailable");
        started = true;
        await destination.writer!.write(input);
      },
    } }, { body, key: frozen.objectKey, byteSize: frozen.byteSize, sha256: frozen.sha256, contentType: frozen.contentType, filename: frozen.filename });
  } finally {
    if (!verificationStarted && !(body instanceof ArrayBuffer)) await body.cancel().catch(() => undefined);
  }
}
