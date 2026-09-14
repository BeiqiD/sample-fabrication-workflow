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
import type { ExportRow, FullExportManifestV10 } from "../shared/contracts/export";
import { createExportArtifact, EXPORT_SOURCE_SCHEMA_PATH, validateFullExportV8, validateFullExportV9, validateFullExportV10 } from "../shared/contracts/export-protocol";
import { IMPORT_ACCEPTANCE_EXPORT_COLUMNS } from "../shared/contracts/export-import-acceptance";
import { buildBlobExportPlan } from "../shared/contracts/export-blob-plan";
import { stableJson } from "../shared/domain/content-addressing";
import { buildFullExportArchiveV9, buildFullExportArchiveV10 } from "../src/lib/exportAll";
import { acceptFabubloxImport, acceptedImportState, readAcceptedImport } from "./imports/fabublox-acceptance";
import worker from "./index";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const endpoint = "/api/exports/all?archiveSchema=10&archiveWriter=1";
const now = "2026-09-13T18:00:00.000Z";
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql"]) {
    database.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
  const d1 = new SqliteD1Database(database) as unknown as D1Database;
  database.prepare(`INSERT INTO storage_profiles VALUES ('accepted-profile', 'r2', 'r2:qualified-archive-bucket', 'bootstrap', NULL, 1, 'historical', ?)`).run(now);
  database.prepare(`INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES ('receipt-family', 'Receipt family', 'process', ?)`).run(now);
  database.prepare(`INSERT INTO template_versions (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at)
    VALUES ('receipt-template', 'receipt-family', 'Receipt template', 'process', 3, ?, '{}', ?)`).run("a".repeat(64), now);
  const bytes = new TextEncoder().encode("retained import workbook bytes");
  const provider = new Map<string, Uint8Array>([["archive/retained.xlsx", bytes], ["archive/manifest.json", new TextEncoder().encode("{}")]]);
  for (const [key, value] of provider) {
    database.prepare(`INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES (?, ?, ?, 'application/octet-stream', ?, 'ready', ?, ?)`).run(key, key, key.split("/").pop()!, value.length, sha256(value), now);
  }
  const input = stableJson({ schema: "fabublox-import-request/1",
    workbook: { sha256: sha256(bytes), byteSize: bytes.length, mimeType: "application/octet-stream", originalName: "retained.xlsx", purpose: "provenance" },
    manifest: { sha256: sha256("{}"), byteSize: 2, mimeType: "application/json", originalName: "manifest.json", purpose: "provenance" },
    images: [{ localId: "image-one", sha256: sha256("image"), byteSize: 5, mimeType: "image/png", originalName: "image.png", purpose: "embedded_content" }],
  });
  for (const [index, status] of ["pending", "failed", "ready"].entries()) {
    const id = `accepted-${status}`;
    const accepted = await acceptFabubloxImport(d1, {
      importId: id, operationId: `operation-${status}`, requestId: `00000000-0000-4000-8000-00000000000${index}`,
      requestSha256: sha256(input), requestInputJson: input, actorEmail: "archive@example.com",
      profileId: "accepted-profile", profileRevision: 1, policyRevision: 1,
      sourceFilename: "retained.xlsx", sourceSha256: sha256(bytes), sheetName: "Sheet1", templateType: "process",
      recipeFamilyId: "receipt-family", warningCount: 0, createdAt: now, leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(accepted.owned).toBe(true);
    if (status === "failed") database.prepare("UPDATE imports SET status = 'failed', lease_expires_at = NULL WHERE id = ?").run(id);
    if (status === "ready") {
      database.prepare("UPDATE imports SET template_version_id = 'receipt-template' WHERE id = ?").run(id);
      database.prepare(`UPDATE imports SET status = 'ready', completed_at = ?, finalization_id = 'receipt-finalization',
        lease_expires_at = NULL, workbook_asset_key = 'archive/retained.xlsx', manifest_asset_key = 'archive/manifest.json', accepted_result_json = ? WHERE id = ?`)
        .run(now, JSON.stringify({ id, templateVersionId: "receipt-template", version: 3 }), id);
    }
  }
  database.prepare(`INSERT INTO imports (id, status, source_filename, source_sha256, sheet_name, template_type, created_at)
    VALUES ('legacy-import', 'failed', 'old.xlsx', ?, 'Sheet1', 'process', ?)`).run("b".repeat(64), now);
  const read = vi.fn(async (key: string) => {
    const value = provider.get(key);
    return value ? { body: value, httpEtag: `"${sha256(value)}"`,
      writeHttpMetadata(headers: Headers) { headers.set("content-type", "application/octet-stream"); } } : null;
  });
  const env = { AUTH_MODE: "disabled", DB: d1, ASSETS: { get: read } as unknown as R2Bucket } satisfies Env;
  const request = (path: string) => worker.fetch(new Request(new URL(path, "https://app.test")), env, context);
  const fetcher = vi.fn((url: string | URL | Request) => request(typeof url === "string" ? url : url instanceof URL ? url.href : url.url)) as unknown as typeof fetch;
  return { database, d1, bytes, provider, read, request, fetcher,
    async manifest() { const response = await request(endpoint); expect(response.status, await response.clone().text()).toBe(200); return response.json() as Promise<FullExportManifestV10>; } };
}

describe("v10 durable import acceptance archive profile", () => {
  it("preserves the frozen V10 writer and restores populated legacy, pending, failed and ready receipts with exact bytes and restored write guards", async () => {
    const f = await fixture();
    const scratch = await mkdtemp(join(tmpdir(), "export-v10-"));
    try {
      // Current deletion is soft; the accepted result remains unchanged.
      f.database.prepare("UPDATE template_versions SET deleted_at = ?, deleted_by = 'archive@example.com' WHERE id = 'receipt-template'").run(now);
      vi.stubGlobal("fetch", f.fetcher);
      const manifest = await f.manifest();
      expect(manifest).toMatchObject({ schemaVersion: 10, archiveWriter: 1, archiveProfile: "fp1-import-acceptance" });
      expect(manifest.tables.imports).toHaveLength(4);
      expect(manifest.tables.storage_profiles).toHaveLength(1);
      for (const name of ["files", "file_locations", "legacy_file_mappings"]) expect(manifest.tables[name]).toEqual([]);
      const result = await buildFullExportArchiveV10(manifest, undefined, f.fetcher);
      expect(result.warnings).toEqual([]);
      const archiveBytes = Buffer.from(await result.archive.arrayBuffer());
      const zip = await JSZip.loadAsync(archiveBytes);
      const archived = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      const importBytes = await zip.file(archived.tables.imports.path)!.async("uint8array");
      expect(sha256(importBytes)).toBe(archived.tables.imports.sha256);
      expect(JSON.parse(new TextDecoder().decode(importBytes))).toEqual(manifest.tables.imports);
      const archivePath = join(scratch, "v10.zip");
      await writeFile(archivePath, archiveBytes);
      const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(scratch, "output"), migrationsDirectory, targetCompatibilitySchema: "S2" });
      expect(restored.report).toMatchObject({ schemaVersion: 10, archiveProfile: "fp1-import-acceptance", appliedForwardMigrations: [{ name: "0004_r2_upload_acceptance.sql" }], warnings: [],
        verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", schemaEqual: true } });
      const database = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
      try {
        expect(database.prepare("SELECT * FROM r2_upload_requests").all()).toEqual([]);
        expect(database.prepare("SELECT * FROM imports ORDER BY id").all()).toEqual(f.database.prepare("SELECT * FROM imports ORDER BY id").all());
        const row = await readAcceptedImport(new SqliteD1Database(database) as unknown as D1Database, "archive@example.com", "00000000-0000-4000-8000-000000000002");
        expect(acceptedImportState(row!)).toMatchObject({ status: "ready", result: { id: "accepted-ready", templateVersionId: "receipt-template", version: 3 } });
        expect(() => database.exec("UPDATE imports SET request_sha256 = 'changed' WHERE id = 'accepted-ready'")).toThrow();
        expect(() => database.exec("DELETE FROM imports WHERE id = 'accepted-ready'")).toThrow();
        expect(() => database.exec("INSERT INTO files (id, access_scope, state, created_at) VALUES ('illegal-ready', 'system', 'ready', '2026-09-13')")).toThrow();
      } finally { database.close(); }
      const providers = JSON.parse(await readFile(join(restored.restoredDirectory, "provider-manifest.json"), "utf8"));
      expect(providers).toHaveLength(2);
      for (const entry of providers) expect(await readFile(join(restored.restoredDirectory, entry.path))).toEqual(Buffer.from(f.provider.get(entry.objectKey)!));
      expect(await readFile(join(restored.restoredDirectory, "original-archive.zip"))).toEqual(archiveBytes);
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  });

  it("preserves an accepted historical receipt without requiring its original Template row", async () => {
    const f = await fixture();
    try {
      const manifest = await f.manifest();
      manifest.tables.template_versions = manifest.tables.template_versions.filter((row) => row.id !== "receipt-template");
      manifest.blobs = buildBlobExportPlan(manifest.tables);
      await expect(validateFullExportV10(manifest)).resolves.toEqual(manifest);
    } finally { f.database.close(); }
  });

  it("rejects older clients and profile relabeling before any provider download", async () => {
    const f = await fixture();
    try {
      for (const version of [8, 9]) {
        const response = await f.request(`/api/exports/all?archiveSchema=${version}&archiveWriter=1`);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: expect.stringContaining("Refresh the page") });
      }
      const manifest = await f.manifest();
      await expect(buildFullExportArchiveV9(manifest, undefined, f.fetcher)).rejects.toThrow("versions differ");
      await expect(validateFullExportV9({ ...manifest, schemaVersion: 9, archiveProfile: "fp1-legacy-overlap" })).rejects.toThrow("requires archive schema 10");
      await expect(validateFullExportV8({ ...manifest, schemaVersion: 8 })).rejects.toThrow("requires archive schema 10");
      expect(f.read).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each([
    ["partial decision", (row: ExportRow) => { row.storage_profile_id = null; }],
    ["profile mismatch", (row: ExportRow) => { row.storage_profile_id = "other-profile"; }],
    ["policy revision", (row: ExportRow) => { row.storage_policy_revision = 2; }],
    ["request hash", (row: ExportRow) => { row.request_sha256 = "0".repeat(64); }],
    ["source metadata", (row: ExportRow) => { row.source_filename = "different.xlsx"; }],
    ["missing receipt", (row: ExportRow) => { row.accepted_result_json = null; }],
    ["receipt identity", (row: ExportRow) => { row.accepted_result_json = JSON.stringify({ id: "other-import", templateVersionId: "receipt-template", version: 3 }); }],
    ["receipt Template identity", (row: ExportRow) => { row.accepted_result_json = JSON.stringify({ id: "accepted-ready", templateVersionId: "unrelated-template", version: 3 }); }],
    ["duplicate receipt member", (row: ExportRow) => { row.accepted_result_json = '{"id":"unrelated","id":"accepted-ready","templateVersionId":"receipt-template","version":3}'; }],
    ["unknown receipt field", (row: ExportRow) => { row.accepted_result_json = JSON.stringify({ id: "accepted-ready", templateVersionId: "receipt-template", version: 3, secret: "unexpected" }); }],
  ] as const)("rejects corrupted accepted operation before download: %s", async (_name, corrupt) => {
    const f = await fixture();
    try {
      const manifest = await f.manifest();
      corrupt(manifest.tables.imports.find((row) => row.id === "accepted-ready")!);
      manifest.blobs = buildBlobExportPlan(manifest.tables);
      await expect(buildFullExportArchiveV10(manifest, undefined, f.fetcher)).rejects.toThrow("invalid import acceptance");
      expect(f.read).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("rejects a rehashed secret-bearing or mismatched-purpose request envelope", async () => {
    const f = await fixture();
    try {
      for (const kind of ["secret", "purpose", "duplicate-image", "noncanonical"] as const) {
        const manifest = await f.manifest();
        const row = manifest.tables.imports.find((row) => row.id === "accepted-ready")!;
        const input = JSON.parse(String(row.request_input_json));
        if (kind === "secret") input.credential = "unexpected";
        if (kind === "purpose") input.workbook.purpose = "embedded_content";
        if (kind === "duplicate-image") input.images.push(input.images[0]);
        row.request_input_json = kind === "noncanonical" ? JSON.stringify(input, null, 2) : stableJson(input);
        row.request_sha256 = sha256(row.request_input_json);
        await expect(validateFullExportV10(manifest)).rejects.toThrow("invalid import acceptance");
      }
    } finally { f.database.close(); }
  });

  it("rejects acceptance columns under v9 even for empty imports and unknown new columns under v10", async () => {
    const f = await fixture();
    try {
      const manifest = await f.manifest();
      manifest.tables.imports = [];
      manifest.blobs = manifest.blobs.map((entry) => ({ ...entry }));
      await expect(validateFullExportV9({ ...manifest, schemaVersion: 9, archiveProfile: "fp1-legacy-overlap" })).rejects.toThrow("requires archive schema 10");
      const entry = manifest.artifacts.sourceSchema.value.objects.find((entry) => entry.type === "table" && entry.name === "imports")!;
      entry.sql = entry.sql!.replace("id TEXT PRIMARY KEY,", "id TEXT PRIMARY KEY, future_secret TEXT,");
      manifest.artifacts.sourceSchema = await createExportArtifact(EXPORT_SOURCE_SCHEMA_PATH, manifest.artifacts.sourceSchema.value);
      await expect(validateFullExportV10(manifest)).rejects.toThrow("schema columns differ");
      expect(IMPORT_ACCEPTANCE_EXPORT_COLUMNS).toHaveLength(8);
    } finally { f.database.close(); }
  });

  it.each(["missing", "different-template", "duplicate-member"])("rejects a %s receipt even if the table hash was updated and removes the private restore destination", async (kind) => {
    const f = await fixture();
    const scratch = await mkdtemp(join(tmpdir(), "export-v10-invalid-"));
    try {
      const result = await buildFullExportArchiveV10(await f.manifest(), undefined, f.fetcher);
      const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
      const manifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      const imports = JSON.parse(await zip.file(manifest.tables.imports.path)!.async("string"));
      imports.find((row: ExportRow) => row.id === "accepted-ready").accepted_result_json = kind === "missing" ? null
        : kind === "different-template" ? JSON.stringify({ id: "accepted-ready", templateVersionId: "unrelated-template", version: 3 })
        : '{"id":"unrelated","id":"accepted-ready","templateVersionId":"receipt-template","version":3}';
      const artifact = await createExportArtifact(manifest.tables.imports.path, imports);
      zip.file(artifact.path, `${stableJson(imports)}\n`);
      manifest.tables.imports.sha256 = artifact.sha256;
      manifest.tables.imports.byteSize = artifact.byteSize;
      zip.file("export-manifest.json", JSON.stringify(manifest));
      const archivePath = join(scratch, "invalid.zip"), destination = join(scratch, "output");
      await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      await expect(restoreExportToIsolatedDirectory({ archivePath, destination, migrationsDirectory, targetCompatibilitySchema: "S2" })).rejects.toThrow("invalid import acceptance");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  });
});
