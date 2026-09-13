import { FULL_EXPORT_ARCHIVE_SCHEMA, FULL_EXPORT_ARCHIVE_SCHEMA_V8, FULL_EXPORT_ARCHIVE_SCHEMA_V9, FULL_EXPORT_ARCHIVE_PROFILE, FULL_EXPORT_ARCHIVE_PROFILE_V9, FULL_EXPORT_ARCHIVE_WRITER, type ExportJsonArtifact, type FullExportManifestV8, type FullExportManifestV9, type FullExportManifestV10 } from "./export";
import { sha256Hex, stableJson } from "../domain/content-addressing";
import { classifyExportCompatibilitySchema, exportCompatibilityColumns, projectCompatibilitySnapshot, restoreCompatibilityRows } from "./export-compatibility";
import { buildBlobExportPlan } from "./export-blob-plan";
import { FILE_FOUNDATION_EXPORT_COLUMNS, validateLegacyOverlap } from "./export-file-foundation";
import { IMPORT_ACCEPTANCE_EXPORT_COLUMNS, validateImportAcceptance } from "./export-import-acceptance";
import { sqliteTableColumns } from "../domain/sqlite-table-columns";

export const EXPORT_SOURCE_SCHEMA_PATH = "provenance/source-schema.json";
export const EXPORT_RETIRED_FIELDS_PATH = "provenance/retired-fields.json";

export function exportArtifactText(value: unknown) {
  return `${stableJson(value)}\n`;
}

export async function createExportArtifact<T>(path: string, value: T): Promise<ExportJsonArtifact<T>> {
  const content = exportArtifactText(value);
  return { path, byteSize: new TextEncoder().encode(content).byteLength, sha256: await sha256Hex(content), value };
}

export function supportedExportRequest(url: URL) {
  const entries = [...url.searchParams];
  return entries.length === 2
    && url.searchParams.getAll("archiveSchema").length === 1
    && url.searchParams.getAll("archiveWriter").length === 1
    && [String(FULL_EXPORT_ARCHIVE_SCHEMA_V8), String(FULL_EXPORT_ARCHIVE_SCHEMA_V9), String(FULL_EXPORT_ARCHIVE_SCHEMA)].includes(url.searchParams.get("archiveSchema") ?? "")
    && url.searchParams.get("archiveWriter") === String(FULL_EXPORT_ARCHIVE_WRITER);
}

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Full export rejected: ${message}`);
}
function object(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function validateFullExport(value: unknown, version: 8 | 9 | 10): Promise<FullExportManifestV8 | FullExportManifestV9 | FullExportManifestV10> {
  // In particular an E client reaching the previous A Worker must stop here,
  // before downloading any bytes or creating a ZIP from an unnegotiated v7.
  ensure(object(value) && value.schemaVersion === version && value.archiveWriter === FULL_EXPORT_ARCHIVE_WRITER,
    "the server and archive writer versions differ. Refresh and try again.");
  ensure(typeof value.exportedAt === "string" && Number.isFinite(Date.parse(value.exportedAt)) && object(value.tables)
    && Array.isArray(value.blobs) && object(value.artifacts), "incomplete snapshot envelope");
  ensure(Object.keys(value.artifacts).sort().join(",") === "retiredFields,sourceSchema", "unknown or missing provenance artifacts");
  for (const [name, path] of [["sourceSchema", EXPORT_SOURCE_SCHEMA_PATH], ["retiredFields", EXPORT_RETIRED_FIELDS_PATH]] as const) {
    const artifact = value.artifacts[name];
    ensure(object(artifact) && artifact.path === path && Number.isSafeInteger(artifact.byteSize) && artifact.byteSize >= 0
      && typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256) && object(artifact.value), `invalid ${name} artifact`);
    const encoded = await createExportArtifact(path, artifact.value);
    ensure(encoded.byteSize === artifact.byteSize && encoded.sha256 === artifact.sha256, `${name} artifact hash or size mismatch`);
  }
  const schema = value.artifacts.sourceSchema.value;
  ensure(schema.version === 1 && schema.kind === "observed-sqlite-schema" && Array.isArray(schema.objects)
    && object(schema.compatibilityColumns) && Array.isArray(schema.compatibilityColumns.samples)
    && Array.isArray(schema.compatibilityColumns.run_step_comments), "missing observed physical schema");
  const objectIds = new Set<string>();
  for (const entry of schema.objects) {
    ensure(object(entry) && ["table", "view", "index", "trigger"].includes(entry.type) && typeof entry.name === "string"
      && entry.name.length > 0 && typeof entry.tableName === "string" && entry.tableName.length > 0
      && (typeof entry.sql === "string" || entry.type === "index" && entry.sql === null), "invalid observed schema object");
    ensure(!["table", "view"].includes(entry.type) || entry.tableName === entry.name, "invalid observed schema object ownership");
    const key = `${entry.type}:${entry.name}`;
    ensure(!objectIds.has(key), "duplicate observed schema object");
    objectIds.add(key);
  }
  ensure(objectIds.has("table:samples") && objectIds.has("table:run_step_comments"), "observed schema is missing compatibility tables");
  for (const name of ["samples", "run_step_comments"] as const) {
    const entry = schema.objects.find((entry: { type: string; name: string }) => entry.type === "table" && entry.name === name);
    ensure(entry.tableName === name && typeof entry.sql === "string"
      && JSON.stringify(sqliteTableColumns(entry.sql, name)) === JSON.stringify(schema.compatibilityColumns[name]),
    "physical schema columns disagree with recorded SQL");
  }
  const platform = new Set(["d1_migrations", "_cf_KV", "_cf_METADATA"]);
  const inventory = schema.objects.filter((entry: { type: string; name: string }) => entry.type === "table"
    && !entry.name.startsWith("sqlite_") && !platform.has(entry.name)).map((entry: { name: string }) => entry.name);
  ensure(objectIds.has("view:blob_retention_edges"), "source schema is missing its exported retention view");
  inventory.push("blob_retention_edges");
  ensure(JSON.stringify([...inventory].sort()) === JSON.stringify(Object.keys(value.tables).sort()), "table inventory differs from observed source schema");
  const importsSchema = schema.objects.find((entry: { type: string; name: string }) => entry.type === "table" && entry.name === "imports");
  ensure(importsSchema && typeof importsSchema.sql === "string", "missing imports schema");
  const importColumns = sqliteTableColumns(importsSchema.sql, "imports");
  if (version < 10) ensure(!IMPORT_ACCEPTANCE_EXPORT_COLUMNS.some((column) => importColumns.includes(column)),
    "import acceptance requires archive schema 10");
  else ensure(JSON.stringify([...importColumns].sort()) === JSON.stringify([
    "id", "status", "source_filename", "source_sha256", "sheet_name", "template_type", "recipe_family_id",
    "template_version_id", "workbook_asset_key", "manifest_asset_key", "warning_count", "error_message", "actor_email",
    "created_at", "completed_at", "operation_id", "lease_expires_at", "finalization_id", "recovery_operation_id",
    ...IMPORT_ACCEPTANCE_EXPORT_COLUMNS,
  ].sort()), "import acceptance schema columns differ from the archive profile");
  const logicalColumns = exportCompatibilityColumns("S2");
  const retentionColumns = ["store_kind", "provider", "object_key", "blob_record_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"];
  for (const [name, rows] of Object.entries(value.tables)) {
    ensure(/^[a-z][a-z0-9_]*$/.test(name) && Array.isArray(rows), "invalid snapshot table inventory");
    const entry = schema.objects.find((entry: { type: string; name: string }) => entry.type === "table" && entry.name === name);
    const columns = name === "samples" ? logicalColumns.samples : name === "run_step_comments" ? logicalColumns.run_step_comments
      : name === "blob_retention_edges" ? retentionColumns : sqliteTableColumns(entry.sql, name);
    for (const row of rows) {
      ensure(object(row) && (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && Reflect.ownKeys(row).length === Object.keys(row).length
      && Object.values(row).every((cell) => cell === null || typeof cell === "string"
        || typeof cell === "number" && Number.isFinite(cell) && (!Number.isInteger(cell) || Number.isSafeInteger(cell))),
      "table rows contain unsupported values");
      ensure(JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...columns].sort()), "table row columns differ from source contract");
    }
  }
  const manifest = value as FullExportManifestV8 | FullExportManifestV9 | FullExportManifestV10;
  const physical = classifyExportCompatibilitySchema(manifest.artifacts.sourceSchema.value.compatibilityColumns);
  const restored = restoreCompatibilityRows(manifest.tables, manifest.artifacts.retiredFields.value, physical);
  const replayed = projectCompatibilitySnapshot(restored, manifest.artifacts.sourceSchema.value);
  ensure(stableJson(replayed.tables) === stableJson(manifest.tables)
    && stableJson(replayed.retiredFields) === stableJson(manifest.artifacts.retiredFields.value), "logical rows and provenance describe different snapshots");
  // The wire catalog includes download decisions. Require every locator and its
  // metadata to match this snapshot before a writer makes any network request.
  // Compare occurrence sets without host-locale ordering differences; retain
  // the original planner order in the archive for schema-7 compatibility.
  const normalizedPlan = (entries: unknown[]) => entries.map((entry) => {
    ensure(object(entry) && Array.isArray(entry.sourceOccurrences), "invalid snapshot blob catalog");
    return { ...entry, sourceOccurrences: entry.sourceOccurrences.map(stableJson).sort() };
  }).map(stableJson).sort();
  ensure(stableJson(normalizedPlan(manifest.blobs)) === stableJson(normalizedPlan(buildBlobExportPlan(manifest.tables))),
    "blob catalog differs from snapshot tables");
  const registryTables = ["storage_profiles", "files", "file_locations", "legacy_file_mappings"];
  if (version === 8) ensure(!registryTables.some((name) => Object.hasOwn(manifest.tables, name)),
    "the file foundation requires archive schema 9");
  else {
    ensure((manifest as FullExportManifestV9 | FullExportManifestV10).archiveProfile === (version === 9 ? FULL_EXPORT_ARCHIVE_PROFILE_V9 : FULL_EXPORT_ARCHIVE_PROFILE),
      "unsupported archive schema profile");
    ensure(physical === "S2" && registryTables.every((name) => Object.hasOwn(manifest.tables, name)),
      "the file foundation requires the complete S2 registry schema");
    for (const [name, columns] of Object.entries(FILE_FOUNDATION_EXPORT_COLUMNS)) {
      const entry = schema.objects.find((entry: { type: string; name: string }) => entry.type === "table" && entry.name === name);
      ensure(JSON.stringify(sqliteTableColumns(entry.sql, name).sort()) === JSON.stringify([...columns].sort()),
        "file foundation schema columns differ from the archive profile");
    }
    validateLegacyOverlap(manifest.tables);
    if (version === 10) await validateImportAcceptance(manifest.tables);
  }
  return manifest;
}

export async function validateFullExportV8(value: unknown): Promise<FullExportManifestV8> {
  return await validateFullExport(value, FULL_EXPORT_ARCHIVE_SCHEMA_V8) as FullExportManifestV8;
}

export async function validateFullExportV9(value: unknown): Promise<FullExportManifestV9> {
  return await validateFullExport(value, FULL_EXPORT_ARCHIVE_SCHEMA_V9) as FullExportManifestV9;
}

export async function validateFullExportV10(value: unknown): Promise<FullExportManifestV10> {
  return await validateFullExport(value, FULL_EXPORT_ARCHIVE_SCHEMA) as FullExportManifestV10;
}
