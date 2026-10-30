// Separate V26 research-only rehearsal. Old V7–V25 readers remain distinct.
import { validateFullExportV26, portableBusinessSchemaV26, PORTABLE_RUNTIME_SOURCE_CHECKPOINT_PATH } from "../../shared/contracts/export-portable-runtime-v26";
import { WORKER_SCHEDULER_MIGRATION_NAME, WORKER_SCHEDULER_MIGRATION_SHA256 } from "../../shared/contracts/worker-scheduler-schema-extension";
import { V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256, PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS, PORTABLE_RUNTIME_RECOVERY_TABLES } from "../../shared/contracts/portable-runtime-v26-recovery-catalog";
import { PORTABLE_RUNTIME_SCHEMA_STATEMENTS, PORTABLE_RUNTIME_SEED_TABLE_ROWS } from "../../worker/recovery/portable-runtime-v26-trusted-schema";
import { recoveryCellBinding } from "../../shared/contracts/system-recovery-image";
import { buildSystemRecoveryBlobExportPlan } from "../../shared/contracts/export-system-recovery";
import { RESEARCH_PACKAGE_LOCAL_TABLE_NAMES } from "../../shared/contracts/export-research-package-schema";
import { FILE_JOBS_LOCAL_TABLE_NAMES } from "../../shared/contracts/export-file-jobs-schema";
import { FILE_AUTHORITY_RUNTIME_LOCAL_TABLE_NAMES } from "../../shared/contracts/export-file-runtime";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32 } from "node:zlib";
import JSZip from "jszip";
import type { CompatibilitySchema, ExportSchemaObject, FileShadowSourceRowids, RetiredExportFields } from "../../shared/contracts/export";
import { classifyExportCompatibilitySchema, restoreCompatibilityRows } from "../../shared/contracts/export-compatibility";
import { EXPORT_RETIRED_FIELDS_PATH, EXPORT_SOURCE_SCHEMA_PATH } from "../../shared/contracts/export-protocol";
import { fileShadowArchiveColumn, isFileShadowRowidColumn } from "../../shared/contracts/file-shadow-rowid";
import { FILE_AUTHORITY_REBUILDABLE_TABLE_NAMES, FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL } from "../../shared/contracts/export-file-authority";
import { FILE_SHADOW_HEAD_INTEGRITY_SQL, FILE_SHADOW_EXPORTED_VIEWS, FILE_SHADOW_REBUILDABLE_TABLE_NAMES, FILE_SHADOW_SOURCE_ROWIDS_PATH, fileShadowSchemaFingerprint } from "../../shared/contracts/export-file-shadow";

type Row = Record<string, string | number | null>;
const EXPORTED_VIEWS = [...new Set([
  "blob_retention_edges",
  "file_consumer_relational_projection",
  "file_consumer_content_projection",
  "file_consumer_direct_projection",
  "file_consumer_projection",
  "file_relational_retention_edges",
  "file_content_retention_edges",
  "file_direct_retention_edges",
  "file_retention_edges",
  "file_location_retention_edges",
  "file_location_availability",
  ...FILE_SHADOW_EXPORTED_VIEWS,
])];
const PLATFORM_TABLES = new Set(["d1_migrations", "_cf_KV"]);
const REBUILDABLE_TABLES = new Set<string>([...FILE_AUTHORITY_REBUILDABLE_TABLE_NAMES, ...FILE_SHADOW_REBUILDABLE_TABLE_NAMES,
  ...FILE_AUTHORITY_RUNTIME_LOCAL_TABLE_NAMES, ...FILE_JOBS_LOCAL_TABLE_NAMES, ...RESEARCH_PACKAGE_LOCAL_TABLE_NAMES]);
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const OUTCOMES = new Set(["packaged", "missing", "provider_unavailable", "metadata_not_ready", "download_failed", "size_mismatch", "hash_mismatch"]);

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function hash(bytes: string | Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sameRows(left: Row[], right: Row[]) {
  return canonical(left.map(canonical).sort()) === canonical(right.map(canonical).sort());
}
function identifier(name: string) { return `"${name.replaceAll('"', '""')}"`; }
function safeArchivePath(path: unknown): asserts path is string {
  ensure(typeof path === "string" && path.length > 0 && !/[\\\u0000:]/.test(path)
    && path.split("/").every((part) => part && part !== "." && part !== ".."), "Unsafe archive path");
}

// JSZip intentionally accepts duplicate ZIP member names. Reject them before
// parsing so a shadowed table/manifest cannot silently replace an earlier one.
function checkZipDirectory(bytes: Buffer) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  ensure(end >= 0, "ZIP end directory is missing");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const size = bytes.readUInt32LE(end + 12);
  ensure(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0
    && count === bytes.readUInt16LE(end + 8) && count < 65535
    && size < 0xffffffff && offset + size === end, "Only ordinary single-volume ZIP archives are supported");
  const names = new Set<string>();
  const members = new Map<string, { size: number; checksum: number }>();
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    ensure(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, "Invalid ZIP central directory");
    const length = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    ensure(next <= end, "Invalid ZIP member length");
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString("utf8");
    safeArchivePath(name.endsWith("/") ? name.slice(0, -1) : name);
    ensure(!names.has(name), "Duplicate ZIP member name");
    names.add(name);
    const unpacked = bytes.readUInt32LE(offset + 24);
    members.set(name, { size: unpacked, checksum: bytes.readUInt32LE(offset + 16) });
    expanded += unpacked;
    ensure(unpacked <= MAX_ENTRY_BYTES && expanded <= MAX_EXPANDED_BYTES, "Archive exceeds isolated restore size limits");
    ensure(!(bytes.readUInt16LE(offset + 8) & 1), "Encrypted ZIP entries are unsupported");
    offset = next;
  }
  ensure(offset === end, "ZIP directory count disagrees with its size");
  return members;
}

async function archiveReader(bytes: Buffer) {
  const directory = checkZipDirectory(bytes);
  const zip = await JSZip.loadAsync(bytes);
  ensure(canonical(Object.keys(zip.files).sort()) === canonical([...directory.keys()].sort()),
    "ZIP paths changed or were shadowed while loading");
  for (const file of Object.values(zip.files)) {
    const original = (file as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
    ensure(original === undefined || original === file.name, "ZIP path was normalized while loading");
    safeArchivePath(file.dir ? file.name.slice(0, -1) : file.name);
  }
  let expanded = 0;
  const consumed = new Set<string>();
  async function read(path: string) {
    safeArchivePath(path);
    ensure(!consumed.has(path), "Archive paths must identify exactly one table or blob");
    consumed.add(path);
    const file = zip.file(path);
    ensure(file, `Missing archive entry: ${path}`);
    const chunks: Buffer[] = [];
    let size = 0;
    let checksum = 0;
    await new Promise<void>((accept, reject) => {
      const stream = file.nodeStream("nodebuffer");
      // JSZip uses readable-stream, whose public type omits destroy(). Qualify
      // the cancellation capability actually consumed by this byte budget;
      // its implementation need not inherit Node's core Readable prototype.
      const destroy = "destroy" in stream ? stream.destroy : undefined;
      ensure(typeof destroy === "function", "Archive cancellation unavailable");
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        expanded += chunk.length;
        if (size > MAX_ENTRY_BYTES || expanded > MAX_EXPANDED_BYTES) {
          destroy.call(stream, new Error("Archive exceeds isolated restore size limits"));
          return;
        }
        chunks.push(chunk);
        checksum = crc32(chunk, checksum);
      });
      stream.once("error", reject);
      stream.once("end", accept);
    });
    ensure(directory.get(path)?.size === size && directory.get(path)?.checksum === checksum,
      "ZIP member size or CRC-32 mismatch");
    return Buffer.concat(chunks);
  }
  return {
    read,
    async json(path: string) { return JSON.parse((await read(path)).toString("utf8")); },
    finish() {
      ensure(Object.values(zip.files).filter((file) => !file.dir).every((file) => consumed.has(file.name)),
        "Archive contains entries not declared by its manifest");
    },
  };
}

function schema(database: DatabaseSync) {
  return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type, name")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
}

function ensureJobExecutionSuspended(database: DatabaseSync) {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='file_job_runtime_guard'").get()) return false;
  const rows = database.prepare("SELECT singleton,enabled,incarnation,last_heartbeat_at FROM file_job_runtime_guard").all();
  ensure(rows.length === 1 && rows[0].singleton === 1 && rows[0].enabled === 0
    && rows[0].incarnation === null && rows[0].last_heartbeat_at === null, "Recovered File jobs must remain unadmitted and paused");
  ensure(database.prepare("SELECT COUNT(*) AS count FROM file_job_cleanup_grants").get()?.count === 0,
    "Recovered File jobs must not inherit local cleanup authorization");
  return true;
}

function ensureResearchPackageExecutionSuspended(database: DatabaseSync) {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_package_jobs'").get()) return false;
  ensureJobExecutionSuspended(database);
  ensure(database.prepare("SELECT COUNT(*) AS count FROM system_research_package_cleanup_grants").get()?.count === 0,
    "Recovered research packages must not inherit local cleanup authorization");
  ensure(database.prepare("SELECT COUNT(*) AS count FROM research_package_live_verified_attempts").get()?.count === 0,
    "Recovered package verification must not confer a live execution lease");
  return true;
}

function ensureShadowExecutionSuspended(database: DatabaseSync) {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='file_shadow_runtime_guard'").get()) return false;
  const rows = database.prepare("SELECT singleton, incarnation, enabled FROM file_shadow_runtime_guard").all();
  ensure(rows.length === 1 && rows[0].singleton === 1 && rows[0].incarnation === null && rows[0].enabled === 0,
    "Restored shadow execution must remain suspended");
  ensure(database.prepare("SELECT COUNT(*) AS count FROM file_shadow_runtime_incarnations").get()?.count === 0,
    "Restored shadow runtime incarnation history must be local and empty");
  return true;
}

function ensureAuthorityExecutionSuspended(database: DatabaseSync) {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='file_authority_runtime_guard'").get()) return false;
  const rows = database.prepare("SELECT singleton, incarnation, enabled FROM file_authority_runtime_guard").all();
  ensure(rows.length === 1 && rows[0].singleton === 1 && rows[0].incarnation === null && rows[0].enabled === 0,
    "Restored File authority execution must remain suspended");
  return true;
}

function fileRegistryRowidClaimsInstalled(database: DatabaseSync) {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'file_registry_rowid_claims'").get() !== undefined;
}

function ensureFileRegistryRowidClaims(database: DatabaseSync) {
  if (!fileRegistryRowidClaimsInstalled(database)) return;
  const row = database.prepare(FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL).get() as { invalid_count?: unknown } | undefined;
  ensure(row?.invalid_count === 0, "File registry rowid claims differ from their registry rows");
}

function rebuildFileRegistryRowidClaims(database: DatabaseSync) {
  if (!fileRegistryRowidClaimsInstalled(database)) return false;
  database.exec(`
    DELETE FROM file_registry_rowid_claims;
    INSERT INTO file_registry_rowid_claims (registry_name, claimed_rowid)
    SELECT 'storage_profiles', rowid FROM storage_profiles
    UNION ALL SELECT 'files', rowid FROM files
    UNION ALL SELECT 'file_locations', rowid FROM file_locations
    UNION ALL SELECT 'legacy_file_mappings', rowid FROM legacy_file_mappings;
  `);
  ensureFileRegistryRowidClaims(database);
  return true;
}

function inspectProjectRelations(database: DatabaseSync) {
  // These final-state relations have trigger guards rather than complete
  // foreign keys. Historical/deleted rows are valid and remain in the checks.
  const checks = {
    "Project content ownership": `SELECT 1 FROM project_items i JOIN project_contents c ON c.id = i.project_content_id WHERE c.project_id <> i.project_id LIMIT 1`,
    "Active Project placement": `SELECT 1 FROM project_items i LEFT JOIN project_map_placements p ON p.project_item_id = i.id WHERE i.deleted_at IS NULL AND p.id IS NULL LIMIT 1`,
    "Project edge ownership": `SELECT 1 FROM project_edges e JOIN project_items a ON a.id = e.source_item_id JOIN project_items b ON b.id = e.target_item_id WHERE a.project_id <> e.project_id OR b.project_id <> e.project_id LIMIT 1`,
    "Project sequence watermark": `SELECT 1 FROM projects p JOIN project_items i ON i.project_id = p.id WHERE i.created_sequence >= p.next_created_sequence LIMIT 1`,
    "Project attachment subtype": `SELECT 1 FROM project_content_attachments a JOIN project_contents c ON c.id = a.project_content_id WHERE c.content_type <> 'attachment' LIMIT 1`,
  };
  for (const [name, sql] of Object.entries(checks)) ensure(!database.prepare(sql).get(), `${name} verification failed`);
}

function retentionAt(databasePath: string, inspectionTime: string, view = "blob_retention_edges") {
  const projection = new DatabaseSync(databasePath, { readOnly: true });
  const clock = new DatabaseSync(":memory:");
  try {
    // Override time only on a separate read-only inspection connection. The
    // restored database and its ordinary future writes retain SQLite's clock.
    for (const name of ["datetime", "date", "time", "strftime", "julianday", "unixepoch"]) {
      projection.function(name, { varargs: true }, (...values) => {
        const args = values.length ? values.map((value, index) =>
          value === "now" && (name !== "strftime" || index > 0) ? inspectionTime : value) : [inspectionTime];
        return Object.values(clock.prepare(`SELECT ${name}(${args.map(() => "?").join(",")})`).get(...args)!)[0];
      });
    }
    return projection.prepare(`SELECT * FROM ${identifier(view)}`).all() as Row[];
  } finally {
    projection.close();
    clock.close();
  }
}

function nativeRetentionSnapshotsAt(databasePath: string, inspectionTime: string, views: string[]) {
  const projection = new DatabaseSync(databasePath, { readOnly: true }), clock = new DatabaseSync(":memory:");
  try {
    // Reuse one source-clock inspection connection for the complete successor
    // view inventory, rather than reparsing the full schema for each view.
    for (const name of ["datetime", "date", "time", "strftime", "julianday", "unixepoch"]) {
      projection.function(name, { varargs: true }, (...values) => {
        const args = values.length ? values.map((value, index) =>
          value === "now" && (name !== "strftime" || index > 0) ? inspectionTime : value) : [inspectionTime];
        return Object.values(clock.prepare(`SELECT ${name}(${args.map(() => "?").join(",")})`).get(...args)!)[0];
      });
    }
    return Object.fromEntries(views.map(name => [name, projection.prepare(`SELECT * FROM ${identifier(name)}`).all() as Row[]]));
  } finally { projection.close(); clock.close(); }
}

export async function restoreV26ResearchExportToIsolatedDirectory(options: {
  archivePath: string;
  destination: string;
  migrationsDirectory: string;
  targetCompatibilitySchema?: CompatibilitySchema;
}) {
  const destination = resolve(options.destination);
  // Exclusive creation precedes all writes. Neither an existing directory nor
  // a symlink is accepted, and there is deliberately no force/overwrite mode.
  await mkdir(destination, { mode: 0o700 });
  let database: DatabaseSync | undefined;
  let completed = false;
  try {
    const staging = await mkdtemp(join(destination, ".in-progress-"));
    const inputInfo = await stat(options.archivePath);
    ensure(inputInfo.isFile() && inputInfo.size <= MAX_ARCHIVE_BYTES, "Archive exceeds isolated restore size limits");
    const bytes = await readFile(options.archivePath);
    ensure(bytes.length <= MAX_ARCHIVE_BYTES, "Archive exceeds isolated restore size limits");
    const archive = await archiveReader(bytes);
    const manifest = await archive.json("export-manifest.json");
    const warnings = await archive.json("export-warnings.json");
    ensure(object(manifest) && canonical(Object.keys(manifest).sort()) === canonical(["schemaVersion", "archiveProfile", "archiveWriter", "exportedAt", "tables", "artifacts", "blobs", "excludedOutputs", "relocatedSources", "backupHoldOwner"].sort()) && manifest.schemaVersion === 26 && typeof manifest.exportedAt === "string"
      && Number.isFinite(Date.parse(manifest.exportedAt)) && object(manifest.tables)
      && Array.isArray(manifest.blobs) && Array.isArray(warnings), "Unsupported complete-export manifest");

    database = new DatabaseSync(join(staging, "database.sqlite"), { allowExtension: false, enableForeignKeyConstraints: true });
    const entries = await readdir(options.migrationsDirectory, { withFileTypes: true });
    if (entries.some(entry => entry.name === WORKER_SCHEDULER_MIGRATION_NAME)) ensure(hash(await readFile(join(options.migrationsDirectory, WORKER_SCHEDULER_MIGRATION_NAME)))
      === WORKER_SCHEDULER_MIGRATION_SHA256, "Unreviewed Worker scheduler successor migration");
    ensure(entries.every(entry => entry.isFile()) && canonical(entries.filter(entry => entry.name !== "README.md"
      && entry.name !== WORKER_SCHEDULER_MIGRATION_NAME).map(entry => entry.name).sort())
      === canonical(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.map(entry => entry.name)), "Unreviewed V26 migration inventory");
    const migrations: Array<{ name: string; sha256: string }> = [];
    for (const receipt of PORTABLE_RUNTIME_RECOVERY_MIGRATIONS) {
      ensure(hash(await readFile(join(options.migrationsDirectory, receipt.name))) === receipt.sha256, "Unreviewed V26 raw migration digest");
      migrations.push({ name: receipt.name, sha256: receipt.sha256 });
    }
    // Target DDL is the reviewed V26 business projection. Neither archived SQL
    // nor an uploaded migration is executed, and protected/local installation
    // tables are not created for this research-only rehearsal.
    const targetObjects = portableBusinessSchemaV26([...PORTABLE_RUNTIME_SCHEMA_STATEMENTS, ...PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS]);
    const targetNames = new Set(targetObjects.filter(object => object.type === "table").map(object => object.name));
    for (const type of ["table", "index", "view"] as const)
      for (const entry of targetObjects.filter(object => object.type === type && object.sql !== null)) database.exec(entry.sql!);
    for (const spec of PORTABLE_RUNTIME_RECOVERY_TABLES.filter(spec => targetNames.has(spec.name) && REBUILDABLE_TABLES.has(spec.name) && spec.name !== "file_registry_rowid_claims")) {
      for (const row of PORTABLE_RUNTIME_SEED_TABLE_ROWS[spec.name].rows) {
        const cells = row.cells.map(recoveryCellBinding), columns = [...spec.columns];
        if (!spec.withoutRowid) { columns.unshift("rowid"); cells.unshift({ expression: "CAST(? AS INTEGER)", value: row.rowid }); }
        database.prepare(`INSERT INTO ${identifier(spec.name)} (${columns.map(identifier).join(",")}) VALUES(${cells.map(cell => cell.expression).join(",")})`)
          .run(...cells.map(cell => cell.value));
      }
    }
    for (const entry of targetObjects.filter(object => object.type === "trigger")) database.exec(entry.sql!);
    const expectedSchema = schema(database);
    let derivedTablesRebuilt = false;
    const observed = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[];
    ensure(await fileShadowSchemaFingerprint(observed) === V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256, "Unreviewed V26 business target DDL");
    const tableNames = expectedSchema.filter((entry) => entry.type === "table"
      && !PLATFORM_TABLES.has(entry.name) && !REBUILDABLE_TABLES.has(entry.name)).map((entry) => entry.name);
    const schemaViewNames = new Set(expectedSchema.filter((entry) => entry.type === "view").map((entry) => entry.name));
    const exportedViews = EXPORTED_VIEWS.filter((name) => schemaViewNames.has(name));
    const catalog = [...tableNames, ...exportedViews].sort();
    ensure(canonical(Object.keys(manifest.tables).sort()) === canonical(catalog), "Archive table catalog differs from the current local schema");
    const observedColumns = (name: string) => (database!.prepare(`PRAGMA table_xinfo(${identifier(name)})`).all() as Array<{ name: string }>).map((column) => column.name);
    const compatibilityProfile = "file-authority-v14";
    const targetCompatibilitySchema = classifyExportCompatibilitySchema({
      samples: observedColumns("samples"), run_step_comments: observedColumns("run_step_comments"),
    }, compatibilityProfile);
    ensure(options.targetCompatibilitySchema === undefined || options.targetCompatibilitySchema === targetCompatibilitySchema,
      "Requested compatibility target differs from the reviewed migration schema");
    ensure(options.targetCompatibilitySchema !== undefined,
      "An explicit compatibility target is required for this archive or schema");
    let tables: Record<string, Row[]> = {};
    for (const name of catalog) {
      const descriptor = manifest.tables[name];
      ensure(object(descriptor) && canonical(Object.keys(descriptor).sort()) === canonical(["rowCount", "path", "byteSize", "sha256"].sort()) && descriptor.path === `tables/${name}.json` && Number.isSafeInteger(descriptor.rowCount) && descriptor.rowCount >= 0, `Invalid table row count: ${name}`);
      const tableBytes = await archive.read(descriptor.path);
      const rows = JSON.parse(tableBytes.toString("utf8"));
      ensure(Array.isArray(rows) && rows.length === descriptor.rowCount, `Table row count mismatch: ${name}`);
      if (manifest.schemaVersion >= 8) ensure(Number.isSafeInteger(descriptor.byteSize) && descriptor.byteSize === tableBytes.length
        && typeof descriptor.sha256 === "string" && descriptor.sha256 === hash(tableBytes), `Table SHA-256 or size mismatch: ${name}`);
      const columns = (database.prepare(`PRAGMA table_info(${identifier(name)})`).all() as Array<{ name: string }>).map((column) => column.name).sort();
      for (const row of rows) {
        ensure(object(row) && (["samples", "run_step_comments"].includes(name) || canonical(Object.keys(row).sort()) === canonical(columns)), `Table column mismatch: ${name}`);
        ensure(Object.values(row).every((value) => value === null || typeof value === "string"
          || typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))), `Invalid table cell: ${name}`);
      }
      tables[name] = rows;
    }

    let retiredFields: RetiredExportFields;
    let sourceRowids: FileShadowSourceRowids | undefined;
    let sourceSnapshotClock: string | undefined;
    const retainedArtifacts: Array<{ path: string; bytes: Buffer }> = [];
      ensure(manifest.archiveWriter === 1 && object(manifest.artifacts), "Unsupported complete-export writer");
      const artifacts: Record<string, any> = {};
      const artifactPaths = [["sourceSchema", EXPORT_SOURCE_SCHEMA_PATH], ["retiredFields", EXPORT_RETIRED_FIELDS_PATH]];
      artifactPaths.push(["sourceRowids", FILE_SHADOW_SOURCE_ROWIDS_PATH]);
      artifactPaths.push(["portableCheckpoint", PORTABLE_RUNTIME_SOURCE_CHECKPOINT_PATH]);
      for (const [name, path] of artifactPaths) {
        const descriptor = manifest.artifacts[name];
        ensure(object(descriptor) && canonical(Object.keys(descriptor).sort()) === canonical(["path", "byteSize", "sha256"].sort()) && descriptor.path === path && Number.isSafeInteger(descriptor.byteSize), `Invalid ${name} artifact descriptor`);
        const artifactBytes = await archive.read(path);
        ensure(artifactBytes.length === descriptor.byteSize && typeof descriptor.sha256 === "string" && hash(artifactBytes) === descriptor.sha256, `${name} artifact SHA-256 or size mismatch`);
        artifacts[name] = { ...descriptor, value: JSON.parse(artifactBytes.toString("utf8")) };
        retainedArtifacts.push({ path, bytes: artifactBytes });
      }
      ensure(Object.keys(manifest.artifacts).sort().join(",") === "portableCheckpoint,retiredFields,sourceRowids,sourceSchema", "Unknown or missing provenance artifacts");
      // Archive entries have final outcomes, while the negotiated wire catalog
      // has download URLs. Validate provenance against a reconstructed wire
      // plan here; the original archived blob catalog and bytes are checked
      // against that same table-derived plan below without dropping entries.
      const validate = validateFullExportV26;
      const validated = await validate({ ...manifest, tables, artifacts, blobs: buildSystemRecoveryBlobExportPlan(tables, artifacts.sourceSchema.value.snapshotClock, manifest.backupHoldOwner).blobs });
      sourceSnapshotClock = artifacts.sourceSchema.value.snapshotClock;
      sourceRowids = validated.artifacts.sourceRowids.value;
      retiredFields = validated.artifacts.retiredFields.value;
      tables = restoreCompatibilityRows(validated.tables, retiredFields, targetCompatibilitySchema, compatibilityProfile);
    // Validate physical target columns after lossless conversion, including
    // empty tables whose retired-family availability is checked above.
    for (const name of catalog) {
      const columns = observedColumns(name).sort();
      for (const row of tables[name]) ensure(canonical(Object.keys(row).sort()) === canonical(columns), `Table column mismatch: ${name}`);
    }
    if (manifest.schemaVersion >= 23) ensure(typeof sourceSnapshotClock === "string", "Research recovery requires its validated source snapshot clock");
    const plan = buildSystemRecoveryBlobExportPlan(tables, sourceSnapshotClock!, manifest.backupHoldOwner).blobs;
    const expectedBlobs = new Map(plan.map((entry) => [entry.locatorId, entry]));
    ensure(manifest.blobs.length === plan.length, "Archive blob catalog differs from exported tables");
    const seen = new Set<string>();
    const providerEntries: Array<Record<string, unknown>> = [];
    const missingHashes: string[] = [];
    const expectedWarnings = new Map<string, Record<string, unknown>>();
    await mkdir(join(staging, "provider-bytes"));
    for (const [index, blob] of manifest.blobs.entries()) {
      ensure(object(blob) && canonical(Object.keys(blob).sort()) === canonical(["locatorId", "storeKind", "provider", "objectKey", "blobRecordIds", "filename", "expectedByteSize", "expectedSha256", "sourceOccurrences", "outcome", "path", "byteAuthority", "storageProfileId", "storageProfileRevision", "locationId"].sort()) && typeof blob.locatorId === "string" && !seen.has(blob.locatorId), "Duplicate or invalid blob locator");
      seen.add(blob.locatorId);
      const expected = expectedBlobs.get(blob.locatorId);
      ensure(expected, "Unknown blob locator");
      for (const field of ["storeKind", "provider", "objectKey", "blobRecordIds", "filename", "expectedByteSize", "expectedSha256", "sourceOccurrences"] as const) {
        // Occurrences form a multiset: source and restoring hosts may have
        // different locale sort orders. Sorting retains duplicate entries, so
        // missing, extra or changed occurrences still fail exact comparison.
        const observed = field === "sourceOccurrences" && Array.isArray(blob[field])
          ? blob[field].map(canonical).sort() : blob[field];
        const recorded = field === "sourceOccurrences" ? expected[field].map(canonical).sort() : expected[field];
        ensure(canonical(observed) === canonical(recorded), `Blob metadata disagrees with table snapshot: ${field}`);
      }
      if (manifest.schemaVersion >= 15) {
        for (const field of ["byteAuthority", "storageProfileId", "storageProfileRevision", "locationId"] as const) {
          ensure(canonical(blob[field]) === canonical((expected as unknown as Record<string, unknown>)[field]), `Shadow blob identity differs: ${field}`);
        }
      }
      ensure(OUTCOMES.has(blob.outcome), "Unknown blob export outcome");
      ensure(expected.initialOutcome === null || blob.outcome === expected.initialOutcome, "Blob outcome disagrees with unavailable metadata");
      let localPath: string | null = null;
      let restoredSha256: string | null = null;
      if (blob.outcome === "packaged") {
        const blobBytes = await archive.read(blob.path);
        ensure(blob.expectedByteSize === null || blobBytes.length === blob.expectedByteSize, "Packaged blob size mismatch");
        restoredSha256 = hash(blobBytes);
        ensure(blob.expectedSha256 === null || restoredSha256 === blob.expectedSha256.toLowerCase(), "Packaged blob SHA-256 mismatch");
        if (blob.expectedSha256 === null) missingHashes.push(blob.locatorId);
        localPath = `provider-bytes/${String(index + 1).padStart(6, "0")}.blob`;
        await writeFile(join(staging, localPath), blobBytes, { flag: "wx", mode: 0o600 });
      } else {
        ensure(blob.path === null, "Unavailable blob must not declare a packaged path");
        expectedWarnings.set(blob.locatorId, blob);
      }
      providerEntries.push({ locatorId: blob.locatorId, storeKind: blob.storeKind, provider: blob.provider,
        objectKey: blob.objectKey, path: localPath, sha256: restoredSha256, outcome: blob.outcome,
        ...(manifest.schemaVersion >= 15 ? { byteAuthority: blob.byteAuthority, storageProfileId: blob.storageProfileId,
          storageProfileRevision: blob.storageProfileRevision, locationId: blob.locationId } : {}) });
    }
    ensure(warnings.length === expectedWarnings.size, "Export warnings disagree with blob outcomes");
    for (const warning of warnings) {
      ensure(object(warning) && canonical(Object.keys(warning).sort()) === canonical(["byteAuthority", "storageProfileId", "storageProfileRevision", "locationId", "code", "locatorId", "blobRecordIds", "sourceOccurrences", "message"].sort()), "Invalid export warning");
      const blob = expectedWarnings.get(warning.locatorId);
      ensure(blob && warning.code === blob.outcome && typeof warning.message === "string"
        && canonical(warning.blobRecordIds) === canonical(blob.blobRecordIds)
        && canonical(warning.sourceOccurrences) === canonical(blob.sourceOccurrences), "Export warning disagrees with its blob");
      if (manifest.schemaVersion >= 15) for (const field of ["byteAuthority", "storageProfileId", "storageProfileRevision", "locationId"] as const) ensure(canonical(warning[field]) === canonical(blob[field]), "Shadow warning identity differs from its blob");
      expectedWarnings.delete(warning.locatorId);
    }
    archive.finish();

    // The only database affected here was just created in our private staging
    // directory. Ordinary write triggers reject valid historical snapshots and
    // migration seeds may have changed since export. Load the exact snapshot
    // atomically, then reinstall the exact original schema before publication.
    const triggers = expectedSchema.filter((entry) => entry.type === "trigger");
    database.exec("PRAGMA defer_foreign_keys = ON; BEGIN IMMEDIATE");
    try {
      for (const trigger of triggers) database.exec(`DROP TRIGGER ${identifier(trigger.name)}`);
      for (const name of tableNames) database.exec(`DELETE FROM ${identifier(name)}`);
      for (const name of tableNames) {
        const rows = tables[name];
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        const physicalRows = sourceRowids?.tables[name];
        const insertColumns = physicalRows ? ["rowid", ...columns] : columns;
        const insert = database.prepare(`INSERT INTO ${identifier(name)} (${insertColumns.map(identifier).join(",")}) VALUES (${insertColumns.map((column) => isFileShadowRowidColumn(name, column) ? "CAST(? AS INTEGER)" : "?").join(",")})`);
        for (const [index, row] of rows.entries()) insert.run(...(physicalRows ? [BigInt(physicalRows[index].rowid)] : []), ...columns.map((column) => row[column]));
      }
      derivedTablesRebuilt = rebuildFileRegistryRowidClaims(database);
      ensureShadowExecutionSuspended(database);
      ensureAuthorityExecutionSuspended(database);
      ensureJobExecutionSuspended(database);
      ensureResearchPackageExecutionSuspended(database);
      for (const trigger of triggers) database.exec(trigger.sql);
      ensure(database.prepare("PRAGMA foreign_key_check").all().length === 0, "Restored database foreign-key check failed");
      ensure(database.prepare("PRAGMA integrity_check").all().every((row) => Object.values(row)[0] === "ok"), "Restored database integrity check failed");
      ensure(canonical(schema(database)) === canonical(expectedSchema), "Restored schema differs from the migrated schema");
      if (sourceRowids) {
        for (const [name, entries] of Object.entries(sourceRowids.tables)) {
          for (const [index, entry] of entries.entries()) {
            const recovered = database.prepare(`SELECT * FROM ${identifier(name)} WHERE rowid=?`).get(BigInt(entry.rowid));
            ensure(recovered && canonical(recovered) === canonical(tables[name][index]), "Restored shadow source rowid differs");
          }
        }
        const proof = database.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).get();
        ensure(proof?.invalid_count === 0, "Restored shadow heads differ from their current physical source rows");
      }
      inspectProjectRelations(database);
      for (const name of tableNames) {
        const columns = Object.keys(tables[name][0] ?? {});
        const projection = columns.some((column) => isFileShadowRowidColumn(name, column))
          ? columns.map((column) => fileShadowArchiveColumn(name, column)).join(", ") : "*";
        ensure(sameRows(database.prepare(`SELECT ${projection} FROM ${identifier(name)}`).all() as Row[], tables[name]), `Restored rows differ: ${name}`);
      }
      database.exec("COMMIT; PRAGMA foreign_keys = ON");
    } catch (error) {
      database.exec("ROLLBACK; PRAGMA foreign_keys = ON");
      throw error;
    }
    ensure(Object.values(database.prepare("PRAGMA foreign_keys").get()!)[0] === 1, "Foreign-key enforcement was not restored");
    if (sourceSnapshotClock) {
      const sourceRetention = nativeRetentionSnapshotsAt(join(staging, "database.sqlite"), sourceSnapshotClock,
        exportedViews.filter(name => name.includes("retention_edges")));
      for (const [name, rows] of Object.entries(sourceRetention)) ensure(sameRows(rows, tables[name]),
        `Restored retention differs at the exact source snapshot clock: ${name}`);
    }
    const currentEdges = database.prepare("SELECT * FROM blob_retention_edges").all() as Row[];
    const now = new Date().toISOString();
    const unmatched = currentEdges.map(canonical);
    const expiredEdges: Row[] = [];
    for (const edge of tables.blob_retention_edges) {
      const found = unmatched.indexOf(canonical(edge));
      if (found >= 0) { unmatched.splice(found, 1); continue; }
      ensure(typeof edge.retain_until === "string" && Number.isFinite(Date.parse(edge.retain_until))
        && database.prepare("SELECT datetime(?) <= datetime(?) AS expired").get(edge.retain_until, now)?.expired === 1,
      "A non-expired retention edge was lost during restore");
      expiredEdges.push(edge);
    }
    ensure(unmatched.length === 0, "Restore introduced retention edges absent from the archive");
    if (expiredEdges.length) {
      // exportedAt is assigned after D1's batch, so it is not the exact clock
      // used by its view SELECT. Prove each expired historical edge against the
      // same canonical rows before expiry; do not pretend that exportedAt can
      // distinguish a legitimate edge expiring during response construction.
      const firstExpiry = expiredEdges.reduce((earliest, edge) => Math.min(earliest, Date.parse(edge.retain_until as string)), Infinity);
      // The view's datetime comparison has second precision, even when the
      // archived retain_until includes milliseconds. Rewind a full second.
      const beforeExpiry = new Date(firstExpiry - 1000).toISOString();
      const candidates = retentionAt(join(staging, "database.sqlite"), beforeExpiry).map(canonical);
      for (const edge of expiredEdges) {
        const found = candidates.indexOf(canonical(edge));
        ensure(found >= 0, "Expired retention edge cannot be reconstructed from canonical rows");
        candidates.splice(found, 1);
      }
    }
    const expiredShadowRetentionEdges: Array<{ view: string; row: Row }> = [];
    for (const name of exportedViews) {
      if (name === "blob_retention_edges") continue;
      if (manifest.schemaVersion >= 15 && name.includes("retention_edges")) {
        const current = (database.prepare(`SELECT * FROM ${identifier(name)}`).all() as Row[]).map(canonical);
        const expired: Row[] = [];
        for (const row of tables[name]) {
          const index = current.indexOf(canonical(row));
          if (index >= 0) { current.splice(index, 1); continue; }
          ensure(typeof row.retain_until === "string" && Number.isFinite(Date.parse(row.retain_until)) && Date.parse(row.retain_until) <= Date.parse(now), `A non-expired shadow retention edge was lost: ${name}`);
          expired.push(row);
        }
        ensure(current.length === 0, `Restore introduced shadow retention edges: ${name}`);
        if (expired.length) {
          const inspectionTime = new Date(Math.min(...expired.map((row) => Date.parse(String(row.retain_until)))) - 1000).toISOString();
          const candidates = retentionAt(join(staging, "database.sqlite"), inspectionTime, name).map(canonical);
          for (const row of expired) {
            const index = candidates.indexOf(canonical(row));
            ensure(index >= 0, `Expired shadow retention edge cannot be reconstructed: ${name}`); candidates.splice(index, 1);
            expiredShadowRetentionEdges.push({ view: name, row });
          }
        }
        continue;
      }
      ensure(sameRows(database.prepare(`SELECT * FROM ${identifier(name)}`).all() as Row[], tables[name]),
        `Restored projection differs: ${name}`);
    }
    const authorityExecutionSuspended = ensureAuthorityExecutionSuspended(database);
    const jobExecutionSuspended = ensureJobExecutionSuspended(database);
    const researchPackageExecutionSuspended = ensureResearchPackageExecutionSuspended(database);
    const report = {
      kind: "isolated-v26-research-export-rehearsal", schemaVersion: manifest.schemaVersion,
      targetCompatibilitySchema,
      installationAuthority: { protectedIdentityIncluded: false, localProfileHistoryIncluded: false, localBindingsInstalled: false, runtimeAdmissionIssued: false },
      archiveProfile: manifest.schemaVersion >= 9 ? manifest.archiveProfile : null,
      appliedForwardMigrations: [],
      originalArchivePath: "original-archive.zip",
      retainedArtifactPaths: retainedArtifacts.map((artifact) => artifact.path),
      sourceSchemaEvidence: manifest.schemaVersion >= 8 ? "observed-in-source-snapshot" : "unavailable-in-v7",
      archivedAt: manifest.exportedAt, verifiedAt: now, archiveSha256: hash(bytes),
      migrationsSha256: hash(canonical(migrations)), migrations,
      schemaSha256: hash(canonical(expectedSchema)), tableCount: tableNames.length,
      restoredTableCount: expectedSchema.filter((entry) => entry.type === "table" && !PLATFORM_TABLES.has(entry.name)).length,
      rowCount: tableNames.reduce((count, name) => count + tables[name].length, 0),
      restoredBlobCount: providerEntries.filter((entry) => entry.path !== null).length,
      databasePath: "database.sqlite", providerManifestPath: "provider-manifest.json",
      warnings, packagedWithoutRecordedHash: missingHashes, expiredRetentionEdges: expiredEdges,
      ...(manifest.schemaVersion >= 23 ? { excludedResearchPackageOutputs: manifest.excludedOutputs } : {}),
      ...(manifest.schemaVersion >= 24 ? { recoveredFileEvidence: { recordedHistoryPreserved: true, providerIO: false, executionResumed: false } } : {}),
      ...(researchPackageExecutionSuspended ? { researchPackageRecovery: {
        providerIO: false, runtimeExecutionEnabled: false, unfinishedJobsResumed: false,
        recordedHistoryPreserved: true, explicitNewIncarnationRequired: true,
        installationAdmissionRequired: true, actorReauthorizationRequired: true,
        cleanupRequiresFreshLocalApproval: true,
      } } : {}),
      ...(jobExecutionSuspended ? { jobRecovery: { providerIO: false, runtimeExecutionEnabled: false,
        unfinishedJobsResumed: false, recordedHistoryPreserved: true, explicitNewIncarnationRequired: true, administratorReauthorizationRequired: true,
        unfinishedJobsRequireExplicitResume: true, cleanupRequiresFreshLocalApproval: true } } : {}),
      ...(authorityExecutionSuspended ? { authorityRecovery: { providerIO: false, runtimeExecutionEnabled: false,
        unfinishedOperationsResumed: false, installationAdmissionRequired: true,
        recordedAuthorityMode: database.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").get()?.mode } } : {}),
      ...(ensureShadowExecutionSuspended(database) ? { shadowRecovery: { providerIO: false, runtimeExecutionEnabled: false,
        unfinishedOperationsResumed: false, authorityActivationPerformed: false,
        recordedAuthorityMode: database.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").get()?.mode,
        reconciliationRequired: true, expiredRetentionEdges: expiredShadowRetentionEdges } } : {}),
      verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", triggersReinstalled: triggers.length,
        schemaEqual: true, derivedTablesRebuilt, projectRelations: true, retentionDifferencesOnlyExpired: true,
        expiredEdgesReconstructed: true, exportedAtIsExactSnapshotClock: false,
        ...(sourceSnapshotClock ? { sourceSnapshotClock, retentionEqualAtSourceSnapshotClock: true } : {}) },
    };
    await mkdir(join(staging, "provenance"));
    if (manifest.schemaVersion === 26) await mkdir(join(staging, "artifacts"));
    for (const artifact of retainedArtifacts) await writeFile(join(staging, artifact.path), artifact.bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(staging, "original-archive.zip"), bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(staging, "provider-manifest.json"), JSON.stringify(providerEntries, null, 2), { flag: "wx", mode: 0o600 });
    await writeFile(join(staging, "restore-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    database.close();
    database = undefined;
    const restoredDirectory = join(destination, "restored");
    await rename(staging, restoredDirectory);
    completed = true;
    return { restoredDirectory, report };
  } finally {
    try { database?.close(); }
    finally { if (!completed) await rm(destination, { recursive: true, force: true }); }
  }
}
