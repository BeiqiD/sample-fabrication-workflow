import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { IMPORT_ACCEPTANCE_EXPORT_COLUMNS } from "../shared/contracts/export-import-acceptance";
import type { FullExportManifestV9 } from "../shared/contracts/export";
import { createExportArtifact, EXPORT_SOURCE_SCHEMA_PATH, validateFullExportV8, validateFullExportV9 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV8, buildFullExportArchiveV9 } from "../src/lib/exportAll";
import worker from "./index";
import { seedReferenceGraph, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const endpoint = "/api/exports/all?archiveSchema=9&archiveWriter=1";
const now = "2026-09-13T18:00:00.000Z";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql"]) {
    database.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
  seedReferenceGraph(database);
  database.prepare(`INSERT INTO imports (id, status, source_filename, source_sha256, sheet_name, template_type,
    warning_count, actor_email, created_at, operation_id, error_message)
    VALUES ('historical-import', 'failed', 'old.xlsx', ?, 'Sheet1', 'process', 2, 'old@example.com', ?,
      'historical-operation', 'Retained historical failure')`).run("e".repeat(64), now);
  const provider = new Map<string, Uint8Array>();
  for (const asset of database.prepare("SELECT id, r2_key, byte_size FROM assets").all()) {
    const bytes = new Uint8Array(Number(asset.byte_size)).fill(Number(asset.byte_size));
    provider.set(String(asset.r2_key), bytes);
    database.prepare("UPDATE assets SET sha256 = ? WHERE id = ?").run(sha256(bytes), asset.id);
  }
  database.prepare(`INSERT INTO storage_profiles VALUES
    ('profile-r2', 'r2', 'r2:qualified-bucket', 'bootstrap', NULL, 1, 'historical', ?)`).run(now);
  const asset = database.prepare("SELECT r2_key, byte_size, sha256 FROM assets ORDER BY id LIMIT 1").get()!;
  database.prepare(`INSERT INTO files VALUES
    ('file-observed', 'embedded_content', 'system', ?, ?, NULL, 'unresolved', NULL, ?),
    ('file-collected', NULL, 'system', 4, NULL, NULL, 'unresolved', NULL, ?)`).run(asset.byte_size, asset.sha256, now, now);
  database.prepare(`INSERT INTO file_locations VALUES
    ('location-observed', 'file-observed', 'profile-r2', ?, 'unresolved', ?),
    ('location-collected', 'file-collected', 'profile-r2', 'past/collected.bin', 'unresolved', ?)`).run(asset.r2_key, now, now);
  database.prepare(`INSERT INTO legacy_file_mappings VALUES
    ('r2', 'r2', ?, 'file-observed', 'location-observed', 'classified', '{}', ?),
    ('r2', 'r2', 'past/collected.bin', 'file-collected', 'location-collected', 'unclassified', '{}', ?)`).run(asset.r2_key, now, now);
  const d1 = new SqliteD1Database(database);
  const batch = vi.spyOn(d1, "batch");
  const env = { AUTH_MODE: "disabled", DB: d1 as unknown as D1Database,
    ASSETS: { async get(key: string) {
      const bytes = provider.get(key);
      return bytes ? { body: bytes, httpEtag: `"${sha256(bytes)}"`, writeHttpMetadata(headers: Headers) { headers.set("content-type", "application/octet-stream"); } } : null;
    } } as unknown as R2Bucket } satisfies Env;
  const request = (path: string) => worker.fetch(new Request(new URL(path, "https://app.test")), env, context);
  const fetcher = vi.fn((url: string | URL | Request) => request(typeof url === "string" ? url : url instanceof URL ? url.href : url.url)) as unknown as typeof fetch;
  return { database, batch, provider, request, fetcher,
    async manifest() { const response = await request(endpoint); expect(response.status).toBe(200); return response.json() as Promise<FullExportManifestV9>; } };
}

describe("v9 dormant file registry archive profile", () => {
  it("retains the frozen historical browser contract and round-trips populated dormant observations and all legacy bytes", async () => {
    const f = fixture();
    const scratch = await mkdtemp(join(tmpdir(), "export-v9-"));
    try {
      vi.stubGlobal("fetch", f.fetcher);
      const manifest = await f.manifest();
      expect(manifest).toMatchObject({ schemaVersion: 9, archiveWriter: 1, archiveProfile: "fp1-legacy-overlap" });
      expect(f.batch).toHaveBeenCalledTimes(1);
      expect(f.batch.mock.calls[0][0]).toHaveLength(Object.keys(manifest.tables).length + 3);
      expect(manifest.tables.files).toHaveLength(2);
      expect(manifest.blobs.some((blob) => blob.objectKey === "past/collected.bin")).toBe(false);
      const result = await buildFullExportArchiveV9(manifest, undefined, f.fetcher);
      expect(result.warnings).toEqual([]);
      const bytes = Buffer.from(await result.archive.arrayBuffer());
      const zip = await JSZip.loadAsync(bytes);
      const archived = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      expect(archived.archiveProfile).toBe("fp1-legacy-overlap");
      for (const name of ["storage_profiles", "files", "file_locations", "legacy_file_mappings"]) {
        const tableBytes = await zip.file(archived.tables[name].path)!.async("uint8array");
        expect(sha256(tableBytes)).toBe(archived.tables[name].sha256);
        expect(JSON.parse(new TextDecoder().decode(tableBytes))).toEqual(manifest.tables[name]);
      }
      const archivePath = join(scratch, "v9.zip");
      await writeFile(archivePath, bytes);
      const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(scratch, "output"), migrationsDirectory, targetCompatibilitySchema: "S2" });
      expect(restored.report).toMatchObject({ schemaVersion: 9, archiveProfile: "fp1-legacy-overlap", appliedForwardMigrations: [{ name: "0003_fp1_import_acceptance.sql" }, { name: "0004_r2_upload_acceptance.sql" }, { name: "0005_metrology_reference_acceptance.sql" }, { name: "0006_comment_acceptance.sql" }], warnings: [],
        verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", schemaEqual: true } });
      const database = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
      try {
        for (const name of ["storage_profiles", "files", "file_locations", "legacy_file_mappings"]) {
          const source = f.database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
          const target = database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
          expect(target.map((row) => JSON.stringify(row)).sort()).toEqual(source.map((row) => JSON.stringify(row)).sort());
        }
        const sourceImport = f.database.prepare("SELECT * FROM imports WHERE id = 'historical-import'").get()!;
        const restoredImport = database.prepare("SELECT * FROM imports WHERE id = 'historical-import'").get()!;
        expect(restoredImport).toEqual({ ...sourceImport, ...Object.fromEntries(IMPORT_ACCEPTANCE_EXPORT_COLUMNS.map((column) => [column, null])) });
        expect(() => database.exec("UPDATE files SET state = 'ready'")).toThrow();
      } finally { database.close(); }
      expect(await readFile(join(restored.restoredDirectory, "original-archive.zip"))).toEqual(bytes);
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  }, 15_000);

  it("preserves SQLite code-point limits for opaque astral-Unicode identities and keys", async () => {
    const f = fixture();
    try {
      const fileId = "🧪".repeat(256), locationId = "📍".repeat(256), objectKey = "🧬".repeat(4096);
      f.database.prepare(`INSERT INTO files VALUES (?, NULL, 'system', NULL, NULL, NULL, 'unresolved', NULL, ?)`)
        .run(fileId, now);
      f.database.prepare(`INSERT INTO file_locations VALUES (?, ?, 'profile-r2', ?, 'unresolved', ?)`)
        .run(locationId, fileId, objectKey, now);
      f.database.prepare(`INSERT INTO legacy_file_mappings VALUES ('r2', 'r2', ?, ?, ?, 'unclassified', '{}', ?)`)
        .run(objectKey, fileId, locationId, now);
      const manifest = await f.manifest();
      await expect(validateFullExportV9(manifest)).resolves.toEqual(manifest);
      expect(manifest.tables.file_locations.some((row) => row.object_key === objectKey)).toBe(true);
    } finally { f.database.close(); }
  });

  it("rejects old clients on the new schema and prevents v8 relabeling before provider download", async () => {
    const f = fixture();
    try {
      const response = await f.request("/api/exports/all?archiveSchema=8&archiveWriter=1");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("Refresh the page") });
      const manifest = await f.manifest();
      await expect(buildFullExportArchiveV8(manifest, undefined, f.fetcher)).rejects.toThrow("versions differ");
      await expect(buildFullExportArchiveV9({ ...manifest, schemaVersion: 8 }, undefined, f.fetcher)).rejects.toThrow("versions differ");
      await expect(validateFullExportV8({ ...manifest, schemaVersion: 8 })).rejects.toThrow("requires archive schema 9");
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each([
    ["unknown profile", (manifest: FullExportManifestV9) => { (manifest as any).archiveProfile = "future"; }],
    ["active file", (manifest: FullExportManifestV9) => { manifest.tables.files[0].active_location_id = "location-observed"; }],
    ["verified file", (manifest: FullExportManifestV9) => { manifest.tables.files[0].verified_sha256 = "a".repeat(64); }],
    ["new-only location", (manifest: FullExportManifestV9) => { manifest.tables.legacy_file_mappings.pop(); }],
    ["wrong namespace provider", (manifest: FullExportManifestV9) => { manifest.tables.legacy_file_mappings[0].provider = "switchdrive"; }],
    ["lost file", (manifest: FullExportManifestV9) => { manifest.tables.files.pop(); }],
    ["duplicate location", (manifest: FullExportManifestV9) => { manifest.tables.file_locations.push(structuredClone(manifest.tables.file_locations[0])); }],
  ] as const)("refuses unsupported file authority before download: %s", async (_name, corrupt) => {
    const f = fixture();
    try {
      const manifest = await f.manifest();
      corrupt(manifest);
      await expect(buildFullExportArchiveV9(manifest, undefined, f.fetcher)).rejects.toThrow("Full export rejected");
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("rejects an unreviewed column even when its table is empty", async () => {
    const f = fixture();
    try {
      f.database.exec("ALTER TABLE storage_profiles ADD COLUMN future_secret TEXT");
      // A malformed source must fail on the Worker, before it emits a complete
      // envelope. Independently check browser admission with recorded SQL.
      const response = await f.request(endpoint);
      expect(response.status).toBe(500);
    } finally { f.database.close(); }
    const fresh = fixture();
    try {
      const manifest = await fresh.manifest();
      for (const name of ["storage_profiles", "files", "file_locations", "legacy_file_mappings"]) manifest.tables[name] = [];
      const entry = manifest.artifacts.sourceSchema.value.objects.find((entry) => entry.type === "table" && entry.name === "storage_profiles")!;
      entry.sql = entry.sql!.replace("created_at TEXT NOT NULL,", "created_at TEXT NOT NULL, future_secret TEXT,");
      manifest.artifacts.sourceSchema = await createExportArtifact(EXPORT_SOURCE_SCHEMA_PATH, manifest.artifacts.sourceSchema.value);
      await expect(validateFullExportV9(manifest)).rejects.toThrow("schema columns differ");
    } finally { fresh.database.close(); }
  });

  it("refuses a v9 archive whose profile was removed and cleans its private destination", async () => {
    const f = fixture();
    const scratch = await mkdtemp(join(tmpdir(), "export-v9-invalid-"));
    try {
      const result = await buildFullExportArchiveV9(await f.manifest(), undefined, f.fetcher);
      const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
      const manifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      delete manifest.archiveProfile;
      zip.file("export-manifest.json", JSON.stringify(manifest));
      const archivePath = join(scratch, "invalid.zip"), destination = join(scratch, "output");
      await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      await expect(restoreExportToIsolatedDirectory({ archivePath, destination, migrationsDirectory, targetCompatibilitySchema: "S2" })).rejects.toThrow("unsupported archive schema profile");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  }, 15_000);
});
