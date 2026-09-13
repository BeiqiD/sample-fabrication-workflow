import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32 } from "node:zlib";
import JSZip from "jszip";
import { buildBlobExportPlan } from "../../worker/blob-lifecycle/export";

type Row = Record<string, string | number | null>;
const EXPORTED_VIEWS = ["blob_retention_edges"];
const PLATFORM_TABLES = new Set(["d1_migrations", "_cf_KV"]);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
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
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        expanded += chunk.length;
        if (size > MAX_ENTRY_BYTES || expanded > MAX_EXPANDED_BYTES) {
          stream.destroy(new Error("Archive exceeds isolated restore size limits"));
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
  return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
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

function retentionAt(databasePath: string, inspectionTime: string) {
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
    return projection.prepare("SELECT * FROM blob_retention_edges").all() as Row[];
  } finally {
    projection.close();
    clock.close();
  }
}

export async function restoreExportToIsolatedDirectory(options: {
  archivePath: string;
  destination: string;
  migrationsDirectory: string;
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
    ensure(object(manifest) && manifest.schemaVersion === 7 && typeof manifest.exportedAt === "string"
      && Number.isFinite(Date.parse(manifest.exportedAt)) && object(manifest.tables)
      && Array.isArray(manifest.blobs) && Array.isArray(warnings), "Unsupported complete-export manifest");

    database = new DatabaseSync(join(staging, "database.sqlite"));
    const migrationNames = (await readdir(options.migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
    ensure(migrationNames.length > 0, "No local migrations found");
    const migrations: Array<{ name: string; sha256: string }> = [];
    for (const name of migrationNames) {
      const sql = await readFile(join(options.migrationsDirectory, name), "utf8");
      migrations.push({ name, sha256: hash(sql) });
      database.exec(sql);
    }
    const expectedSchema = schema(database);
    const tableNames = expectedSchema.filter((entry) => entry.type === "table" && !PLATFORM_TABLES.has(entry.name)).map((entry) => entry.name);
    const catalog = [...tableNames, ...EXPORTED_VIEWS].sort();
    ensure(canonical(Object.keys(manifest.tables).sort()) === canonical(catalog), "Archive table catalog differs from the current local schema");
    const tables: Record<string, Row[]> = {};
    for (const name of catalog) {
      const descriptor = manifest.tables[name];
      ensure(object(descriptor) && Number.isSafeInteger(descriptor.rowCount) && descriptor.rowCount >= 0, `Invalid table row count: ${name}`);
      const rows = await archive.json(descriptor.path);
      ensure(Array.isArray(rows) && rows.length === descriptor.rowCount, `Table row count mismatch: ${name}`);
      const columns = (database.prepare(`PRAGMA table_info(${identifier(name)})`).all() as Array<{ name: string }>).map((column) => column.name).sort();
      for (const row of rows) {
        ensure(object(row) && canonical(Object.keys(row).sort()) === canonical(columns), `Table column mismatch: ${name}`);
        ensure(Object.values(row).every((value) => value === null || typeof value === "string"
          || typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))), `Invalid table cell: ${name}`);
      }
      tables[name] = rows;
    }

    const plan = buildBlobExportPlan(tables);
    const expectedBlobs = new Map(plan.map((entry) => [entry.locatorId, entry]));
    ensure(manifest.blobs.length === plan.length, "Archive blob catalog differs from exported tables");
    const seen = new Set<string>();
    const providerEntries: Array<Record<string, unknown>> = [];
    const missingHashes: string[] = [];
    const expectedWarnings = new Map<string, Record<string, unknown>>();
    await mkdir(join(staging, "provider-bytes"));
    for (const [index, blob] of manifest.blobs.entries()) {
      ensure(object(blob) && typeof blob.locatorId === "string" && !seen.has(blob.locatorId), "Duplicate or invalid blob locator");
      seen.add(blob.locatorId);
      const expected = expectedBlobs.get(blob.locatorId);
      ensure(expected, "Unknown blob locator");
      for (const field of ["storeKind", "provider", "objectKey", "blobRecordIds", "filename", "expectedByteSize", "expectedSha256", "sourceOccurrences"] as const) {
        ensure(canonical(blob[field]) === canonical(expected[field]), `Blob metadata disagrees with table snapshot: ${field}`);
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
        objectKey: blob.objectKey, path: localPath, sha256: restoredSha256, outcome: blob.outcome });
    }
    ensure(warnings.length === expectedWarnings.size, "Export warnings disagree with blob outcomes");
    for (const warning of warnings) {
      ensure(object(warning), "Invalid export warning");
      const blob = expectedWarnings.get(warning.locatorId);
      ensure(blob && warning.code === blob.outcome && typeof warning.message === "string"
        && canonical(warning.blobRecordIds) === canonical(blob.blobRecordIds)
        && canonical(warning.sourceOccurrences) === canonical(blob.sourceOccurrences), "Export warning disagrees with its blob");
      expectedWarnings.delete(warning.locatorId);
    }
    archive.finish();

    // The only database affected here was just created in our private staging
    // directory. Ordinary write triggers reject valid historical snapshots and
    // migration seeds may have changed since export. Load the exact snapshot
    // atomically, then reinstall the exact original schema before publication.
    const triggers = expectedSchema.filter((entry) => entry.type === "trigger");
    database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      for (const trigger of triggers) database.exec(`DROP TRIGGER ${identifier(trigger.name)}`);
      for (const name of tableNames) database.exec(`DELETE FROM ${identifier(name)}`);
      for (const name of tableNames) {
        const rows = tables[name];
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        const insert = database.prepare(`INSERT INTO ${identifier(name)} (${columns.map(identifier).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
        for (const row of rows) insert.run(...columns.map((column) => row[column]));
      }
      for (const trigger of triggers) database.exec(trigger.sql);
      ensure(database.prepare("PRAGMA foreign_key_check").all().length === 0, "Restored database foreign-key check failed");
      ensure(database.prepare("PRAGMA integrity_check").all().every((row) => Object.values(row)[0] === "ok"), "Restored database integrity check failed");
      ensure(canonical(schema(database)) === canonical(expectedSchema), "Restored schema differs from the migrated schema");
      inspectProjectRelations(database);
      for (const name of tableNames) ensure(sameRows(database.prepare(`SELECT * FROM ${identifier(name)}`).all() as Row[], tables[name]), `Restored rows differ: ${name}`);
      database.exec("COMMIT; PRAGMA foreign_keys = ON");
    } catch (error) {
      database.exec("ROLLBACK; PRAGMA foreign_keys = ON");
      throw error;
    }
    ensure(Object.values(database.prepare("PRAGMA foreign_keys").get()!)[0] === 1, "Foreign-key enforcement was not restored");
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
    const report = {
      kind: "isolated-same-schema-export-rehearsal", schemaVersion: 7,
      archivedAt: manifest.exportedAt, verifiedAt: now, archiveSha256: hash(bytes),
      migrationsSha256: hash(canonical(migrations)), migrations,
      schemaSha256: hash(canonical(expectedSchema)), tableCount: tableNames.length,
      rowCount: tableNames.reduce((count, name) => count + tables[name].length, 0),
      restoredBlobCount: providerEntries.filter((entry) => entry.path !== null).length,
      databasePath: "database.sqlite", providerManifestPath: "provider-manifest.json",
      warnings, packagedWithoutRecordedHash: missingHashes, expiredRetentionEdges: expiredEdges,
      verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", triggersReinstalled: triggers.length,
        schemaEqual: true, projectRelations: true, retentionDifferencesOnlyExpired: true,
        expiredEdgesReconstructed: true, exportedAtIsExactSnapshotClock: false },
    };
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
