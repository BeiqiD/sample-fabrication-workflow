import type { ExportRow, ExportTables, FullExportManifestV23 } from "./export";
import { RESEARCH_PACKAGE_EXPORT_COLUMNS } from "./export-research-package-schema";
import { buildFileNativeBlobExportPlan } from "./export-file-native-blob-plan";
import { validateFileJobHistory } from "./export-file-jobs";
import { validateFileNativeRuntimeExport } from "./export-file-native-runtime";
import { FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-migrations";
import { RESEARCH_PACKAGE_MAX_RECORD_BYTES, RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES, RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES } from "./research-package";
import { fileShadowSchemaFingerprint } from "./export-file-shadow";
import { stableJson } from "../domain/content-addressing";
import { researchImportedPreviewEvidence, researchNativeR2AssetEvidence } from "./export-research-preview-provenance";

// Reviewed whole-file/split successor; native D1 must match this exact slice.
export const RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256 = "f889414ca16d103fa92756ecd7bc5067bd634f723a5ad28b3ee89619781d5f35";

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid research package ${reason}`);
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const pair = (row: ExportRow) => stableJson([row.job_id, row.logical_file_id]);
const nullableTime = (value: unknown) => value === null || time(value);
const nullableText = (value: unknown) => value === null || text(value);
// SQLite treats an omitted timestamp offset as UTC. Apply the same millisecond
// rounding as its time predicates, independent of the restoring host's zone.
function sqliteMillis(value: unknown): number {
  const raw = String(value).trim(), local = raw.match(/^(\d{4}-\d{2}-\d{2})[ T]+(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
  const normalized = local ? `${local[1]}T${local[2]}Z` : raw;
  const fraction = normalized.match(/\.(\d+)(?=Z$|[+-]\d{2}:\d{2}$)/)?.[1];
  return Date.parse(normalized) + (fraction ? Math.round(Number(`0.${fraction}`) * 1000) - Number((fraction + "000").slice(0, 3)) : 0);
}
function json(value: unknown, reason: string): unknown {
  ensure(typeof value === "string", reason);
  try { return JSON.parse(value); } catch { ensure(false, reason); }
}

/** Full backups preserve ownership evidence, never infer an execution grant
 * from a recorded actor, old lease, or foreign installation incarnation. */
export function validateResearchPackageHistory(tables: ExportTables) {
  for (const [name, columns] of Object.entries(RESEARCH_PACKAGE_EXPORT_COLUMNS)) {
    ensure(Array.isArray(tables[name]), `${name} inventory`);
    for (const row of tables[name]) ensure(stableJson(Object.keys(row).sort()) === stableJson([...columns].sort()), `${name} columns`);
  }
  ensure(tables.research_package_source_identity.length === 1
    && tables.research_package_source_identity[0].singleton === 1
    && text(tables.research_package_source_identity[0].installation_id), "source installation identity");
  const profiles = new Map(tables.storage_profiles.map(row => [row.id, row]));
  const registeredFiles = new Map(tables.files.map(row => [row.id, row]));
  const locations = new Map(tables.file_locations.map(row => [row.id, row]));
  const publications = new Map(tables.file_location_publications.map(row => [row.location_id, row]));
  const filePublications = new Map(tables.file_publications.map(row => [row.file_id, row]));
  const assets = new Map(tables.assets.map(row => [row.id, row]));
  const managed = new Map((tables.managed_storage_objects ?? []).map(row => [row.id, row]));
  const jobs = new Map<unknown, ExportRow>(), files = new Map<string, ExportRow>();
  const requestIds = new Set<unknown>(), copyIds = new Set<string>();
  for (const job of tables.research_package_jobs) {
    ensure(text(job.id) && job.id.length <= 128 && !jobs.has(job.id) && text(job.request_id) && !requestIds.has(job.request_id)
      && text(job.actor) && job.actor.length <= 254 && text(job.package_id) && text(job.source_installation_id)
      && job.destination_scope === "system" && time(job.accepted_at) && time(job.updated_at)
      && Date.parse(job.updated_at) >= Date.parse(job.accepted_at) && integer(job.generation)
      && ["data_package", "report", "upload", "import"].includes(String(job.kind))
      && ["awaiting_upload", "queued", "running", "preview", "paused", "cancel_requested", "completed", "cancelled"].includes(String(job.state))
      && ["snapshot", "measure", "write", "validate", "preview", "copy", "publish", "done"].includes(String(job.phase))
      && nullableText(job.owner_token) && nullableText(job.runtime_incarnation) && nullableTime(job.lease_expires_at)
      && nullableTime(job.actor_checked_at) && nullableTime(job.expires_at), "job identity and state");
    ensure(job.state !== "running" || text(job.owner_token) && text(job.runtime_incarnation) && time(job.lease_expires_at), "recorded running claim");
    json(job.input_json, "accepted input"); json(job.target_policy_json, "frozen role policy");
    for (const name of ["domain_plan_json", "frozen_archive_json", "result_json"] as const) if (job[name] !== null) json(job[name], name);
    if (job.domain_plan_json !== null) ensure(new TextEncoder().encode(String(job.domain_plan_json)).byteLength <= RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES, "frozen copy plan size");
    if (job.frozen_archive_json !== null) ensure(new TextEncoder().encode(String(job.frozen_archive_json)).byteLength <= RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES, "frozen manifest size");
    ensure(job.package_digest === null || hash(job.package_digest), "package digest");
    if (job.kind === "import") {
      ensure(text(job.source_upload_job_id) && hash(job.package_digest) && text(job.copy_identity) && job.domain_plan_json !== null, "copy acceptance");
      const identity = stableJson([job.package_digest, job.destination_scope, job.actor, job.copy_identity]);
      ensure(!copyIds.has(identity), "unique copy identity"); copyIds.add(identity);
    }
    jobs.set(job.id, job); requestIds.add(job.request_id);
  }
  for (const job of jobs.values()) if (job.source_upload_job_id !== null) {
    const source = jobs.get(job.source_upload_job_id);
    ensure(source && source.kind === "upload" && source.actor === job.actor, "copy input ownership");
    const archives = tables.research_package_files.filter(file => file.job_id === source.id && file.entry_kind === "artifact");
    ensure(archives.length === 1 && text(archives[0].result_location_id), "accepted copy archive");
    const holds = tables.file_location_holds.filter(hold => hold.operation_id === `fp4-source:${job.id}`
      && hold.location_id === archives[0].result_location_id && hold.hold_kind === "accepted_operation");
    ensure(holds.length === 1 && holds[0].expires_at === null
      && (holds[0].released_at === null || ["completed", "cancelled"].includes(String(job.state))), "copy archive source hold");
  }
  const receipts = new Set<string>();
  for (const receipt of tables.research_package_requests) {
    const job = jobs.get(receipt.job_id), key = stableJson([receipt.actor, receipt.request_id]);
    ensure(job && receipt.actor === job.actor && text(receipt.request_id) && !receipts.has(key)
      && time(receipt.accepted_at) && [0, 1].includes(Number(receipt.reused)), "request receipt");
    json(receipt.input_json, "request receipt input"); receipts.add(key);
  }
  const recordIds = new Set<string>(), recordBytes = new Map<unknown, number>(), recordCounts = new Map<unknown, number>();
  for (const record of tables.research_package_records) {
    const key = stableJson([record.job_id, record.record_kind, record.source_id]);
    ensure(jobs.has(record.job_id) && text(record.record_kind) && text(record.source_id) && integer(record.ordinal) && !recordIds.has(key), "frozen domain record");
    json(record.record_json, "domain record JSON"); recordIds.add(key);
    ensure(new TextEncoder().encode(String(record.record_json)).byteLength <= RESEARCH_PACKAGE_MAX_RECORD_BYTES, "domain record size");
    recordBytes.set(record.job_id, (recordBytes.get(record.job_id) ?? 0) + new TextEncoder().encode(String(record.record_json)).byteLength);
    recordCounts.set(record.job_id, (recordCounts.get(record.job_id) ?? 0) + 1);
    ensure(recordBytes.get(record.job_id)! <= 4 * 1024 * 1024 && recordCounts.get(record.job_id)! <= 1200, "domain record budget");
  }
  const operations = new Set<unknown>(), paths = new Set<string>();
  for (const file of tables.research_package_files) {
    const job = jobs.get(file.job_id), identity = pair(file), path = stableJson([file.job_id, file.archive_path]);
    ensure(job && !files.has(identity) && text(file.logical_file_id) && text(file.archive_path) && !paths.has(path)
      && text(file.media_type) && text(file.hold_operation_id) && !operations.has(file.hold_operation_id)
      && ["source", "payload", "artifact"].includes(String(file.entry_kind))
      && ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"].includes(String(file.purpose))
      && integer(file.byte_size) && file.byte_size <= 100 * 1024 * 1024 && hash(file.sha256)
      && ["pending", "copying", "verified", "published", "failed", "cancelled"].includes(String(file.state)) && time(file.updated_at), "File identity");
    if (file.entry_kind === "source") {
      const source = publications.get(file.source_location_id), profile = profiles.get(file.source_profile_id), registered = registeredFiles.get(file.source_file_id);
      ensure(source && profile && registered && source.file_id === file.source_file_id && source.storage_profile_id === file.source_profile_id
        && source.object_key === file.source_object_key && source.verified_byte_size === file.byte_size && source.verified_sha256 === file.sha256
        && profile.configuration_revision === file.source_profile_revision && profile.namespace_identity === file.source_namespace
        && registered.purpose === file.purpose && registered.access_scope === "system" && file.target_profile_id === null
        && file.candidate_file_id === null, "frozen source tuple");
      if (file.source_alias_id !== null) {
        ensure(text(file.source_alias_id), "frozen source alias identity");
        const aliasId = file.source_alias_id;
        const alias = aliasId.startsWith("asset:") ? assets.get(aliasId.slice(6))
          : aliasId.startsWith("managed:") ? managed.get(aliasId.slice(8)) : undefined;
        const legacyMapping = alias && (tables.legacy_file_mappings ?? []).some(mapped => mapped.file_id === file.source_file_id
          && (aliasId.startsWith("asset:")
            ? mapped.store_kind === "r2" && mapped.provider === "r2" && mapped.object_key === alias.r2_key
            : mapped.store_kind === "managed" && mapped.provider === alias.provider && mapped.object_key === alias.object_key));
        ensure(alias && (alias.file_id === file.source_file_id
          || (alias.file_id === null || alias.file_id === undefined) && legacyMapping), "frozen source alias binding");
      }
      const holds = tables.file_location_holds.filter(row => row.operation_id === file.hold_operation_id
        && row.location_id === file.source_location_id && row.hold_kind === "export");
      ensure(holds.length === 1 && holds[0].expires_at === null
        && (holds[0].released_at === null || ["completed", "cancelled"].includes(String(job.state))), "frozen export source hold");
    } else {
      const profile = profiles.get(file.target_profile_id);
      const policies = json(job.target_policy_json, "frozen role policy") as Record<string, Record<string, unknown>>;
      const policy = policies[String(file.purpose)];
      ensure(profile && profile.configuration_revision === file.target_profile_revision && profile.namespace_identity === file.target_namespace
        && policy && policy.profileId === file.target_profile_id && policy.configurationRevision === file.target_profile_revision
        && policy.namespaceIdentity === file.target_namespace && policy.policyRevision === file.target_policy_revision
        && text(file.candidate_file_id), "frozen destination tuple");
      if (file.entry_kind === "artifact") ensure(file.logical_file_id === "@archive" && file.purpose === "job_output" && file.candidate_asset_id === null, "archive output identity");
    }
    if (file.archive_entry_json !== null) json(file.archive_entry_json, "archive index");
    if (file.reuse_file_id !== null) {
      const registered = registeredFiles.get(file.reuse_file_id), publication = publications.get(file.reuse_location_id), asset = assets.get(file.reuse_asset_id);
      // An immutable alias records its original address. Moving its File does
      // not rewrite that provenance; qualify the current destination and the
      // original alias separately instead of treating their profiles as equal.
      const typedMedia = (tables.state_representation_assets ?? []).some(row => row.asset_id === file.reuse_asset_id
        && (row.file_id === file.reuse_file_id || row.file_id === null && asset?.file_id === file.reuse_file_id));
      const nativeAlias = asset?.file_id === file.reuse_file_id && asset.sha256 === file.sha256
        && [...publications.values()].some(original => original.file_id === asset.file_id
          && original.storage_profile_id === asset.storage_profile_id && original.object_key === asset.object_key
          && original.verified_sha256 === asset.sha256 && original.verified_byte_size === asset.byte_size);
      const legacyAlias = asset?.file_id === null && text(asset.r2_key)
        && (asset.sha256 === null || asset.sha256 === file.sha256)
        && (tables.state_representation_assets ?? []).some(row => row.asset_id === asset.id && row.file_id === file.reuse_file_id)
        && (tables.legacy_file_mappings ?? []).some(mapped => mapped.store_kind === "r2" && mapped.provider === "r2"
          && mapped.object_key === asset.r2_key && mapped.file_id === file.reuse_file_id);
      ensure(file.entry_kind === "payload" && file.purpose !== "derived_preview" && registered && publication && asset && filePublications.has(file.reuse_file_id)
        && registered.purpose === file.purpose && registered.access_scope === "system" && publication.file_id === file.reuse_file_id
        && publication.storage_profile_id === file.target_profile_id && publication.verified_byte_size === file.byte_size && publication.verified_sha256 === file.sha256
        && typedMedia && (nativeAlias || legacyAlias) && asset.byte_size === file.byte_size
        && file.result_file_id === file.reuse_file_id && file.result_location_id === file.reuse_location_id
        && file.candidate_file_id === file.reuse_file_id && file.candidate_asset_id === file.reuse_asset_id
        && ["verified", "published"].includes(String(file.state)), "qualified canonical media reuse");
      const holds = tables.file_location_holds.filter(hold => hold.operation_id === `fp4-reuse:${job.id}:${file.logical_file_id}`
        && hold.location_id === file.reuse_location_id && hold.hold_kind === "accepted_operation");
      ensure(holds.length === 1 && holds[0].expires_at === null
        && (holds[0].released_at === null || ["completed", "cancelled"].includes(String(job.state))), "canonical reuse hold");
    } else ensure(file.reuse_location_id === null && file.reuse_asset_id === null, "complete reuse tuple");
    if (file.entry_kind === "artifact" && registeredFiles.has(file.candidate_file_id)) {
      const holds = (tables.file_holds ?? []).filter(hold => hold.operation_id === `fp4-output:${job.id}`
        && hold.file_id === file.candidate_file_id && hold.hold_kind === "accepted_operation");
      ensure(holds.length === 1 && holds[0].expires_at === null
        && (holds[0].released_at === null || ["completed", "cancelled"].includes(String(job.state))), "retained archive output hold");
    }
    files.set(identity, file); operations.add(file.hold_operation_id); paths.add(path);
  }
  for (const job of jobs.values()) {
    const selected = [...files.values()].filter(row => row.job_id === job.id && row.entry_kind !== "artifact");
    ensure(selected.length <= 100 && selected.reduce((sum, row) => sum + Number(row.byte_size), 0) <= 96 * 1024 * 1024, "File selection budget");
  }
  const attemptIds = new Set<unknown>(), candidateLocations = new Set<unknown>(), objectKeys = new Set<unknown>();
  const counts = new Map<string, number>(), publishedLocations = new Set<string>();
  for (const attempt of tables.research_package_attempts) {
    const job = jobs.get(attempt.job_id), file = files.get(pair(attempt)), location = locations.get(attempt.location_id), registered = registeredFiles.get(attempt.file_id);
    ensure(job && file && location && registered && file.entry_kind !== "source" && file.reuse_file_id === null
      && text(attempt.id) && !attemptIds.has(attempt.id) && !candidateLocations.has(attempt.location_id) && text(attempt.object_key) && !objectKeys.has(attempt.object_key)
      && attempt.file_id === file.candidate_file_id && registered.purpose === file.purpose && registered.access_scope === "system"
      && registered.expected_byte_size === file.byte_size && registered.expected_sha256 === file.sha256
      && location.file_id === attempt.file_id && location.storage_profile_id === file.target_profile_id && location.object_key === attempt.object_key
      && text(attempt.owner_token) && text(attempt.runtime_incarnation) && integer(attempt.generation) && attempt.generation <= Number(job.generation)
      && ["staged", "write_started", "unknown", "verified", "published", "failed", "cancelled"].includes(String(attempt.state))
      && time(attempt.created_at) && time(attempt.updated_at) && nullableTime(attempt.write_started_at) && nullableTime(attempt.io_settled_at) && nullableTime(attempt.verified_at), "registered attempt");
    ensure(Date.parse(attempt.created_at) >= Date.parse(String(job.accepted_at))
      && Date.parse(attempt.updated_at) >= Date.parse(attempt.created_at), "attempt creation clock");
    if (attempt.write_started_at !== null) ensure(Date.parse(String(attempt.write_started_at)) >= Date.parse(attempt.created_at), "write boundary clock");
    if (attempt.io_settled_at !== null) ensure(time(attempt.write_started_at)
      && Date.parse(String(attempt.io_settled_at)) >= Date.parse(attempt.write_started_at), "settled I/O clock");
    if (["write_started", "unknown", "verified", "published"].includes(String(attempt.state))) ensure(time(attempt.write_started_at), "durable write boundary");
    counts.set(pair(attempt), (counts.get(pair(attempt)) ?? 0) + 1); ensure(counts.get(pair(attempt))! <= 5, "candidate attempt budget");
    const holds = tables.file_location_holds.filter(row => row.operation_id === attempt.id && row.location_id === attempt.location_id && row.hold_kind === "accepted_operation");
    ensure(holds.length === 1 && holds[0].expires_at === null, "candidate hold coverage");
    if (["staged", "write_started", "unknown", "verified"].includes(String(attempt.state)) || attempt.write_started_at !== null && attempt.io_settled_at === null)
      ensure(holds[0].released_at === null, "uncertain output remains held");
    if (["verified", "published"].includes(String(attempt.state))) ensure(time(attempt.write_started_at) && time(attempt.io_settled_at)
      && time(attempt.verified_at) && Date.parse(attempt.verified_at) >= Date.parse(attempt.io_settled_at)
      && attempt.verified_byte_size === file.byte_size && attempt.verified_sha256 === file.sha256
      && text(attempt.verified_owner_token) && text(attempt.verified_runtime_incarnation)
      && integer(attempt.verified_generation) && attempt.verified_generation >= attempt.generation && attempt.verified_generation <= Number(job.generation), "independent full-byte verification");
    const publication = publications.get(attempt.location_id);
    if (attempt.state === "published") {
      ensure(file.state === "published" && file.result_file_id === attempt.file_id && file.result_location_id === attempt.location_id
        && publication && publication.file_id === attempt.file_id && publication.storage_profile_id === file.target_profile_id
        && publication.object_key === attempt.object_key && publication.verification_method === "full_read_sha256"
        && publication.verification_operation_id === attempt.id && publication.verified_at === attempt.verified_at
        && publication.verified_byte_size === file.byte_size && publication.verified_sha256 === file.sha256
        && time(publication.published_at) && Date.parse(publication.published_at) >= Date.parse(String(attempt.verified_at)), "committed package publication");
      publishedLocations.add(String(attempt.location_id));
    } else ensure(!publication, "uncommitted candidate cannot publish");
    attemptIds.add(attempt.id); candidateLocations.add(attempt.location_id); objectKeys.add(attempt.object_key);
  }
  for (const file of files.values()) if (file.entry_kind !== "source" && file.reuse_file_id === null && ["verified", "published"].includes(String(file.state)))
    ensure(tables.research_package_attempts.filter(attempt => pair(attempt) === pair(file) && attempt.file_id === file.result_file_id
      && attempt.location_id === file.result_location_id && attempt.state === file.state).length === 1, "File winner coverage");
  const maps = new Set<string>(), destinations = new Set<string>();
  for (const row of tables.research_package_identity_maps) {
    const key = stableJson([row.job_id, row.entity_kind, row.source_id]), destination = stableJson([row.job_id, row.entity_kind, row.destination_id]);
    ensure(jobs.get(row.job_id)?.kind === "import" && text(row.entity_kind) && text(row.source_id) && text(row.destination_id)
      && !maps.has(key) && !destinations.has(destination), "copy identity map"); maps.add(key); destinations.add(destination);
  }
  return { publishedLocations };
}

/** Disposable archives do not recursively become research data. Keep an
 * uploaded archive whenever a preview or unfinished import still needs it. */
export function buildResearchPackageBlobExportPlan(tables: ExportTables, snapshotClock?: string) {
  const jobs = new Map((tables.research_package_jobs ?? []).map(row => [row.id, row]));
  const requiredUploads = new Set((tables.research_package_jobs ?? []).filter(row => row.kind === "import"
    && !["completed", "cancelled"].includes(String(row.state))).map(row => row.source_upload_job_id));
  const protectedFiles = new Set((tables.file_consumer_projection ?? []).map(row => row.file_id));
  for (const row of tables.file_derivations ?? []) { protectedFiles.add(row.source_file_id); protectedFiles.add(row.derived_file_id); }
  for (const row of tables.file_migration_items ?? []) if (row.cleanup_released_at === null) protectedFiles.add(row.file_id);
  for (const row of tables.file_holds ?? []) if (row.hold_kind === "manual" && row.released_at === null) protectedFiles.add(row.file_id);
  for (const row of tables.research_package_files ?? []) if (row.entry_kind === "source"
    && !["completed", "cancelled"].includes(String(jobs.get(row.job_id)?.state))) protectedFiles.add(row.source_file_id);
  const excludedOutputs: FullExportManifestV23["excludedOutputs"] = [];
  for (const row of tables.research_package_files ?? []) {
    const job = jobs.get(row.job_id);
    if (!job || row.entry_kind !== "artifact" || row.purpose !== "job_output" || row.logical_file_id !== "@archive") continue;
    const expiredPreview = job.state === "preview" && typeof job.expires_at === "string" && typeof snapshotClock === "string"
      && Number.isFinite(sqliteMillis(job.expires_at)) && Number.isFinite(sqliteMillis(snapshotClock))
      && sqliteMillis(job.expires_at) <= sqliteMillis(snapshotClock);
    if (job.kind === "upload" && (requiredUploads.has(job.id)
      || !expiredPreview && ["awaiting_upload", "queued", "running", "preview", "paused", "cancel_requested"].includes(String(job.state)))) continue;
    for (const location of tables.file_locations ?? []) {
      if (location.file_id !== row.candidate_file_id || protectedFiles.has(location.file_id)) continue;
      if ((tables.file_location_holds ?? []).some(hold => hold.location_id === location.id && hold.hold_kind === "manual" && hold.released_at === null)) continue;
      excludedOutputs.push({ locationId: String(location.id), fileId: String(location.file_id), jobId: String(job.id), reason: "disposable_job_output" });
    }
  }
  excludedOutputs.sort((a, b) => a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0);
  const excluded = new Set(excludedOutputs.map(row => row.locationId));
  return { blobs: buildFileNativeBlobExportPlan({ ...tables, file_locations: (tables.file_locations ?? []).filter(row => !excluded.has(String(row.id))) }), excludedOutputs };
}

export async function validateResearchPackageExport(manifest: FullExportManifestV23) {
  const schema = manifest.artifacts.sourceSchema.value;
  ensure(await fileShadowSchemaFingerprint(schema.objects) === RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256, "schema fingerprint");
  const packages = validateResearchPackageHistory(manifest.tables), migrations = validateFileJobHistory(manifest.tables);
  ensure(Array.isArray(manifest.excludedOutputs) && stableJson(manifest.excludedOutputs) === stableJson(buildResearchPackageBlobExportPlan(manifest.tables, schema.snapshotClock).excludedOutputs), "explicit disposable output inventory");
  await validateFileNativeRuntimeExport(manifest.tables, schema.objects, manifest.artifacts.sourceRowids.value, {
    schemaSha256: RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256,
    publishedLocations: new Set([...migrations.publishedLocations, ...packages.publishedLocations]),
    historicalResultLocation: migrations.historicalResultLocation,
    importedPreviewEvidence: researchImportedPreviewEvidence(manifest.tables),
    packageR2AssetEvidence: researchNativeR2AssetEvidence(manifest.tables),
    historicalSchemaSha256s: [FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256],
  }, schema.snapshotClock);
}
