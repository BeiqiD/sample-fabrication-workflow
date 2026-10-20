import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Hono } from "hono";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import type { FullExportManifest } from "../shared/types";
import type { FullExportManifestV8 } from "../shared/contracts/export";
import { restoreCompatibilityRows } from "../shared/contracts/export-compatibility";
import { buildFullExportArchive } from "../src/lib/exportAll";
import { snapshotRoutes } from "./export-routes";
import { createAttachmentProjectItem, createMarkdownProjectItem, createProject, createProjectEdge,
  createReferenceProjectItem, readProjectSnapshot, removeProjectItem } from "./projects/service";
import { historicalReferenceTestDatabase, seedHistoricalReferenceGraph, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const root = fileURLToPath(new URL("../", import.meta.url));
const migrationsDirectory = join(root, "migrations-history/s0");
// Each case migrates the full schema and handles real ZIP bytes. Shared CI
// runners can exceed the unit-test default even on rejection paths.
const RECOVERY_TEST_TIMEOUT = 15_000;
const ACTOR = "restore-fixture@example.test";
const NOW = "2026-08-09T23:00:00.000Z";
const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const locator = (store: string, provider: string, key: string) => JSON.stringify([store, provider, key]);

async function fullExport(database: DatabaseSync) {
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.route("/", snapshotRoutes);
  const response = await app.request("/exports/all?archiveSchema=8&archiveWriter=1", {}, { DB: new SqliteD1Database(database) } as unknown as Env);
  expect(response.status).toBe(200);
  const current = await response.json() as FullExportManifestV8;
  // Keep this existing recovery suite on genuine v7 row/ZIP contracts. This
  // fixture-only conversion is not an unversioned live endpoint.
  return { schemaVersion: 7, exportedAt: current.exportedAt,
    tables: restoreCompatibilityRows(current.tables, current.artifacts.retiredFields.value, "S0"),
    blobs: current.blobs } as FullExportManifest;
}

async function fixture() {
  const database = historicalReferenceTestDatabase();
  const ids = seedHistoricalReferenceGraph(database);
  const db = new SqliteD1Database(database) as unknown as D1Database;
  const provider = new Map<string, Uint8Array>();
  for (const asset of database.prepare("SELECT id, r2_key, byte_size FROM assets").all() as Array<{ id: string; r2_key: string; byte_size: number }>) {
    const bytes = new Uint8Array(asset.byte_size).fill(asset.byte_size);
    database.prepare("UPDATE assets SET sha256 = ? WHERE id = ?").run(hash(bytes), asset.id);
    provider.set(locator("r2", "r2", asset.r2_key), bytes);
  }
  database.exec(`
    UPDATE recipe_families SET name = 'Changed retained built-in family' WHERE id = 'builtin-metrology-family-afm';
    INSERT INTO run_step_comments (id, run_step_id, scope, body, asset_id, actor_email, created_at)
      VALUES ('legacy-note', 'reference-step-b', 'individual', 'Legacy direct attachment', 'reference-comment-asset', '${ACTOR}', '${NOW}');
    INSERT INTO run_plan_revisions (id, run_id, revision_no, template_version_id, reason, created_at)
      VALUES ('plan-history', 'reference-run-a', 1, 'reference-process-template', 'Preserved plan history', '${NOW}');
    INSERT INTO state_verifications (id, sample_id, after_run_step_id, run_plan_revision_id, result, evidence_asset_id, note, created_at)
      VALUES ('verification-history', 'reference-sample-a', 'reference-step-a', 'plan-history', 'matched', 'reference-execution-asset', 'Preserved evidence', '${NOW}');
    INSERT INTO state_verification_steps (verification_id, run_step_id, ordinal)
      VALUES ('verification-history', 'reference-step-a', 0);
    INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, created_at)
      VALUES ('legacy-unhashed', 'legacy/opaque file.bin', 'legacy.bin', 'application/octet-stream', 4, 'ready', '${NOW}'),
        ('missing', 'fixture/missing.bin', 'missing.bin', 'application/octet-stream', 4, 'ready', '${NOW}'),
        ('unready', 'fixture/unready.bin', 'unready.bin', 'application/octet-stream', 4, 'failed', '${NOW}');
    INSERT INTO blob_integrity_quarantine
      (store_kind, provider, object_key, blob_record_id, reason, expected_byte_size, operation_id, detected_at, last_checked_at)
      VALUES ('r2', 'r2', 'fixture/missing.bin', 'missing', 'missing', 4, 'quarantine-fixture', '${NOW}', '${NOW}');
    INSERT INTO blob_gc_ledger (store_kind, provider, object_key, blob_record_id, state, operation_id, orphaned_at, updated_at)
      VALUES ('r2', 'r2', 'fixture/missing.bin', 'missing', 'orphaned', 'gc-fixture', '${NOW}', '${NOW}');
  `);
  provider.set(locator("r2", "r2", "legacy/opaque file.bin"), new TextEncoder().encode("data"));
  const managed = new TextEncoder().encode("managed archive bytes");
  database.prepare(`INSERT INTO managed_storage_objects
    (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at)
    VALUES ('managed-fixture', 'switchdrive', 'folder/../opaque 数据.bin', 'record.bin', 'application/octet-stream', ?, ?, 'ready', ?)`)
    .run(managed.length, hash(managed), NOW);
  provider.set(locator("managed", "switchdrive", "folder/../opaque 数据.bin"), managed);

  await createProject(db, { id: "restore-project", title: "Restore fixture", operationId: "create-project" }, ACTOR, NOW);
  await createMarkdownProjectItem(db, "restore-project", { contentId: "note-content", itemId: "note-item", placementId: "note-placement",
    markdownSource: "# Persist exact identity\n\n$E = mc^2$", geometry, expectedProjectRevision: 1, operationId: "create-note" }, ACTOR, NOW);
  await createReferenceProjectItem(db, "restore-project", { itemId: "reference-item", placementId: "reference-placement", target: { type: "comment", id: ids.comment },
    geometry: { ...geometry, x: 400 }, expectedProjectRevision: 2, operationId: "create-reference" }, ACTOR, NOW, "reference-registry");
  await createAttachmentProjectItem(db, "restore-project", { contentId: "attachment-content", itemId: "attachment-item", placementId: "attachment-placement",
    locator: { storageObjectId: "managed-fixture" }, caption: "Managed evidence", sourceUrl: null, geometry: { ...geometry, y: 400 },
    expectedProjectRevision: 3, operationId: "create-attachment" }, ACTOR, NOW);
  await createProjectEdge(db, "restore-project", { edgeId: "historical-edge", sourceItemId: "note-item", targetItemId: "reference-item",
    sourceHandle: "right", targetHandle: "left", markerStart: "none", markerEnd: "arrow", label: "supports", expectedSourceItemRevision: 1,
    expectedTargetItemRevision: 1, operationId: "create-edge" }, ACTOR, NOW);
  await removeProjectItem(db, "restore-project", "note-item", { expectedItemRevision: 1, expectedContentRevision: 1, operationId: "trash-note" }, ACTOR, NOW);
  return { database, db, provider };
}

async function archiveFrom(manifest: FullExportManifest, provider: Map<string, Uint8Array>) {
  const urls = new Map(manifest.blobs.map((entry) => [entry.downloadUrl, entry.locatorId]));
  return buildFullExportArchive(manifest, undefined, (async (url) => {
    const bytes = provider.get(urls.get(String(url))!);
    return bytes ? new Response(new Uint8Array(bytes).buffer) : new Response("", { status: 404 });
  }) as typeof fetch);
}

describe("isolated full export recovery rehearsal", () => {
  let scratch: string;
  beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), "sample-restore-test-")); });
  afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });
  const options = (scratch: string, archivePath: string, suffix = "destination") => ({ archivePath, destination: join(scratch, suffix), migrationsDirectory });

  it("restores canonical, legacy, history, deleted Project, managed, quarantine and missing-byte state then reexports it", async () => {
    const source = await fixture();
    try {
      const manifest = await fullExport(source.database);
      const archive = await archiveFrom(manifest, source.provider);
      const archivePath = join(scratch, "source.zip");
      await writeFile(archivePath, Buffer.from(await archive.archive.arrayBuffer()));
      const inputHash = hash(await readFile(archivePath));
      const result = await restoreExportToIsolatedDirectory(options(scratch, archivePath));
      expect(result.report).toMatchObject({ archiveSha256: inputHash, tableCount: 34, restoredBlobCount: 5,
        verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", schemaEqual: true,
          derivedTablesRebuilt: false, projectRelations: true } });
      expect(result.report.verification.triggersReinstalled).toBeGreaterThan(100);
      expect(result.report.warnings.map((warning: { code: string }) => warning.code).sort()).toEqual(["metadata_not_ready", "missing"]);
      expect(result.report.packagedWithoutRecordedHash).toEqual([locator("r2", "r2", "legacy/opaque file.bin")]);
      const restored = new DatabaseSync(join(result.restoredDirectory, "database.sqlite"));
      try {
        restored.exec("PRAGMA foreign_keys = ON");
        const regenerated = await fullExport(restored);
        expect(regenerated.tables).toEqual(manifest.tables);
        const snapshot = await readProjectSnapshot(new SqliteD1Database(restored) as unknown as D1Database, "restore-project", true);
        expect(snapshot).toEqual(await readProjectSnapshot(source.db, "restore-project", true));
        expect(snapshot.items.find((item) => item.id === "note-item")?.deletedAt).not.toBeNull();
        expect(() => restored.exec("UPDATE projects SET id = 'different' WHERE id = 'restore-project'"))
          .toThrow(/identity is immutable/);
        expect(() => restored.exec("DELETE FROM reference_targets")).toThrow(/physical deletion is disabled/);
        const entries = JSON.parse(await readFile(join(result.restoredDirectory, "provider-manifest.json"), "utf8"));
        const restoredProvider = new Map<string, Uint8Array>();
        for (const entry of entries) if (entry.path !== null) {
          const bytes = new Uint8Array(await readFile(join(result.restoredDirectory, entry.path)));
          expect(hash(bytes)).toBe(entry.sha256);
          restoredProvider.set(entry.locatorId, bytes);
        }
        expect(restoredProvider).toEqual(source.provider);
        const reexport = await archiveFrom(regenerated, restoredProvider);
        expect(reexport.results).toEqual(archive.results);
        expect(reexport.warnings).toEqual(archive.warnings);
      } finally { restored.close(); }
      expect(hash(await readFile(archivePath))).toBe(inputHash);
    } finally { source.database.close(); }
  }, RECOVERY_TEST_TIMEOUT);

  it("reconstructs genuine expired edges even when they expired before the export response timestamp", async () => {
    const source = await fixture();
    const clock = new DatabaseSync(":memory:");
    try {
      source.database.exec(`UPDATE run_step_assets SET deleted_at = '2026-09-01T00:00:00.500Z', deleted_by = '${ACTOR}'
        WHERE id = 'reference-execution-image'`);
      const exportedAt = "2026-09-01T12:00:00.000Z";
      source.database.function("datetime", { varargs: true }, (...values) =>
        Object.values(clock.prepare(`SELECT datetime(${values.map(() => "?").join(",")})`).get(...values.map((value) => value === "now" ? exportedAt : value))!)[0]);
      const manifest = await fullExport(source.database);
      // The route constructs exportedAt after its SELECT. Simulate a delayed
      // response after the edge expires, without claiming it was the DB clock.
      manifest.exportedAt = "2026-09-02T00:00:01.000Z";
      expect(manifest.tables.blob_retention_edges.some((row) => row.retention_reason === "deleted_run_step_asset_grace")).toBe(true);
      const result = await archiveFrom(manifest, source.provider);
      const path = join(scratch, "historical.zip");
      await writeFile(path, Buffer.from(await result.archive.arrayBuffer()));
      const restored = await restoreExportToIsolatedDirectory(options(scratch, path));
      expect(restored.report.expiredRetentionEdges).toEqual([expect.objectContaining({ occurrence_id: "reference-execution-image",
        retention_reason: "deleted_run_step_asset_grace", retain_until: "2026-09-02T00:00:00.500Z" })]);
    } finally { source.database.close(); clock.close(); }
  }, RECOVERY_TEST_TIMEOUT);

  it.each(["row count", "table catalog", "blob hash", "warnings", "duplicate path", "foreign key", "project relation", "historical edge", "unsafe path"])(
    "rejects %s corruption and removes every partial destination", async (kind) => {
      const source = await fixture();
      try {
        const result = await archiveFrom(await fullExport(source.database), source.provider);
        const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
        const manifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
        if (kind === "row count") manifest.tables.samples.rowCount += 1;
        if (kind === "table catalog") delete manifest.tables.projects;
        if (kind === "unsafe path") manifest.tables.samples.path = "../outside.json";
        if (kind === "warnings") zip.file("export-warnings.json", "[]");
        if (kind === "blob hash") {
          const entry = manifest.blobs.find((blob: { expectedSha256: string | null; outcome: string }) => blob.expectedSha256 && blob.outcome === "packaged");
          const bytes = await zip.file(entry.path)!.async("uint8array"); bytes[0] ^= 1; zip.file(entry.path, bytes);
        }
        if (kind === "duplicate path") {
          const entries = manifest.blobs.filter((blob: { outcome: string }) => blob.outcome === "packaged");
          entries[1].path = entries[0].path;
        }
        if (kind === "foreign key") {
          const rows = JSON.parse(await zip.file(manifest.tables.runs.path)!.async("string"));
          rows[0].sample_id = "missing-sample"; zip.file(manifest.tables.runs.path, JSON.stringify(rows));
        }
        if (kind === "project relation") {
          const rows = JSON.parse(await zip.file(manifest.tables.projects.path)!.async("string"));
          rows[0].next_created_sequence = 1; zip.file(manifest.tables.projects.path, JSON.stringify(rows));
        }
        if (kind === "historical edge") {
          const rows = JSON.parse(await zip.file(manifest.tables.blob_retention_edges.path)!.async("string"));
          rows[0].retention_reason = "forged";
          zip.file(manifest.tables.blob_retention_edges.path, JSON.stringify(rows));
          // Keep blob metadata internally consistent so the historical view
          // comparison, rather than the catalog check, must reject the forgery.
          for (const blob of manifest.blobs) for (const occurrence of blob.sourceOccurrences) {
            if (occurrence.sourceType === rows[0].source_type && occurrence.sourceId === rows[0].source_id
              && occurrence.occurrenceType === rows[0].occurrence_type && occurrence.occurrenceId === rows[0].occurrence_id) occurrence.retentionReason = "forged";
          }
        }
        zip.file("export-manifest.json", JSON.stringify(manifest));
        const path = join(scratch, "corrupt.zip");
        await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
        const destination = options(scratch, path);
        const errors: Record<string, RegExp> = {
          "row count": /Table row count mismatch/,
          "table catalog": /table catalog differs/,
          "blob hash": /SHA-256 mismatch/,
          warnings: /warnings disagree/,
          "duplicate path": /exactly one table or blob/,
          "foreign key": /foreign-key check failed/,
          "project relation": /sequence watermark verification failed/,
          "historical edge": /non-expired retention edge was lost/,
          "unsafe path": /Unsafe archive path/,
        };
        await expect(restoreExportToIsolatedDirectory(destination)).rejects.toThrow(errors[kind]);
        await expect(stat(destination.destination)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(scratch)).toEqual(["corrupt.zip"]);
      } finally { source.database.close(); }
    },
    RECOVERY_TEST_TIMEOUT,
  );

  it.each(["CRC", "duplicate directory entry", "shadowed unsafe entry"])("rejects raw ZIP %s corruption", async (kind) => {
    const database = historicalReferenceTestDatabase();
    try {
      const result = await archiveFrom(await fullExport(database), new Map());
      const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
      let bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
      if (kind === "CRC") {
        const location = bytes.indexOf(Buffer.from("builtin-metrology-family-afm"));
        expect(location).toBeGreaterThan(0);
        // The replacement remains valid UTF-8/JSON and retains the same length.
        bytes[location] = "B".charCodeAt(0);
      } else if (kind === "duplicate directory entry") {
        const footer = bytes.length - 22;
        const start = bytes.readUInt32LE(footer + 16);
        const memberLength = 46 + bytes.readUInt16LE(start + 28) + bytes.readUInt16LE(start + 30) + bytes.readUInt16LE(start + 32);
        const member = bytes.subarray(start, start + memberLength);
        const end = Buffer.from(bytes.subarray(footer));
        end.writeUInt16LE(end.readUInt16LE(8) + 1, 8);
        end.writeUInt16LE(end.readUInt16LE(10) + 1, 10);
        end.writeUInt32LE(end.readUInt32LE(12) + memberLength, 12);
        bytes = Buffer.concat([bytes.subarray(0, footer), member, end]);
      } else {
        const shadowed = new JSZip();
        shadowed.file("junk/../export-manifest.json", "{}", { createFolders: false });
        for (const file of Object.values(zip.files)) if (!file.dir) shadowed.file(file.name, await file.async("uint8array"));
        bytes = await shadowed.generateAsync({ type: "nodebuffer" });
      }
      const path = join(scratch, "invalid-directory.zip");
      await writeFile(path, bytes);
      const target = options(scratch, path);
      const message = kind === "CRC" ? /CRC-32 mismatch/ : kind === "duplicate directory entry" ? /Duplicate ZIP member/ : /Unsafe archive path/;
      await expect(restoreExportToIsolatedDirectory(target)).rejects.toThrow(message);
      await expect(stat(target.destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { database.close(); }
  }, RECOVERY_TEST_TIMEOUT);

  it("refuses existing and symlink destinations and exercises the public local CLI", async () => {
    const database = historicalReferenceTestDatabase();
    try {
      const manifest = await fullExport(database);
      const result = await archiveFrom(manifest, new Map());
      const path = join(scratch, "empty.zip");
      await writeFile(path, Buffer.from(await result.archive.arrayBuffer()));
      await mkdir(join(scratch, "existing"));
      await writeFile(join(scratch, "existing", "keep.txt"), "unchanged");
      await symlink(join(scratch, "existing"), join(scratch, "linked"), "dir");
      for (const suffix of ["existing", "linked"]) {
        await expect(restoreExportToIsolatedDirectory(options(scratch, path, suffix))).rejects.toMatchObject({ code: "EEXIST" });
      }
      expect(await readFile(join(scratch, "existing", "keep.txt"), "utf8")).toBe("unchanged");
      const cli = await promisify(execFile)(process.execPath, [join(root, "scripts/verify-export-restore.mjs"),
        "--archive", path, "--destination", join(scratch, "cli-destination"), "--migrations-dir", migrationsDirectory, "--target-schema", "S0"], { cwd: root });
      expect(JSON.parse(cli.stdout).report.verification.rowsEqual).toBe(true);
    } finally { database.close(); }
  }, RECOVERY_TEST_TIMEOUT);
});
