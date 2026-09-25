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
import type { ExportRow, FullExportManifestV12 } from "../shared/contracts/export";
import { createExportArtifact, EXPORT_SOURCE_SCHEMA_PATH, validateFullExportV11, validateFullExportV12 } from "../shared/contracts/export-protocol";
import { canonicalMetrologyReferenceUploadInput, type MetrologyReferencePublicationPlan } from "../shared/contracts/metrology-reference-upload";
import { buildBlobExportPlan } from "../shared/contracts/export-blob-plan";
import { stableJson } from "../shared/domain/content-addressing";
import { buildFullExportArchiveV11, buildFullExportArchiveV12 } from "../src/lib/exportAll";
import worker from "./index";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const endpoint = "/api/exports/all?archiveSchema=12&archiveWriter=1";
const now = "2026-08-01T00:00:00.000Z", tomorrow = "2026-08-02T00:00:00.000Z", previous = "2026-07-01T00:00:00.000Z";
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql", "0004_r2_upload_acceptance.sql", "0005_metrology_reference_acceptance.sql"]) {
    database.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
  database.prepare("INSERT INTO storage_profiles VALUES ('metrology-profile', 'r2', 'r2:historical-metrology-bucket', 'bootstrap', NULL, 1, 'historical', ?)").run(now);
  database.prepare("INSERT INTO recipe_families (id, name, template_type, created_at) VALUES ('family', 'Metrology family', 'module', ?)").run(previous);
  database.prepare(`INSERT INTO template_versions (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at, template_kind)
    VALUES ('template', 'family', 'Metrology', 'module', 1, 'manifest', '{}', ?, 'metrology')`).run(previous);
  const provider = new Map<string, Uint8Array>();
  for (const [index, status] of ["pending", "failed", "created", "reused", "restored", "deleted"].entries()) {
    const candidate = id(index * 10 + 4), candidateReference = id(index * 10 + 5), key = `metrology/${candidate}`;
    const bytes = new TextEncoder().encode(`historically accepted ${status} metrology bytes`);
    const input = await canonicalMetrologyReferenceUploadInput("template", { originalName: "accepted.pdf", mimeType: "application/pdf", byteSize: bytes.length, sha256: hash(bytes) });
    const action = status === "reused" ? "reuse" : status === "restored" ? "restore" : "create";
    const referenceId = action === "create" ? candidateReference : `historical-${status}`;
    let plan: MetrologyReferencePublicationPlan = { schema: "metrology-reference-publication/1", action: "create", reference: null };
    const addAsset = () => {
      database.prepare(`INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
        VALUES (?, ?, 'accepted.pdf', 'application/pdf', ?, 'ready', ?, ?)`).run(candidate, key, bytes.length, hash(bytes), now);
      provider.set(key, bytes);
    };
    if (action !== "create") {
      addAsset();
      const deletedAt = action === "restore" ? previous : null;
      const deletedBy = action === "restore" ? "archive@example.com" : null;
      database.prepare(`INSERT INTO metrology_template_references (id, template_version_id, asset_id, display_name, position, actor_email, created_at, deleted_at, deleted_by)
        VALUES (?, 'template', ?, 'historical-name.pdf', ?, 'archive@example.com', ?, ?, ?)`)
        .run(referenceId, candidate, index, previous, deletedAt, deletedBy);
      plan = { schema: "metrology-reference-publication/1", action, reference: { id: referenceId, assetId: candidate,
        filename: "historical-name.pdf", position: index, actorEmail: "archive@example.com", createdAt: previous, deletedAt, deletedBy } };
    }
    database.prepare(`INSERT INTO metrology_reference_upload_requests (id, actor_email, client_request_id, operation_id,
      template_version_id, candidate_reference_id, publication_plan_json, ingress, purpose, request_sha256, request_input_json,
      request_scope, storage_profile_id, storage_profile_revision, storage_policy_revision, candidate_asset_id, candidate_object_key,
      status, accepted_result_json, created_at, completed_at, expires_at)
      VALUES (?, 'archive@example.com', ?, ?, 'template', ?, ?, 'metrology_reference', 'research_source', ?, ?,
        'system', 'metrology-profile', 1, 1, ?, ?, 'pending', NULL, ?, NULL, ?)`)
      .run(id(index * 10 + 1), id(index * 10 + 2), id(index * 10 + 3), candidateReference, stableJson(plan), input.sha256, input.json, candidate, key, now, tomorrow);
    if (status === "pending") continue;
    if (status === "failed") {
      database.prepare("UPDATE metrology_reference_upload_requests SET status = 'failed', completed_at = ? WHERE id = ?").run(now, id(index * 10 + 1));
      continue;
    }
    if (action === "create") {
      addAsset();
      database.prepare(`INSERT INTO metrology_template_references (id, template_version_id, asset_id, display_name, position, actor_email, created_at)
        VALUES (?, 'template', ?, 'accepted.pdf', ?, 'archive@example.com', ?)`).run(referenceId, candidate, index, now);
    } else if (action === "restore") {
      database.prepare("UPDATE metrology_template_references SET display_name = 'accepted.pdf', deleted_at = NULL, deleted_by = NULL WHERE id = ?").run(referenceId);
    }
    const result = { assetId: candidate, deduplicated: action !== "create", reference: { id: referenceId,
      filename: action === "reuse" ? "historical-name.pdf" : "accepted.pdf", mimeType: "application/pdf", byteSize: bytes.length,
      assetKey: key, createdAt: action === "create" ? now : previous } };
    database.prepare("UPDATE metrology_reference_upload_requests SET status = 'ready', accepted_result_json = ?, completed_at = ? WHERE id = ?")
      .run(JSON.stringify(result), now, id(index * 10 + 1));
    if (status === "deleted") {
      database.prepare("UPDATE metrology_template_references SET deleted_at = ?, deleted_by = 'archive@example.com' WHERE id = ?").run(now, referenceId);
    }
  }
  const read = vi.fn(async (key: string) => {
    const value = provider.get(key);
    return value ? { body: value, httpEtag: `"${hash(value)}"`, writeHttpMetadata(headers: Headers) { headers.set("content-type", "application/pdf"); } } : null;
  });
  const env = { AUTH_MODE: "disabled", DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: { get: read } as unknown as R2Bucket } satisfies Env;
  const request = (path: string) => worker.fetch(new Request(new URL(path, "https://app.test")), env, context);
  const fetcher = vi.fn((url: string | URL | Request) => request(typeof url === "string" ? url : url instanceof URL ? url.href : url.url)) as unknown as typeof fetch;
  return { database, provider, read, request, fetcher,
    async manifest() { const response = await request(endpoint); expect(response.status, await response.clone().text()).toBe(200); return response.json() as Promise<FullExportManifestV12>; } };
}

describe("v12 metrology reference business acceptance archive profile", () => {
  it("preserves the frozen V12 writer and restores every terminal and pending decision with historical occurrence evidence and unchanged byte roots", async () => {
    const f = await fixture(), scratch = await mkdtemp(join(tmpdir(), "export-v12-"));
    try {
      // Deleting a Template after publication must not invalidate its receipts.
      f.database.prepare("UPDATE template_versions SET deleted_at = ?, deleted_by = 'archive@example.com' WHERE id = 'template'").run(now);
      vi.stubGlobal("fetch", f.fetcher);
      const manifest = await f.manifest();
      expect(manifest).toMatchObject({ schemaVersion: 12, archiveWriter: 1, archiveProfile: "fp1-metrology-reference-acceptance" });
      expect(manifest.tables.metrology_reference_upload_requests).toHaveLength(6);
      expect(manifest.tables.r2_upload_requests).toEqual([]);
      expect(manifest.blobs).toHaveLength(4);
      expect(manifest.tables.blob_retention_edges.every((row) => !String(row.source_type).includes("upload"))).toBe(true);
      const archive = await buildFullExportArchiveV12(manifest, undefined, f.fetcher);
      expect(archive.warnings).toEqual([]);
      const archivePath = join(scratch, "v12.zip");
      await writeFile(archivePath, Buffer.from(await archive.archive.arrayBuffer()));
      const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(scratch, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
      expect(restored.report).toMatchObject({ schemaVersion: 12, archiveProfile: "fp1-metrology-reference-acceptance", appliedForwardMigrations: [{ name: "0006_comment_acceptance.sql" }, { name: "0007_fp1_file_authority_transition.sql" }], warnings: [],
        verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", schemaEqual: true } });
      const database = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
      try {
        expect(database.prepare("SELECT * FROM comment_submission_acceptances").all()).toEqual([]);
        expect(database.prepare("SELECT * FROM comment_item_acceptances").all()).toEqual([]);
        expect(database.prepare("SELECT * FROM metrology_reference_upload_requests ORDER BY id").all())
          .toEqual(f.database.prepare("SELECT * FROM metrology_reference_upload_requests ORDER BY id").all());
        expect(() => database.prepare("UPDATE metrology_reference_upload_requests SET accepted_result_json = '{}' WHERE id = ?").run(id(21))).toThrow();
        expect(() => database.prepare("DELETE FROM metrology_reference_upload_requests WHERE id = ?").run(id(21))).toThrow();
        expect(() => database.exec("INSERT INTO files (id, access_scope, state, created_at) VALUES ('illegal-ready', 'system', 'ready', '2026-09-14')")).toThrow();
      } finally { database.close(); }
      const providers = JSON.parse(await readFile(join(restored.restoredDirectory, "provider-manifest.json"), "utf8"));
      expect(providers).toHaveLength(4);
      for (const entry of providers) expect(await readFile(join(restored.restoredDirectory, entry.path))).toEqual(Buffer.from(f.provider.get(entry.objectKey)!));
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  }, 15_000);

  it("preserves historical acceptance without requiring the original Template, occurrence or asset rows", async () => {
    const f = await fixture();
    try {
      const manifest = await f.manifest();
      manifest.tables.metrology_template_references = [];
      manifest.tables.assets = [];
      manifest.tables.template_versions = [];
      manifest.tables.blob_retention_edges = [];
      manifest.blobs = buildBlobExportPlan(manifest.tables);
      await expect(validateFullExportV12(manifest)).resolves.toEqual(manifest);
      expect(manifest.blobs).toEqual([]);
    } finally { f.database.close(); }
  });

  it("rejects old clients and relabeling even with no metrology receipts, before downloads", async () => {
    const f = await fixture();
    try {
      for (const version of [8, 9, 10, 11, 13, 14]) expect((await f.request(`/api/exports/all?archiveSchema=${version}&archiveWriter=1`)).status).toBe(409);
      const manifest = await f.manifest();
      await expect(buildFullExportArchiveV11(manifest, undefined, f.fetcher)).rejects.toThrow("versions differ");
      manifest.tables.metrology_reference_upload_requests = [];
      await expect(validateFullExportV11({ ...manifest, schemaVersion: 11, archiveProfile: "fp1-r2-upload-acceptance" })).rejects.toThrow("requires archive schema 12");
      const entry = manifest.artifacts.sourceSchema.value.objects.find((entry) => entry.type === "table" && entry.name === "metrology_reference_upload_requests")!;
      entry.sql = entry.sql!.replace("id TEXT PRIMARY KEY NOT NULL,", "id TEXT PRIMARY KEY NOT NULL, future_secret TEXT,");
      manifest.artifacts.sourceSchema = await createExportArtifact(EXPORT_SOURCE_SCHEMA_PATH, manifest.artifacts.sourceSchema.value);
      await expect(validateFullExportV12(manifest)).rejects.toThrow("schema columns differ");
      expect(f.read).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each([
    ["actor", (row: ExportRow) => { row.actor_email = ""; }],
    ["request identity", (row: ExportRow) => { row.client_request_id = "invalid"; }],
    ["candidate reference", (row: ExportRow) => { row.candidate_reference_id = "invalid"; }],
    ["Template input", (row: ExportRow) => { row.template_version_id = "other-template"; }],
    ["profile", (row: ExportRow) => { row.storage_profile_revision = 2; }],
    ["purpose", (row: ExportRow) => { row.purpose = "embedded_content"; }],
    ["request hash", (row: ExportRow) => { row.request_sha256 = "0".repeat(64); }],
    ["lifetime", (row: ExportRow) => { row.expires_at = "2026-08-03T00:00:00.000Z"; }],
    ["late completion", (row: ExportRow) => { row.completed_at = tomorrow; }],
    ["missing result", (row: ExportRow) => { row.accepted_result_json = null; }],
    ["new filename", (row: ExportRow) => { const result = JSON.parse(String(row.accepted_result_json)); result.reference.filename = "changed.pdf"; row.accepted_result_json = JSON.stringify(result); }],
    ["new created time", (row: ExportRow) => { const result = JSON.parse(String(row.accepted_result_json)); result.reference.createdAt = previous; row.accepted_result_json = JSON.stringify(result); }],
    ["candidate asset", (row: ExportRow) => { const result = JSON.parse(String(row.accepted_result_json)); result.assetId = "other-asset"; row.accepted_result_json = JSON.stringify(result); }],
    ["result bytes", (row: ExportRow) => { const result = JSON.parse(String(row.accepted_result_json)); result.reference.byteSize++; row.accepted_result_json = JSON.stringify(result); }],
    ["duplicate result member", (row: ExportRow) => { row.accepted_result_json = String(row.accepted_result_json).replace('"filename":"accepted.pdf"', '"filename":"hidden","filename":"accepted.pdf"'); }],
    ["noncanonical plan", (row: ExportRow) => { row.publication_plan_json = JSON.stringify(JSON.parse(String(row.publication_plan_json)), null, 2); }],
  ] as const)("rejects corrupted receipt %s before byte download", async (_name, corrupt) => {
    const f = await fixture();
    try {
      const manifest = await f.manifest();
      corrupt(manifest.tables.metrology_reference_upload_requests.find((row) => row.id === id(21))!);
      await expect(buildFullExportArchiveV12(manifest, undefined, f.fetcher)).rejects.toThrow("invalid metrology reference acceptance");
      expect(f.read).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each(["secret", "purpose", "Template", "noncanonical", "duplicate-input", "oversized-file", "duplicate-plan"])("rejects a rehashed %s input or publication plan", async (kind) => {
    const f = await fixture();
    try {
      const manifest = await f.manifest(), row = manifest.tables.metrology_reference_upload_requests[0];
      const input = JSON.parse(String(row.request_input_json));
      if (kind === "secret") input.credential = "unexpected";
      if (kind === "purpose") input.purpose = "embedded_content";
      if (kind === "Template") input.templateId = "other-template";
      if (kind === "oversized-file") input.file.byteSize = 25 * 1024 * 1024 + 1;
      row.request_input_json = kind === "noncanonical" ? JSON.stringify(input, null, 2) : kind === "duplicate-input"
        ? stableJson(input).replace('"scope":"system"', '"scope":"system","scope":"system"') : stableJson(input);
      row.request_sha256 = hash(row.request_input_json);
      if (kind === "duplicate-plan") row.publication_plan_json = String(row.publication_plan_json).replace('"action":"create"', '"action":"create","action":"create"');
      await expect(validateFullExportV12(manifest)).rejects.toThrow("invalid metrology reference acceptance");
    } finally { f.database.close(); }
  });

  it("rejects changed frozen reuse and restore identities while preserving their different filename rules", async () => {
    const f = await fixture();
    try {
      for (const [receiptId, field] of [[id(31), "id"], [id(31), "filename"], [id(41), "createdAt"]]) {
        const manifest = await f.manifest(), row = manifest.tables.metrology_reference_upload_requests.find((row) => row.id === receiptId)!;
        const result = JSON.parse(String(row.accepted_result_json));
        result.reference[field] = field === "createdAt" ? now : "changed";
        row.accepted_result_json = JSON.stringify(result);
        await expect(validateFullExportV12(manifest)).rejects.toThrow("invalid metrology reference acceptance");
      }
    } finally { f.database.close(); }
  });

  it("rejects a rehashed corrupt receipt and removes the private restore destination", async () => {
    const f = await fixture(), scratch = await mkdtemp(join(tmpdir(), "export-v12-invalid-"));
    try {
      const archive = await buildFullExportArchiveV12(await f.manifest(), undefined, f.fetcher);
      const zip = await JSZip.loadAsync(await archive.archive.arrayBuffer());
      const manifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      const descriptor = manifest.tables.metrology_reference_upload_requests;
      const rows = JSON.parse(await zip.file(descriptor.path)!.async("string"));
      rows.find((row: ExportRow) => row.id === id(21)).accepted_result_json = null;
      const artifact = await createExportArtifact(descriptor.path, rows);
      zip.file(artifact.path, `${stableJson(rows)}\n`);
      Object.assign(descriptor, { sha256: artifact.sha256, byteSize: artifact.byteSize });
      zip.file("export-manifest.json", JSON.stringify(manifest));
      const archivePath = join(scratch, "invalid.zip"), destination = join(scratch, "restored");
      await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      await expect(restoreExportToIsolatedDirectory({ archivePath, destination, migrationsDirectory, targetCompatibilitySchema: "S2" })).rejects.toThrow("invalid metrology reference acceptance");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  }, 15_000);
});
