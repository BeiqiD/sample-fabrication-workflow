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
import type { ExportRow, FullExportManifestV11 } from "../shared/contracts/export";
import { createExportArtifact, EXPORT_SOURCE_SCHEMA_PATH, validateFullExportV10, validateFullExportV11 } from "../shared/contracts/export-protocol";
import { canonicalR2UploadInput } from "../shared/contracts/r2-upload";
import { stableJson } from "../shared/domain/content-addressing";
import { buildFullExportArchiveV10, buildFullExportArchiveV11 } from "../src/lib/exportAll";
import worker from "./index";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const endpoint = "/api/exports/all?archiveSchema=11&archiveWriter=1";
const now = "2026-08-01T00:00:00.000Z", tomorrow = "2026-08-02T00:00:00.000Z";
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql", "0004_r2_upload_acceptance.sql"]) {
    database.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
  database.prepare("INSERT INTO storage_profiles VALUES ('upload-profile', 'r2', 'r2:historical-upload-bucket', 'bootstrap', NULL, 1, 'historical', ?)").run(now);
  const bytes = new TextEncoder().encode("historically accepted upload bytes");
  const provider = new Map<string, Uint8Array>();
  for (const [index, status] of ["pending", "failed", "ready", "deduplicated", "collected"].entries()) {
    const candidate = id(index * 10 + 4), key = `accepted/${candidate}`;
    const uploadedBytes = status === "collected" ? new TextEncoder().encode("collected historical upload bytes") : bytes;
    const input = await canonicalR2UploadInput("ordinary_image", { originalName: "accepted.png", mimeType: "image/png", byteSize: uploadedBytes.length, sha256: hash(uploadedBytes) });
    database.prepare(`INSERT INTO r2_upload_requests (id, actor_email, client_request_id, operation_id, ingress, purpose,
      request_sha256, request_input_json, request_scope, storage_profile_id, storage_profile_revision, storage_policy_revision,
      candidate_asset_id, candidate_object_key, status, accepted_result_json, created_at, completed_at, expires_at)
      VALUES (?, 'archive@example.com', ?, ?, 'ordinary_image', 'embedded_content', ?, ?, 'system', 'upload-profile', 1, 1,
        ?, ?, 'pending', NULL, ?, NULL, ?)`)
      .run(id(index * 10 + 1), id(index * 10 + 2), id(index * 10 + 3), input.sha256, input.json, candidate, key, now, tomorrow);
    if (status === "pending") continue;
    if (status === "failed") {
      database.prepare("UPDATE r2_upload_requests SET status = 'failed', completed_at = ? WHERE id = ?").run(now, id(index * 10 + 1));
      continue;
    }
    if (status !== "deduplicated") {
      database.prepare(`INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
        VALUES (?, ?, 'accepted.png', 'image/png', ?, 'ready', ?, ?)`)
        .run(candidate, key, uploadedBytes.length, hash(uploadedBytes), now);
      provider.set(key, uploadedBytes);
    }
    const result = status === "deduplicated" ? { id: id(24), key: `accepted/${id(24)}`, deduplicated: true }
      : { id: candidate, key, deduplicated: false };
    database.prepare("UPDATE r2_upload_requests SET status = 'ready', accepted_result_json = ?, completed_at = ? WHERE id = ?")
      .run(JSON.stringify(result), now, id(index * 10 + 1));
    if (status === "collected") {
      database.prepare("DELETE FROM assets WHERE id = ?").run(candidate);
      provider.delete(key);
    }
  }
  const read = vi.fn(async (key: string) => {
    const value = provider.get(key);
    return value ? { body: value, httpEtag: `"${hash(value)}"`, writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); } } : null;
  });
  const env = { AUTH_MODE: "disabled", DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: { get: read } as unknown as R2Bucket } satisfies Env;
  const request = (path: string) => worker.fetch(new Request(new URL(path, "https://app.test")), env, context);
  const fetcher = vi.fn((url: string | URL | Request) => request(typeof url === "string" ? url : url instanceof URL ? url.href : url.url)) as unknown as typeof fetch;
  return { database, provider, read, request, fetcher,
    async manifest() { const response = await request(endpoint); expect(response.status, await response.clone().text()).toBe(200); return response.json() as Promise<FullExportManifestV11>; } };
}

describe("v11 durable R2 upload acceptance archive profile", () => {
  it("preserves the frozen V11 writer and restores pending, failed, ready, deduplicated and collected historical receipts without new byte roots", async () => {
    const f = await fixture(), scratch = await mkdtemp(join(tmpdir(), "export-v11-"));
    try {
      vi.stubGlobal("fetch", f.fetcher);
      const manifest = await f.manifest();
      expect(manifest).toMatchObject({ schemaVersion: 11, archiveWriter: 1, archiveProfile: "fp1-r2-upload-acceptance" });
      expect(manifest.tables.r2_upload_requests).toHaveLength(5);
      expect(manifest.blobs).toHaveLength(1);
      expect(manifest.tables.blob_retention_edges).toEqual([]);
      expect(manifest.blobs[0].objectKey).toBe(`accepted/${id(24)}`);
      const archive = await buildFullExportArchiveV11(manifest, undefined, f.fetcher);
      expect(archive.warnings).toEqual([]);
      const archivePath = join(scratch, "v11.zip");
      await writeFile(archivePath, Buffer.from(await archive.archive.arrayBuffer()));
      const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(scratch, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
      expect(restored.report).toMatchObject({ schemaVersion: 11, archiveProfile: "fp1-r2-upload-acceptance", appliedForwardMigrations: [{ name: "0005_metrology_reference_acceptance.sql" }, { name: "0006_comment_acceptance.sql" }], warnings: [],
        verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", schemaEqual: true } });
      const database = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
      try {
        expect(database.prepare("SELECT * FROM metrology_reference_upload_requests").all()).toEqual([]);
        expect(database.prepare("SELECT * FROM r2_upload_requests ORDER BY id").all())
          .toEqual(f.database.prepare("SELECT * FROM r2_upload_requests ORDER BY id").all());
        expect(() => database.prepare("UPDATE r2_upload_requests SET accepted_result_json = '{}' WHERE id = ?").run(id(21))).toThrow();
        expect(() => database.prepare("DELETE FROM r2_upload_requests WHERE id = ?").run(id(21))).toThrow();
        expect(() => database.exec("INSERT INTO files (id, access_scope, state, created_at) VALUES ('illegal-ready', 'system', 'ready', '2026-09-14')")).toThrow();
      } finally { database.close(); }
      expect(JSON.parse(await readFile(join(restored.restoredDirectory, "provider-manifest.json"), "utf8"))).toHaveLength(1);
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  }, 15_000);

  it("rejects older clients and profile relabeling before provider downloads, even for an empty receipt table", async () => {
    const f = await fixture();
    try {
      for (const version of [8, 9, 10]) expect((await f.request(`/api/exports/all?archiveSchema=${version}&archiveWriter=1`)).status).toBe(409);
      const manifest = await f.manifest();
      await expect(buildFullExportArchiveV10(manifest, undefined, f.fetcher)).rejects.toThrow("versions differ");
      manifest.tables.r2_upload_requests = [];
      await expect(validateFullExportV10({ ...manifest, schemaVersion: 10, archiveProfile: "fp1-import-acceptance" })).rejects.toThrow("requires archive schema 11");
      const entry = manifest.artifacts.sourceSchema.value.objects.find((entry) => entry.type === "table" && entry.name === "r2_upload_requests")!;
      entry.sql = entry.sql!.replace("id TEXT PRIMARY KEY NOT NULL,", "id TEXT PRIMARY KEY NOT NULL, future_secret TEXT,");
      manifest.artifacts.sourceSchema = await createExportArtifact(EXPORT_SOURCE_SCHEMA_PATH, manifest.artifacts.sourceSchema.value);
      await expect(validateFullExportV11(manifest)).rejects.toThrow("schema columns differ");
      expect(f.read).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each([
    ["actor identity", (row: ExportRow) => { row.actor_email = ""; }],
    ["request identity", (row: ExportRow) => { row.client_request_id = "not-a-request"; }],
    ["profile revision", (row: ExportRow) => { row.storage_profile_revision = 2; }],
    ["purpose", (row: ExportRow) => { row.purpose = "research_source"; }],
    ["request hash", (row: ExportRow) => { row.request_sha256 = "0".repeat(64); }],
    ["receipt lifetime", (row: ExportRow) => { row.expires_at = "2026-08-03T00:00:00.000Z"; }],
    ["completion after expiry", (row: ExportRow) => { row.completed_at = tomorrow; }],
    ["missing receipt", (row: ExportRow) => { row.accepted_result_json = null; }],
    ["candidate identity", (row: ExportRow) => { row.accepted_result_json = JSON.stringify({ id: id(24), key: "unrelated", deduplicated: false }); }],
    ["nonboolean receipt", (row: ExportRow) => { row.accepted_result_json = JSON.stringify({ id: id(24), key: `accepted/${id(24)}`, deduplicated: 1 }); }],
    ["duplicate receipt member", (row: ExportRow) => { row.accepted_result_json = `{"id":"unrelated","id":"${id(24)}","key":"accepted/${id(24)}","deduplicated":false}`; }],
  ] as const)("rejects corrupted acceptance before byte download: %s", async (_name, corrupt) => {
    const f = await fixture();
    try {
      const manifest = await f.manifest();
      corrupt(manifest.tables.r2_upload_requests.find((row) => row.id === id(21))!);
      await expect(buildFullExportArchiveV11(manifest, undefined, f.fetcher)).rejects.toThrow("invalid R2 upload acceptance");
      expect(f.read).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each(["secret", "purpose", "noncanonical", "duplicate-input"])("rejects a rehashed %s request input", async (kind) => {
    const f = await fixture();
    try {
      const manifest = await f.manifest(), row = manifest.tables.r2_upload_requests[0];
      const input = JSON.parse(String(row.request_input_json));
      if (kind === "secret") input.credential = "unexpected";
      if (kind === "purpose") input.purpose = "research_source";
      row.request_input_json = kind === "noncanonical" ? JSON.stringify(input, null, 2) : kind === "duplicate-input"
        ? stableJson(input).replace('"scope":"system"', '"scope":"system","scope":"system"') : stableJson(input);
      row.request_sha256 = hash(row.request_input_json);
      await expect(validateFullExportV11(manifest)).rejects.toThrow("invalid R2 upload acceptance");
    } finally { f.database.close(); }
  });

  it("rejects a corrupted receipt after table rehash and removes its private restore destination", async () => {
    const f = await fixture(), scratch = await mkdtemp(join(tmpdir(), "export-v11-invalid-"));
    try {
      const archive = await buildFullExportArchiveV11(await f.manifest(), undefined, f.fetcher);
      const zip = await JSZip.loadAsync(await archive.archive.arrayBuffer());
      const manifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      const rows = JSON.parse(await zip.file(manifest.tables.r2_upload_requests.path)!.async("string"));
      rows.find((row: ExportRow) => row.id === id(21)).accepted_result_json = null;
      const artifact = await createExportArtifact(manifest.tables.r2_upload_requests.path, rows);
      zip.file(artifact.path, `${stableJson(rows)}\n`);
      Object.assign(manifest.tables.r2_upload_requests, { sha256: artifact.sha256, byteSize: artifact.byteSize });
      zip.file("export-manifest.json", JSON.stringify(manifest));
      const archivePath = join(scratch, "invalid.zip"), destination = join(scratch, "restored");
      await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      await expect(restoreExportToIsolatedDirectory({ archivePath, destination, migrationsDirectory, targetCompatibilitySchema: "S2" })).rejects.toThrow("invalid R2 upload acceptance");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  }, 15_000);
});
