import type { ExportRow, ExportSchemaObject, ExportTables, FileShadowSourceRowids, FullExportBlobEntryV15 } from "./export";
import { sha256Hex, stableJson } from "../domain/content-addressing";
import { sqliteTableColumns } from "../domain/sqlite-table-columns";
import { buildBlobExportPlan } from "./export-blob-plan";
import { validateLegacyOverlap } from "./export-file-foundation";
import {
  canonicalFileAuthoritySchemaSql, FILE_AUTHORITY_CONSUMER_COLUMNS, FILE_AUTHORITY_EXPORTED_VIEWS,
  FILE_AUTHORITY_EXPORT_COLUMNS, FILE_AUTHORITY_EXPORT_VIEW_COLUMNS, legacyConsumerProjections,
} from "./export-file-authority";
import { FILE_SHADOW_DEPENDENCY_SPECS, FILE_SHADOW_EXPORT_COLUMNS, FILE_SHADOW_EXPORTED_VIEW_COLUMNS, FILE_SHADOW_LOCAL_TABLE_NAMES, FILE_SHADOW_SLOT_KEYS } from "./file-shadow-schema";

export { FILE_SHADOW_EXPORT_COLUMNS } from "./file-shadow-schema";
export const FILE_SHADOW_REBUILDABLE_TABLE_NAMES = ["file_registry_rowid_claims", ...FILE_SHADOW_LOCAL_TABLE_NAMES] as const;
export const FILE_SHADOW_EXPORT_VIEW_COLUMNS = { ...FILE_AUTHORITY_EXPORT_VIEW_COLUMNS, ...FILE_SHADOW_EXPORTED_VIEW_COLUMNS } as const;
export const FILE_SHADOW_EXPORTED_VIEWS = [...FILE_AUTHORITY_EXPORTED_VIEWS, ...Object.keys(FILE_SHADOW_EXPORTED_VIEW_COLUMNS)] as const;
export const FILE_SHADOW_SCHEMA_FINGERPRINT_ALGORITHM = "file-shadow-sqlite-schema/v1" as const;
export const FILE_SHADOW_SOURCE_ROWIDS_PATH = "provenance/source-rowids.json";
export const FILE_SHADOW_SOURCE_TABLE_NAMES = Object.keys(FILE_AUTHORITY_CONSUMER_COLUMNS);
/** Proves every current source has its exact bridge head in the same snapshot.
 * Materialize the thirteen source branches once: expanding their dependency
 * projections twice exceeds D1's statement compilation budget. */
export const FILE_SHADOW_HEAD_INTEGRITY_SQL = `WITH sources AS MATERIALIZED (
  SELECT consumer_kind,consumer_id,consumer_sub_id,file_slot,source_rowid,source_json FROM file_shadow_sources
)
SELECT COUNT(*) AS invalid_count FROM (
  SELECT 1 FROM file_shadow_heads h LEFT JOIN sources s
    ON s.consumer_kind IS h.consumer_kind AND s.consumer_id IS h.consumer_id AND s.consumer_sub_id IS h.consumer_sub_id AND s.file_slot IS h.file_slot
  WHERE (h.present=1 AND (s.source_rowid IS NULL OR s.source_rowid IS NOT h.source_rowid OR s.source_json IS NOT h.source_json))
     OR (h.present=0 AND s.source_rowid IS NOT NULL)
  UNION ALL SELECT 1 FROM sources s LEFT JOIN file_shadow_heads h
    ON s.consumer_kind IS h.consumer_kind AND s.consumer_id IS h.consumer_id AND s.consumer_sub_id IS h.consumer_sub_id AND s.file_slot IS h.file_slot
  WHERE h.occurrence_id IS NULL
)`;
// Replaced only from the reviewed whole-file/split/D1 0001–0008 checkpoint.
export const FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256 = "8a1686e742e6306ab890121da672da199d0d1d33fd20556cbf4ef1cfd6c53788";
const PLATFORM = new Set(["d1_migrations", "_cf_KV", "_cf_METADATA"]);

export function fileShadowSchemaSlice(objects: ExportSchemaObject[]) {
  return objects.filter((entry) => !PLATFORM.has(entry.tableName) && !entry.tableName.startsWith("sqlite_"))
    .map((entry) => ({ type: entry.type, name: entry.name, tableName: entry.tableName,
      sql: entry.sql === null ? null : canonicalFileAuthoritySchemaSql(entry.sql) }))
    .sort((a, b) => {
      const left = `${a.type}\0${a.name}\0${a.tableName}`, right = `${b.type}\0${b.name}\0${b.tableName}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
}
export async function fileShadowSchemaFingerprint(objects: ExportSchemaObject[]) {
  return sha256Hex(JSON.stringify([FILE_SHADOW_SCHEMA_FINGERPRINT_ALGORITHM,
    fileShadowSchemaSlice(objects).map((entry) => [entry.type, entry.name, entry.tableName, entry.sql])]));
}
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid File shadow ${reason}`);
}
const rows = (tables: ExportTables, name: string): ExportRow[] => {
  ensure(Array.isArray(tables[name]), `${name} inventory`); return tables[name];
};
const sameRows = (a: ExportRow[], b: ExportRow[]) => stableJson(a.map(stableJson).sort()) === stableJson(b.map(stableJson).sort());
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const size = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const keyOf = (row: ExportRow) => stableJson([row.consumer_kind, row.consumer_id, row.consumer_sub_id, row.file_slot]);
function indexed(entries: ExportRow[], column: string, name: string) {
  const output = new Map<string, ExportRow>();
  for (const entry of entries) {
    ensure(text(entry[column]) && !output.has(entry[column]), `${name} identity`);
    output.set(entry[column], entry);
  }
  return output;
}

export async function validateFileShadowSourceRowids(tables: ExportTables, value: FileShadowSourceRowids) {
  ensure(value && value.version === 1 && value.kind === "file-shadow-source-rowids" && value.tables
    && stableJson(Object.keys(value).sort()) === stableJson(["kind", "tables", "version"])
    && stableJson(Object.keys(value.tables).sort()) === stableJson([...FILE_SHADOW_SOURCE_TABLE_NAMES].sort()), "source-rowid artifact inventory");
  for (const name of FILE_SHADOW_SOURCE_TABLE_NAMES) {
    const entries = value.tables[name], source = rows(tables, name), seen = new Set<string>();
    ensure(Array.isArray(entries) && entries.length === source.length, `${name} source-rowid coverage`);
    for (const [index, entry] of entries.entries()) {
      ensure(entry && stableJson(Object.keys(entry).sort()) === stableJson(["rowSha256", "rowid"]) && typeof entry.rowid === "string"
        && /^-?(?:0|[1-9][0-9]*)$/.test(entry.rowid) && !seen.has(entry.rowid) && hash(entry.rowSha256), `${name} source-rowid identity`);
      const rowid = BigInt(entry.rowid);
      ensure(rowid >= -(1n << 63n) && rowid < (1n << 63n) && rowid.toString() === entry.rowid, `${name} source-rowid range`);
      ensure(await sha256Hex(stableJson(source[index])) === entry.rowSha256, `${name} source-rowid row digest`);
      seen.add(entry.rowid);
    }
  }
}

/** V15 retains every physical File location independently of legacy keys.
 * A pending candidate is explicit metadata, never a speculative download. */
export function buildFileShadowBlobExportPlan(tables: ExportTables): FullExportBlobEntryV15[] {
  const result: FullExportBlobEntryV15[] = buildBlobExportPlan(tables).map((entry) => ({
    ...entry, byteAuthority: "legacy", storageProfileId: null, storageProfileRevision: null, locationId: null,
  }));
  const profiles = new Map((tables.storage_profiles ?? []).map((row) => [row.id, row]));
  const files = new Map((tables.files ?? []).map((row) => [row.id, row]));
  const publications = new Map((tables.file_location_publications ?? []).map((row) => [row.location_id, row]));
  const availability = new Map((tables.file_location_availability ?? []).map((row) => [row.location_id, row]));
  for (const location of [...tables.file_locations ?? []].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)) {
    const profile = profiles.get(location.storage_profile_id), file = files.get(location.file_id);
    const publication = publications.get(location.id), available = availability.get(location.id);
    ensure(profile && file && text(location.id) && text(location.object_key) && text(profile.id)
      && (profile.adapter_type === "r2" || profile.adapter_type === "switchdrive")
      && size(profile.configuration_revision), "location byte address");
    const ready = publication && available?.availability === "available"
      && hash(publication.verified_sha256) && size(publication.verified_byte_size);
    result.push({
      locatorId: JSON.stringify(["file_location", profile.id, profile.configuration_revision, location.object_key]),
      storeKind: profile.adapter_type === "r2" ? "r2" : "managed", provider: profile.adapter_type,
      objectKey: location.object_key, blobRecordIds: [location.id], filename: `location-${location.id}.blob`,
      expectedByteSize: publication ? Number(publication.verified_byte_size) : typeof file.expected_byte_size === "number" ? file.expected_byte_size : null,
      expectedSha256: publication ? String(publication.verified_sha256) : typeof file.expected_sha256 === "string" ? file.expected_sha256 : null,
      sourceOccurrences: (tables.file_location_retention_edges ?? []).filter((edge) => edge.location_id === location.id).map((edge) => ({
        sourceType: String(edge.source_type), sourceId: String(edge.source_id), occurrenceType: String(edge.occurrence_type),
        occurrenceId: String(edge.occurrence_id), retentionReason: String(edge.retention_reason),
        retainUntil: typeof edge.retain_until === "string" ? edge.retain_until : null,
      })),
      downloadUrl: ready ? `/exports/file-locations/${encodeURIComponent(location.id)}?profile=${encodeURIComponent(profile.id)}&revision=${profile.configuration_revision}` : null,
      initialOutcome: ready ? null : "metadata_not_ready", byteAuthority: "file_location",
      storageProfileId: profile.id, storageProfileRevision: profile.configuration_revision, locationId: location.id,
    });
  }
  return result;
}

function validateFoundation(tables: ExportTables) {
  const mappings = rows(tables, "legacy_file_mappings");
  const mappedFiles = new Set(mappings.map((row) => row.file_id)), mappedLocations = new Set(mappings.map((row) => row.location_id));
  // The old observation subgraph stays frozen; new shadow-only locations do
  // not gain fabricated legacy mappings to satisfy a historical validator.
  validateLegacyOverlap({ ...tables, files: rows(tables, "files").filter((row) => mappedFiles.has(row.id)),
    file_locations: rows(tables, "file_locations").filter((row) => mappedLocations.has(row.id)) });
  const profiles = indexed(rows(tables, "storage_profiles"), "id", "profile");
  const files = indexed(rows(tables, "files"), "id", "file");
  const locations = indexed(rows(tables, "file_locations"), "id", "location");
  const addresses = new Set<string>();
  for (const file of files.values()) ensure(file.state === "unresolved" && file.verified_sha256 === null && file.active_location_id === null
    && file.access_scope === "system" && (file.expected_sha256 === null || hash(file.expected_sha256))
    && (file.expected_byte_size === null || size(file.expected_byte_size)), "unresolved File foundation");
  for (const location of locations.values()) {
    const address = stableJson([location.storage_profile_id, location.object_key]);
    ensure(location.state === "unresolved" && files.has(String(location.file_id)) && profiles.has(String(location.storage_profile_id))
      && text(location.object_key) && !addresses.has(address), "physical location identity");
    addresses.add(address);
  }
  const runtime = indexed(rows(tables, "storage_profile_runtime"), "storage_profile_id", "profile runtime");
  ensure(runtime.size === profiles.size, "runtime/profile cardinality");
  for (const [id, entry] of runtime) ensure(profiles.has(id) && entry.registered_at === profiles.get(id)!.created_at
    && ["read_only", "read_write", "retired"].includes(String(entry.state)), "profile runtime state");
  const publications = indexed(rows(tables, "file_location_publications"), "location_id", "location publication");
  const filePublications = indexed(rows(tables, "file_publications"), "file_id", "File publication");
  for (const [id, publication] of publications) {
    const location = locations.get(id), file = files.get(String(publication.file_id));
    ensure(location && file && location.file_id === publication.file_id && location.storage_profile_id === publication.storage_profile_id
      && location.object_key === publication.object_key && publication.verification_method === "full_read_sha256"
      && hash(publication.verified_sha256) && size(publication.verified_byte_size)
      && publication.verified_sha256 === file.expected_sha256 && publication.verified_byte_size === file.expected_byte_size
      && text(publication.verification_operation_id) && time(publication.verified_at) && time(publication.published_at), "verified location publication");
  }
  for (const [id, publication] of filePublications) {
    const file = files.get(id), location = publications.get(String(publication.active_location_id));
    ensure(file && publication.purpose === file.purpose && publication.access_scope === file.access_scope
      && publication.verified_sha256 === file.expected_sha256 && publication.verified_byte_size === file.expected_byte_size
      && time(publication.published_at)
      && (publication.state === "ready" && publication.retired_at === null && location?.file_id === id
        && location.verified_sha256 === publication.verified_sha256 && location.verified_byte_size === publication.verified_byte_size
        || publication.state === "retired" && publication.active_location_id === null && time(publication.retired_at)), "File publication identity");
  }
  for (const [name, column, targets] of [
    ["file_holds", "file_id", files], ["file_location_holds", "location_id", locations],
    ["file_location_gc_ledger", "location_id", locations], ["file_location_integrity_quarantine", "location_id", locations],
  ] as const) for (const entry of rows(tables, name)) ensure(targets.has(String(entry[column])), `${name} owner`);
  for (const entry of rows(tables, "file_derivations")) {
    const sourceFile = files.get(String(entry.source_file_id)), derivedFile = files.get(String(entry.derived_file_id));
    ensure(sourceFile && derivedFile && entry.source_file_id !== entry.derived_file_id
      && ["derived_preview", "job_output"].includes(String(derivedFile.purpose)) && hash(entry.parameters_sha256), "derivation File identity");
    if (entry.trust_state === "unverified") ensure(entry.source_verified_sha256 === null
      && entry.derived_verified_sha256 === null && entry.verification_operation_id === null, "unverified derivation cannot claim verified bytes");
    else {
      const source = filePublications.get(String(entry.source_file_id)), derived = filePublications.get(String(entry.derived_file_id));
      ensure(entry.trust_state === "verified" && source && derived && entry.source_verified_sha256 === source.verified_sha256
        && entry.derived_verified_sha256 === derived.verified_sha256 && text(entry.verification_operation_id), "derivation publications");
    }
  }
  const expectedAvailability = [...publications.values()].map((publication) => {
    const location = locations.get(String(publication.location_id))!;
    const mapped = mappings.find((entry) => entry.location_id === location.id);
    const legacyMatch = (entry: ExportRow) => mapped && entry.store_kind === mapped.store_kind && entry.provider === mapped.provider && entry.object_key === mapped.object_key;
    const newGc = rows(tables, "file_location_gc_ledger").find((entry) => entry.location_id === location.id);
    const oldGc = rows(tables, "blob_gc_ledger").find(legacyMatch);
    const states = [newGc?.state, oldGc?.state];
    const availability = states.includes("deleted") ? "deleted" : states.includes("deleting") ? "deleting" : states.includes("orphaned") ? "orphaned"
      : rows(tables, "file_location_integrity_quarantine").some((entry) => entry.location_id === location.id)
        || rows(tables, "blob_integrity_quarantine").some(legacyMatch) ? "quarantined"
        : runtime.get(String(publication.storage_profile_id))!.state === "retired" ? "profile_retired" : "available";
    return { location_id: publication.location_id, file_id: publication.file_id, storage_profile_id: publication.storage_profile_id,
      object_key: publication.object_key, verified_byte_size: publication.verified_byte_size, verified_sha256: publication.verified_sha256,
      availability, is_active_location: [...filePublications.values()].some((entry) => entry.state === "ready" && entry.active_location_id === location.id) ? 1 : 0 };
  });
  ensure(sameRows(rows(tables, "file_location_availability"), expectedAvailability), "location availability projection");
  return { files, locations, publications, filePublications };
}

/** A portable record of overlap, never permission to execute restored work. */
export async function validateFileShadowExport(tables: ExportTables, schemaObjects: ExportSchemaObject[], sourceRowids?: FileShadowSourceRowids) {
  ensure(await fileShadowSchemaFingerprint(schemaObjects) === FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256, "schema fingerprint");
  for (const [name, columns] of Object.entries({ ...FILE_AUTHORITY_EXPORT_COLUMNS, ...FILE_SHADOW_EXPORT_COLUMNS })) {
    const entry = schemaObjects.find((object) => object.type === "table" && object.name === name);
    ensure(entry && typeof entry.sql === "string" && stableJson(sqliteTableColumns(entry.sql, name).sort()) === stableJson([...columns].sort()), `${name} columns`);
    for (const item of rows(tables, name)) ensure(stableJson(Object.keys(item).sort()) === stableJson([...columns].sort()), `${name} row columns`);
  }
  for (const [name, columns] of Object.entries(FILE_AUTHORITY_CONSUMER_COLUMNS)) {
    for (const item of rows(tables, name)) ensure(columns.every((column) => item[column] === null), "legacy typed bindings must remain null during shadow");
  }
  ensure(rows(tables, "file_consumer_migration_decisions").length === 0 && rows(tables, "file_acceptance_candidates").length === 0, "legacy decisions/candidates stay empty");
  const control = rows(tables, "file_authority_control");
  ensure(control.length === 1 && control[0].singleton === 1 && ["legacy", "overlap"].includes(String(control[0].mode)) && control[0].revision === 1
    && (control[0].mode === "legacy" ? control[0].activated_at === null : time(control[0].activated_at)), "recorded authority mode");
  const graph = validateFoundation(tables);
  const projections = legacyConsumerProjections(tables);
  for (const [name, expected] of Object.entries(projections)) ensure(sameRows(rows(tables, name), expected), `${name} source projection`);
  ensure(sameRows(rows(tables, "file_consumer_projection"), Object.values(projections).flat()), "legacy consumer aggregate");
  validateShadowHistory(tables, graph, sourceRowids);
}

const dependencyReferences: Record<string, string> = {
  sourceAsset: "assets", sourceManaged: "managed_storage_objects", ownerImport: "imports", sample: "samples", run: "runs", step: "run_steps",
  submission: "comment_submissions", submissionTargets: "comment_submission_targets", targetSteps: "run_steps", targetRuns: "runs", targetSamples: "samples",
  pairedItem: "comment_submission_items", state: "state_representations", template: "template_versions", projectContent: "project_contents", project: "projects",
  projectItem: "project_items", uploadReceipts: "r2_upload_requests", metrologyReceipts: "metrology_reference_upload_requests",
  commentReceipts: "comment_item_acceptances", submissionReceipt: "comment_submission_acceptances", gc: "blob_gc_ledger",
  quarantine: "blob_integrity_quarantine", mappings: "legacy_file_mappings",
};
function parsedJson(value: unknown, reason: string): unknown {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : undefined; } catch { /* rejected below */ }
  ensure(parsed !== undefined, reason); return parsed;
}
function dependencyScalar(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value) || stableJson(Object.keys(value)) !== stableJson(["$sqliteBlob"])) return false;
  const blob = (value as Record<string, unknown>).$sqliteBlob;
  return typeof blob === "string" && /^(?:[0-9A-F]{2})*$/.test(blob);
}
function validateDependencyHistory(tables: ExportTables) {
  const versions = new Map<string, ExportRow>(), histories = new Map<string, ExportRow[]>();
  const currentByFamily = new Map<string, ExportRow[]>();
  for (const [table, spec] of Object.entries(FILE_SHADOW_DEPENDENCY_SPECS)) for (const row of rows(tables, table)) {
    const family = stableJson([table, spec.keyColumns.map((name) => row[name])]);
    const current = currentByFamily.get(family) ?? []; current.push(row); currentByFamily.set(family, current);
  }
  for (const row of rows(tables, "file_shadow_dependency_versions")) {
    const spec = FILE_SHADOW_DEPENDENCY_SPECS[row.dependency_kind as keyof typeof FILE_SHADOW_DEPENDENCY_SPECS];
    const key = parsedJson(row.dependency_key, "dependency key JSON"), snapshot = parsedJson(row.snapshot_json, "dependency snapshot JSON");
    ensure(spec && Array.isArray(key) && key.length === spec.keyColumns.length && key.every(dependencyScalar) && size(row.revision) && row.revision > 0
      && [0, 1].includes(Number(row.present)), "dependency revision identity");
    if (row.present === 1) {
      ensure(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        && stableJson(Object.keys(snapshot).sort()) === stableJson([...spec.snapshotColumns].sort()), "dependency snapshot columns");
      ensure(Object.values(snapshot).every(dependencyScalar), "dependency snapshot values");
      ensure(stableJson(spec.keyColumns.map((name) => (snapshot as Record<string, unknown>)[name])) === stableJson(key), "dependency snapshot key");
    } else ensure(row.present === 0 && snapshot === null, "dependency disappearance evidence");
    const family = stableJson([row.dependency_kind, key]), identity = stableJson([row.dependency_kind, key, row.revision]);
    ensure(!versions.has(identity), "duplicate dependency revision"); versions.set(identity, row);
    const history = histories.get(family) ?? []; history.push(row); histories.set(family, history);
  }
  for (const [family, history] of histories) {
    history.sort((a, b) => Number(a.revision) - Number(b.revision));
    ensure(history.every((row, index) => row.revision === index + 1 && (row.present === 1 || index > 0 && history[index - 1].present === 1)), "dependency revision chain");
    const [table] = JSON.parse(family) as [keyof typeof FILE_SHADOW_DEPENDENCY_SPECS, unknown[]], spec = FILE_SHADOW_DEPENDENCY_SPECS[table];
    const current = currentByFamily.get(family) ?? [];
    const latest = history.at(-1)!;
    ensure(latest.present === 1 ? current.length === 1 : current.length === 0, "dependency latest presence");
    if (latest.present === 1) ensure(stableJson(parsedJson(latest.snapshot_json, "dependency snapshot JSON"))
      === stableJson(Object.fromEntries(spec.snapshotColumns.map((name) => [name, current[0][name]]))), "dependency latest metadata");
  }
  for (const family of currentByFamily.keys()) ensure(histories.has(family), "missing current dependency history");
  return versions;
}

function validateShadowHistory(tables: ExportTables, graph: ReturnType<typeof validateFoundation>, sourceRowids?: FileShadowSourceRowids) {
  const control = rows(tables, "file_shadow_control");
  ensure(control.length === 1 && control[0].singleton === 1 && size(control[0].epoch), "shadow epoch");
  const epoch = control[0].epoch;
  const dependencyVersions = validateDependencyHistory(tables);
  const profileRevision = rows(tables, "file_shadow_dependency_versions").filter((row) => ["storage_profiles", "storage_profile_runtime"].includes(String(row.dependency_kind))).length;
  const occurrences = indexed(rows(tables, "file_shadow_occurrences"), "id", "occurrence");
  const allowedSlots = new Set(FILE_SHADOW_SLOT_KEYS.map(([kind, slot]) => stableJson([kind, slot])));
  const generations = new Set<string>();
  for (const occurrence of occurrences.values()) {
    ensure([occurrence.consumer_kind, occurrence.consumer_id, occurrence.consumer_sub_id, occurrence.file_slot].every((value) => typeof value === "string")
      && size(occurrence.generation) && occurrence.generation > 0 && [0, 1].includes(Number(occurrence.present))
      && size(occurrence.observed_epoch) && occurrence.observed_epoch <= Number(epoch) && time(occurrence.observed_at), "occurrence generation");
    ensure(allowedSlots.has(stableJson([occurrence.consumer_kind, occurrence.file_slot]))
      && (occurrence.present === 1 ? Number.isSafeInteger(occurrence.source_rowid)
        : occurrence.source_rowid === null && occurrence.source_json === "{}" && occurrence.legacy_store_kind === null
          && occurrence.legacy_provider === null && occurrence.legacy_object_key === null), "occurrence slot/source identity");
    const generation = stableJson([keyOf(occurrence), occurrence.generation]);
    ensure(!generations.has(generation), "duplicate occurrence generation"); generations.add(generation);
    ensure(typeof occurrence.source_json === "string", "occurrence source evidence");
    let source: unknown; try { source = JSON.parse(occurrence.source_json); } catch { /* rejected below */ }
    ensure(source && typeof source === "object" && !Array.isArray(source), "occurrence source evidence");
    if (occurrence.present === 1) {
      const dependencies = (source as Record<string, unknown>)._dependencies;
      ensure(dependencies && typeof dependencies === "object" && !Array.isArray(dependencies), "occurrence dependency references");
      ensure(size((dependencies as Record<string, unknown>).profileRevision)
        && Number((dependencies as Record<string, unknown>).profileRevision) <= profileRevision, "occurrence profile revision");
      for (const [name, value] of Object.entries(dependencies)) {
        if (name === "profileRevision") continue;
        const kind = dependencyReferences[name]; ensure(kind, "unknown occurrence dependency kind");
        for (const token of value === null ? [] : Array.isArray(value) ? value : [value]) {
          ensure(token && typeof token === "object" && stableJson(Object.keys(token).sort()) === stableJson(["dependency_key", "revision"]), "occurrence dependency token");
          const key = token.dependency_key;
          ensure(Array.isArray(key) && key.every(dependencyScalar) && size(token.revision) && token.revision > 0
            && dependencyVersions.get(stableJson([kind, key, token.revision]))?.present === 1, "occurrence references missing dependency revision");
        }
      }
    }
  }
  const heads = new Set<string>(), headOccurrences = new Set<string>();
  const sourceTables: Record<string, [string, string, string?]> = {
    state_representation_asset: ["state_representation_assets", "state_hash", "asset_id"], run_step_asset: ["run_step_assets", "id"],
    metrology_template_reference: ["metrology_template_references", "id"], run_step_comment: ["run_step_comments", "id"],
    state_verification: ["state_verifications", "id"], comment_submission_item: ["comment_submission_items", "id"],
    project_content_attachment: ["project_content_attachments", "project_content_id"], attachment_derivative: ["attachment_derivatives", "id"],
    event: ["events", "id"], import: ["imports", "id"], template_version: ["template_versions", "id"],
  };
  for (const head of rows(tables, "file_shadow_heads")) {
    const occurrence = occurrences.get(String(head.occurrence_id)), key = keyOf(head);
    ensure(occurrence && !heads.has(key) && keyOf(occurrence) === key && occurrence.generation === head.generation
      && occurrence.present === head.present && occurrence.source_json === head.source_json && occurrence.source_rowid === head.source_rowid
      && occurrence.observed_epoch === head.observed_epoch, "head/occurrence identity"); heads.add(key); headOccurrences.add(String(occurrence.id));
    if (sourceRowids && head.present === 1) {
      const [table, id, sub] = sourceTables[String(head.consumer_kind)];
      const source = rows(tables, table), index = source.findIndex((row) => row[id] === head.consumer_id && (!sub || row[sub] === head.consumer_sub_id));
      ensure(index >= 0 && sourceRowids.tables[table][index].rowid === String(head.source_rowid), "head/current physical source identity");
      const evidence = JSON.parse(String(head.source_json));
      for (const [name, value] of Object.entries(evidence)) if (Object.hasOwn(source[index], name)) ensure(stableJson(value) === stableJson(source[index][name]), "head/current source evidence");
    }
  }
  const closed = new Set<string>(), successors = new Set<string>();
  for (const closure of rows(tables, "file_shadow_closures")) {
    const prior = occurrences.get(String(closure.occurrence_id)), successor = occurrences.get(String(closure.successor_occurrence_id));
    ensure(prior && successor && keyOf(prior) === keyOf(successor) && Number(successor.generation) === Number(prior.generation) + 1
      && !closed.has(String(prior.id)) && !successors.has(String(successor.id)) && closure.closed_epoch === successor.observed_epoch
      && Number(closure.closed_epoch) >= Number(prior.observed_epoch) && closure.closed_at === successor.observed_at
      && time(closure.closed_at), "occurrence closure chain"); closed.add(String(prior.id)); successors.add(String(successor.id));
  }
  for (const head of rows(tables, "file_shadow_heads")) ensure(!closed.has(String(head.occurrence_id)), "closed current head");
  for (const occurrence of occurrences.values()) ensure(Number(occurrence.generation) === 1 || successors.has(String(occurrence.id)), "missing occurrence predecessor");
  for (const occurrence of occurrences.values()) ensure(closed.has(String(occurrence.id)) || headOccurrences.has(String(occurrence.id)), "unowned current occurrence");
  const authority = rows(tables, "file_authority_control")[0];
  const enablements = rows(tables, "file_shadow_enablements");
  ensure(authority.mode === "legacy" ? enablements.length === 0
    : enablements.length === 1 && enablements[0].singleton === 1 && size(enablements[0].expected_epoch)
      && enablements[0].expected_epoch <= Number(epoch) && enablements[0].enabled_at === authority.activated_at
      && enablements[0].enabled_at === authority.updated_at && text(enablements[0].enabled_by), "explicit overlap enablement");
  const profiles = indexed(rows(tables, "storage_profiles"), "id", "profile");
  const runtime = indexed(rows(tables, "storage_profile_runtime"), "storage_profile_id", "profile runtime");
  const profileEnablements = indexed(rows(tables, "file_shadow_profile_enablements"), "storage_profile_id", "profile enablement");
  for (const [id, enablement] of profileEnablements) ensure(profiles.has(id) && profiles.get(id)!.configuration_revision === enablement.configuration_revision
    && text(enablement.enabled_by) && time(enablement.enabled_at) && runtime.get(id)?.activated_at === enablement.enabled_at
    && runtime.get(id)?.state === "read_write", "explicit writable profile");
  for (const [id, entry] of runtime) ensure(entry.state !== "read_write" || profileEnablements.has(id), "unrecorded profile enablement");
  const operations = indexed(rows(tables, "file_shadow_operations"), "id", "operation");
  const attempts = indexed(rows(tables, "file_shadow_attempts"), "id", "attempt");
  const decisions = indexed(rows(tables, "file_shadow_decisions"), "occurrence_id", "decision");
  if (authority.mode === "legacy") ensure(!operations.size && !attempts.size && !decisions.size && !profileEnablements.size
    && graph.publications.size === 0 && graph.filePublications.size === 0
    && ["file_derivations", "file_holds", "file_location_holds", "file_location_gc_ledger", "file_location_integrity_quarantine",
      "file_shadow_legacy_holds", "file_shadow_reconciliations", "file_shadow_checkpoints"].every((name) => rows(tables, name).length === 0),
  "legacy mode cannot contain executed shadow state");
  const pendingOperations = new Set<string>();
  for (const operation of operations.values()) {
    if (operation.status === "pending") {
      ensure(!pendingOperations.has(String(operation.occurrence_id)), "competing pending operations");
      pendingOperations.add(String(operation.occurrence_id));
    }
    const occurrence = occurrences.get(String(operation.occurrence_id));
    ensure(occurrence && occurrence.present === 1 && size(operation.captured_epoch) && operation.captured_epoch >= Number(occurrence.observed_epoch)
      && operation.captured_epoch <= Number(epoch) && hash(operation.baseline_sha256) && operation.access_scope === "system"
      && operation.source_store_kind === occurrence.legacy_store_kind && operation.source_provider === occurrence.legacy_provider
      && operation.source_object_key === occurrence.legacy_object_key && text(operation.created_by) && time(operation.created_at)
      && ["pending", "resolved", "admitted_unresolved", "cancelled"].includes(String(operation.status))
      && (operation.status === "pending" ? operation.completed_at === null : time(operation.completed_at)), "frozen operation source");
    for (const side of ["source", "destination"] as const) {
      const id = operation[`${side}_profile_id`], revision = operation[`${side}_profile_revision`];
      ensure(id === null ? revision === null : profiles.has(String(id)) && profiles.get(String(id))!.configuration_revision === revision, "operation profile revision");
    }
    if (operation.source_profile_id !== null) ensure(profiles.get(String(operation.source_profile_id))!.adapter_type === operation.source_provider, "operation source namespace");
    ensure((operation.source_expected_sha256 === null || hash(operation.source_expected_sha256))
      && (operation.source_expected_byte_size === null || size(operation.source_expected_byte_size)), "operation byte expectation");
    if (operation.status === "cancelled") ensure([...attempts.values()].filter((attempt) => attempt.operation_id === operation.id)
      .every((attempt) => ["failed", "cancelled"].includes(String(attempt.state)) && attempt.write_started_at === null && attempt.verified_at === null), "cancelled operation crossed provider write boundary");
    const decision = decisions.get(String(operation.occurrence_id));
    if (["resolved", "admitted_unresolved"].includes(String(operation.status))) ensure(decision?.operation_id === operation.id && decision.decision === operation.status, "terminal operation decision");
  }
  const attemptNumbers = new Map<string, number[]>(), activeOperations = new Set<string>(), candidates = new Set<string>();
  for (const attempt of attempts.values()) {
    const operation = operations.get(String(attempt.operation_id));
    ensure(operation && size(attempt.attempt_number) && attempt.attempt_number > 0 && text(attempt.owner_token) && text(attempt.runtime_incarnation)
      && time(attempt.created_at) && time(attempt.lease_expires_at) && Date.parse(attempt.lease_expires_at) > Date.parse(attempt.created_at)
      && ["staged", "write_started", "unknown", "verified", "published", "failed", "cancelled"].includes(String(attempt.state)), "attempt ownership/state");
    const numbers = attemptNumbers.get(String(operation.id)) ?? []; numbers.push(attempt.attempt_number); attemptNumbers.set(String(operation.id), numbers);
    if (["staged", "write_started", "unknown", "verified"].includes(String(attempt.state))) {
      ensure(!activeOperations.has(String(operation.id)), "competing active attempts"); activeOperations.add(String(operation.id));
    }
    if (attempt.candidate_file_id === null) ensure([attempt.candidate_location_id, attempt.candidate_object_key, attempt.verified_byte_size,
      attempt.verified_sha256, attempt.source_verified_at].every((value) => value === null), "partial candidate identity");
    else {
      const file = graph.files.get(String(attempt.candidate_file_id)), location = graph.locations.get(String(attempt.candidate_location_id));
      ensure(file && location && location.file_id === file.id && location.storage_profile_id === operation.destination_profile_id
        && location.object_key === attempt.candidate_object_key && file.purpose === operation.purpose && file.access_scope === operation.access_scope
        && hash(attempt.verified_sha256) && size(attempt.verified_byte_size) && time(attempt.source_verified_at)
        && file.expected_sha256 === attempt.verified_sha256 && file.expected_byte_size === attempt.verified_byte_size
        && operation.source_expected_sha256 === attempt.verified_sha256 && operation.source_expected_byte_size === attempt.verified_byte_size
        && !candidates.has(String(location.id)), "candidate/operation byte identity"); candidates.add(String(location.id));
    }
    if (["write_started", "unknown", "verified", "published"].includes(String(attempt.state))) ensure(attempt.candidate_file_id !== null && time(attempt.write_started_at), "attempt write evidence");
    if (["verified", "published"].includes(String(attempt.state))) ensure(time(attempt.verified_at), "attempt destination verification");
    if (["published", "failed", "cancelled"].includes(String(attempt.state))) ensure(time(attempt.completed_at), "terminal attempt completion");
    if (attempt.state === "published") ensure(graph.publications.get(String(attempt.candidate_location_id))?.verification_operation_id === operation.id
      && decisions.get(String(operation.occurrence_id))?.file_id === attempt.candidate_file_id, "published attempt receipt");
  }
  for (const values of attemptNumbers.values()) ensure(values.sort((a, b) => a - b).every((value, index) => value === index + 1), "attempt sequence history");
  for (const publication of graph.publications.values()) {
    const operation = operations.get(String(publication.verification_operation_id));
    ensure(operation && operation.status === "resolved" && [...attempts.values()].some((attempt) =>
      attempt.operation_id === operation.id && attempt.state === "published" && attempt.candidate_location_id === publication.location_id
      && attempt.candidate_file_id === publication.file_id && attempt.verified_sha256 === publication.verified_sha256
      && attempt.verified_byte_size === publication.verified_byte_size), "publication requires durable shadow verification");
  }
  const decidedOperations = new Set<string>();
  for (const decision of decisions.values()) {
    const operation = operations.get(String(decision.operation_id));
    ensure(operation && operation.occurrence_id === decision.occurrence_id && operation.baseline_sha256 === decision.baseline_sha256
      && operation.status === decision.decision && !decidedOperations.has(String(operation.id)) && text(decision.decided_by)
      && time(decision.decided_at), "decision/frozen operation"); decidedOperations.add(String(operation.id));
    if (decision.decision === "resolved") {
      const file = graph.filePublications.get(String(decision.file_id)), location = graph.publications.get(String(decision.location_id));
      const occurrence = occurrences.get(String(decision.occurrence_id))!;
      const kind = String(occurrence.consumer_kind), slot = String(occurrence.file_slot);
      const requiredPurpose = ["state_representation_asset", "run_step_asset", "run_step_comment", "state_verification"].includes(kind)
        || kind === "event" && slot === "primary" ? "embedded_content"
        : ["metrology_template_reference", "project_content_attachment"].includes(kind) ? "research_source"
          : ["import", "template_version"].includes(kind) ? "provenance"
            : kind === "attachment_derivative" || kind === "event" && slot === "thumbnail" ? "derived_preview" : occurrence.expected_purpose;
      ensure(requiredPurpose && file?.purpose === requiredPurpose, "decision purpose matches business slot");
      if (requiredPurpose === "derived_preview") {
        const evidence = JSON.parse(String(occurrence.source_json));
        ensure(rows(tables, "file_derivations").some((derivation) => {
          if (derivation.derived_file_id !== decision.file_id || derivation.trust_state !== "verified") return false;
          const source = graph.filePublications.get(String(derivation.source_file_id));
          if (!source) return false;
          if (kind === "attachment_derivative") return derivation.generator === evidence.derivative_kind
            && derivation.generator_version === evidence.generator_version && derivation.source_verified_sha256 === evidence.source_sha256
            && source.verified_byte_size === evidence.source_byte_size;
          // Bind to the original related consumer's immutable decision history.
          // Its live head may have advanced since this preview was published.
          const relatedKind = kind === "event" ? "event" : "comment_submission_item";
          const relatedId = kind === "event" ? occurrence.consumer_id : evidence.related_item_id;
          return [...decisions.values()].some((related) => {
            const owner = occurrences.get(String(related.occurrence_id));
            return related.decision === "resolved" && related.file_id === derivation.source_file_id && owner?.consumer_kind === relatedKind
              && owner.consumer_id === relatedId && owner.consumer_sub_id === "" && owner.file_slot === "primary";
          });
        }), "resolved preview requires its exact verified derivation source");
      }
      ensure(file && location && location.file_id === decision.file_id && location.storage_profile_id === operation.destination_profile_id
        && file.purpose === operation.purpose && file.access_scope === operation.access_scope && decision.reason === null,
      "resolved decision publication");
    } else ensure(decision.decision === "admitted_unresolved" && decision.file_id === null && decision.location_id === null && text(decision.reason), "admitted unresolved decision");
  }
  indexed(rows(tables, "file_shadow_legacy_holds"), "id", "legacy hold");
  for (const hold of rows(tables, "file_shadow_legacy_holds")) {
    const operation = operations.get(String(hold.operation_id));
    ensure(operation && hold.store_kind === operation.source_store_kind && hold.provider === operation.source_provider
      && hold.object_key === operation.source_object_key && hold.storage_profile_id === operation.source_profile_id
      && hold.profile_revision === operation.source_profile_revision && time(hold.acquired_at)
      && (hold.released_at === null || time(hold.released_at) && operation.status !== "pending"
        && ![...attempts.values()].some((attempt) => attempt.operation_id === operation.id
          && ["staged", "write_started", "unknown", "verified"].includes(String(attempt.state)))), "legacy source hold identity");
  }
  indexed(rows(tables, "file_shadow_reconciliations"), "id", "reconciliation");
  for (const reconciliation of rows(tables, "file_shadow_reconciliations")) {
    const attempt = attempts.get(String(reconciliation.attempt_id));
    ensure(attempt && size(reconciliation.verified_epoch) && reconciliation.verified_epoch <= Number(epoch)
      && text(reconciliation.runtime_incarnation) && reconciliation.verified_sha256 === attempt.verified_sha256
      && reconciliation.verified_byte_size === attempt.verified_byte_size && time(reconciliation.source_verified_at)
      && time(reconciliation.destination_verified_at) && text(reconciliation.created_by) && time(reconciliation.created_at), "reconciliation evidence");
  }
  const legacyClaims = new Set<string>();
  for (const claim of rows(tables, "file_shadow_legacy_deletion_claims")) {
    const key = stableJson([claim.store_kind, claim.provider, claim.object_key]);
    ensure((claim.store_kind === "r2" && claim.provider === "r2" || claim.store_kind === "managed" && claim.provider === "switchdrive")
      && text(claim.object_key) && ["deleting", "deleted"].includes(String(claim.first_state)) && time(claim.observed_at)
      && (claim.operation_id === null || text(claim.operation_id)) && !legacyClaims.has(key), "permanent legacy deletion claim");
    legacyClaims.add(key);
  }
  for (const entry of rows(tables, "blob_gc_ledger")) if (["deleting", "deleted"].includes(String(entry.state))) ensure(
    legacyClaims.has(stableJson([entry.store_kind, entry.provider, entry.object_key])), "missing permanent legacy deletion claim");
  indexed(rows(tables, "file_shadow_checkpoints"), "id", "checkpoint");
  for (const checkpoint of rows(tables, "file_shadow_checkpoints")) ensure(size(checkpoint.captured_epoch) && checkpoint.captured_epoch <= Number(epoch)
    && [checkpoint.current_count, checkpoint.resolved_count, checkpoint.unresolved_count, checkpoint.pending_count].every(size)
    && checkpoint.current_count === Number(checkpoint.resolved_count) + Number(checkpoint.unresolved_count) + Number(checkpoint.pending_count)
    && text(checkpoint.captured_by) && time(checkpoint.captured_at), "checkpoint counts");
}
