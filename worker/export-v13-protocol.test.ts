import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import type { ExportRow, FullExportManifestV13 } from "../shared/contracts/export";
import { createExportArtifact, EXPORT_SOURCE_SCHEMA_PATH, validateFullExportV12, validateFullExportV13 } from "../shared/contracts/export-protocol";
import { canonicalCommentAcceptanceInput } from "../shared/contracts/comment-acceptance";
import { buildBlobExportPlan } from "../shared/contracts/export-blob-plan";
import { stableJson } from "../shared/domain/content-addressing";
import { buildFullExportArchiveV12, buildFullExportArchiveV13 } from "../src/lib/exportAll";
import worker from "./index";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const endpoint = "/api/exports/all?archiveSchema=13&archiveWriter=1";
const previous = "2026-08-01T00:00:00.000Z";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const namespace = JSON.stringify({ kind: "local-r2", installationId: "6d2b3589-cff4-4a2e-af5a-8f285792b129", bucketName: "archive-comments" });
afterEach(() => vi.unstubAllGlobals());

async function fixture(full = false) {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql", "0004_r2_upload_acceptance.sql", "0005_metrology_reference_acceptance.sql", "0006_comment_acceptance.sql"]) {
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`INSERT INTO samples (id, code, title, created_at, updated_at) VALUES ('archive-sample', 'ARCHIVE-COMMENT', 'Archive Comment', '${previous}', '${previous}');
    INSERT INTO recipe_families (id, name, template_type, created_at) VALUES ('archive-family', 'Archive family', 'process', '${previous}');
    INSERT INTO template_versions (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at, template_kind)
      VALUES ('archive-template', 'archive-family', 'Archive process', 'process', 1, '${hash("template")}', '{}', '${previous}', 'process');
    INSERT INTO runs (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id, template_name_snapshot, template_type_snapshot,
      template_version_snapshot, status, created_at, run_kind)
      VALUES ('archive-run', 'archive-sample', 'archive-family', 'archive-template', 1, 'archive-run-group', 'Archive process', 'process', 1, 'active', '${previous}', 'process');
    INSERT INTO run_steps (id, run_id, position, origin, plan_status, title, status, entry_kind, created_at, updated_at)
      VALUES ('archive-step-0', 'archive-run', 0, 'ad_hoc', 'current', 'Step one', 'pending', 'fabrication', '${previous}', '${previous}'),
        ('archive-step-1', 'archive-run', 1, 'ad_hoc', 'current', 'Step two', 'pending', 'fabrication', '${previous}', '${previous}');
    INSERT INTO comment_submissions (id, context_kind, sample_id, body, status, actor_email, created_at, updated_at, completed_at)
      VALUES ('historical-comment', 'sample', 'archive-sample', 'Historical canonical Comment', 'ready', 'historical@example.com', '${previous}', '${previous}', '${previous}');`);
  const provider = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: ReadableStream | ArrayBuffer) => { provider.set(key, new Uint8Array(await new Response(value).arrayBuffer())); });
  const object = (value: Uint8Array) => ({ body: new Blob([value]).stream(), size: value.length, httpEtag: `"${hash(value)}"`,
    writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); } });
  const read = vi.fn(async (key: string) => { const value = provider.get(key); return value ? object(value) : null; });
  const env = { AUTH_MODE: "disabled", DB: new SqliteD1Database(database) as unknown as D1Database, R2_BOOTSTRAP_NAMESPACE: namespace,
    ASSETS: { get: read, head: read, put } as unknown as R2Bucket } satisfies Env;
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(new URL(path, "https://app.test"), init), env, context);
  const json = async (path: string, body?: unknown, method = "POST") => {
    const response = await request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(200);
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json();
  };
  for (const state of full ? ["pending", "cancelled", "uploaded", "ready", "deleted", "common-single", "common-multiple"] : ["ready"]) {
    const id = `archive-comment-${state}`, itemId = `archive-image-${state}`, bytes = new TextEncoder().encode(`accepted Comment ${state} bytes`);
    const targets = state.startsWith("common") ? (state === "common-single" ? [0] : [0, 1]).map((i) => ({ sampleId: "archive-sample", runId: "archive-run", stepId: `archive-step-${i}`,
      expectedUpdatedAt: String(database.prepare("SELECT updated_at FROM run_steps WHERE id = ?").get(`archive-step-${i}`)!.updated_at) })) : [];
    const input = await canonicalCommentAcceptanceInput({ protocol: "comment-submission/1", id, body: `Accepted ${state} Comment`,
      context: targets.length ? { kind: "run_steps", scope: "common", targets } : { kind: "sample", sampleId: "archive-sample",
        expectedUpdatedAt: String(database.prepare("SELECT updated_at FROM samples WHERE id = 'archive-sample'").get()!.updated_at) },
      items: targets.length ? [] : [{ id: itemId, kind: "comment_image", filename: "accepted.png", mimeType: "image/png", byteSize: bytes.length,
        originalFilename: "accepted.png", originalMimeType: "image/png", originalByteSize: bytes.length, sha256: hash(bytes) },
      { id: `archive-link-${state}`, kind: "link", url: "https://example.com/reference", title: "Reference", description: "Historical link description" }] });
    await json("/api/comment-submissions", input.input);
    if (state === "pending") continue;
    if (state === "cancelled") { await json(`/api/comment-submissions/${id}/cancel`); continue; }
    if (!targets.length) {
      const uploaded = await request(`/api/comment-submissions/${id}/items/${itemId}/content`, { method: "PUT", body: bytes,
        headers: { "content-type": "image/png", "x-upload-size": String(bytes.length), "x-content-sha256": hash(bytes) } });
      expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    }
    if (state === "uploaded") continue;
    await json(`/api/comment-submissions/${id}/finalize`);
    if (state === "deleted") database.prepare("UPDATE comment_submissions SET deleted_at = ?, deleted_by = 'archive@example.com' WHERE id = ?").run(new Date().toISOString(), id);
  }
  const fetcher = vi.fn((url: string | URL | Request) => request(typeof url === "string" ? url : url instanceof URL ? url.href : url.url)) as unknown as typeof fetch;
  read.mockClear(); put.mockClear();
  return { database, provider, read, put, request, fetcher,
    async manifest() { const response = await request(endpoint); expect(response.status, await response.clone().text()).toBe(200); return response.json() as Promise<FullExportManifestV13>; } };
}
async function roundtrip(manifest: FullExportManifestV13, fetcher: typeof fetch, scratch: string) {
  const archive = await buildFullExportArchiveV13(manifest, undefined, fetcher);
  const archivePath = join(scratch, "v13.zip");
  await writeFile(archivePath, Buffer.from(await archive.archive.arrayBuffer()));
  const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(scratch, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
  return { archive, restored };
}

async function pairedPreviewSnapshot(source: FullExportManifestV13, tiff: boolean) {
  const manifest = structuredClone(source), parent = manifest.tables.comment_submission_acceptances[0];
  const input = JSON.parse(String(parent.request_input_json)), image = input.items.find((item: { kind: string }) => item.kind === "comment_image");
  const originalId = "archive-original-ready", filename = tiff ? "original.tiff" : "original.jpg", mimeType = tiff ? "image/tiff" : "image/jpeg";
  image.originalFilename = filename; image.originalMimeType = mimeType; image.originalByteSize = 4; image.relatedAttachmentId = originalId;
  input.items.unshift({ id: originalId, kind: "attachment", filename, mimeType, byteSize: 4,
    relatedCommentImageId: image.id, sha256: hash("orig") });
  const accepted = await canonicalCommentAcceptanceInput(input);
  parent.request_input_json = accepted.json; parent.request_sha256 = accepted.sha256;
  manifest.tables.comment_item_acceptances[0].purpose = "derived_preview";
  manifest.tables.storage_profiles.push({ id: "cancelled-original-profile", adapter_type: "switchdrive", namespace_identity: "webdav:historical-account:archive",
    configuration_source: "environment", credential_reference: "environment:SWITCHDRIVE", configuration_revision: 1, state: "historical", created_at: parent.created_at });
  manifest.tables.comment_item_acceptances.push({ item_id: originalId, submission_id: parent.submission_id, actor_email: parent.actor_email,
    purpose: "research_source", expected_sha256: hash("orig"), expected_byte_size: 4, storage_profile_id: "cancelled-original-profile", storage_profile_revision: 1,
    candidate_blob_id: crypto.randomUUID(), candidate_object_key: "cancelled/original", execution_token: null, started_at: null,
    status: "cancelled", accepted_result_json: null, created_at: parent.created_at });
  const canonicalImage = manifest.tables.comment_submission_items.find((row) => row.id === image.id)!;
  for (const row of manifest.tables.comment_submission_items) if (row.submission_id === parent.submission_id) row.position = Number(row.position) + 1;
  Object.assign(canonicalImage, { original_filename: filename, original_mime_type: mimeType, original_byte_size: 4, related_item_id: originalId });
  manifest.tables.comment_submission_items.push({ ...canonicalImage, id: originalId, kind: "attachment", status: "cancelled", position: 0,
    filename, mime_type: mimeType, byte_size: 4, original_filename: null, original_mime_type: null, original_byte_size: null,
    asset_id: null, storage_object_id: null, sha256: null, related_item_id: image.id });
  manifest.blobs = buildBlobExportPlan(manifest.tables);
  return manifest;
}

describe("v13 durable canonical Comment acceptance archive profile", () => {
  it("negotiates V13 and restores pending, cancelled, uploaded, ready, deleted and common-target receipts with exact existing identities and byte roots", async () => {
    const f = await fixture(true), scratch = await mkdtemp(join(tmpdir(), "export-v13-"));
    try {
      vi.stubGlobal("fetch", f.fetcher);
      const manifest = await f.manifest();
      expect(manifest).toMatchObject({ schemaVersion: 13, archiveWriter: 1, archiveProfile: "fp1-comment-acceptance" });
      expect(manifest.tables.comment_submission_acceptances).toHaveLength(7);
      expect(manifest.tables.comment_item_acceptances).toHaveLength(5);
      expect(manifest.tables.comment_submissions.some((row) => row.id === "historical-comment")).toBe(true);
      expect(manifest.tables.blob_retention_edges.every((row) => !String(row.source_type).includes("acceptance"))).toBe(true);
      const single = manifest.tables.comment_submission_acceptances.find((row) => row.submission_id === "archive-comment-common-single")!;
      expect(JSON.parse(String(single.publication_plan_json))).toMatchObject({ operationGroupId: null, occurrences: [{ targetIndex: 0 }] });
      const { archive, restored } = await roundtrip(manifest, f.fetcher, scratch);
      expect(archive.warnings).toEqual([]);
      expect(restored.report).toMatchObject({ schemaVersion: 13, archiveProfile: "fp1-comment-acceptance",
        appliedForwardMigrations: [{ name: "0007_fp1_file_authority_transition.sql" }, { name: "0008_fp1_shadow_runtime.sql" }], warnings: [],
        verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", schemaEqual: true } });
      const database = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
      try {
        for (const [table, key] of [["comment_submission_acceptances", "submission_id"], ["comment_item_acceptances", "item_id"], ["comment_submissions", "id"], ["comment_submission_items", "id"], ["run_step_comments", "id"], ["events", "id"]]) {
          const columns = (f.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => `"${name}"`).join(", ");
          expect(database.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${key}`).all()).toEqual(f.database.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all());
        }
        expect(() => database.exec("UPDATE comment_submission_acceptances SET request_sha256 = 'changed' WHERE submission_id = 'archive-comment-ready'")).toThrow();
        expect(() => database.exec("DELETE FROM comment_item_acceptances WHERE item_id = 'archive-image-ready'")).toThrow();
        expect(() => database.exec("INSERT INTO files (id, access_scope, state, created_at) VALUES ('illegal-ready', 'system', 'ready', '2026-09-14')")).toThrow();
      } finally { database.close(); }
      const providers = JSON.parse(await readFile(join(restored.restoredDirectory, "provider-manifest.json"), "utf8"));
      expect(providers).toHaveLength(3);
      for (const entry of providers) expect(await readFile(join(restored.restoredDirectory, entry.path))).toEqual(Buffer.from(f.provider.get(entry.objectKey)!));
      expect(f.put).not.toHaveBeenCalled();
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  }, 15_000);

  it("rejects incompatible clients, schema relabeling and unknown ledger columns before byte downloads", async () => {
    const f = await fixture();
    try {
      for (const version of [8, 9, 10, 11, 12, 14]) expect((await f.request(`/api/exports/all?archiveSchema=${version}&archiveWriter=1`)).status).toBe(409);
      const manifest = await f.manifest();
      await expect(buildFullExportArchiveV12(manifest, undefined, f.fetcher)).rejects.toThrow("versions differ");
      manifest.tables.comment_submission_acceptances = []; manifest.tables.comment_item_acceptances = [];
      await expect(validateFullExportV12({ ...manifest, schemaVersion: 12, archiveProfile: "fp1-metrology-reference-acceptance" })).rejects.toThrow("requires archive schema 13");
      const entry = manifest.artifacts.sourceSchema.value.objects.find((entry) => entry.type === "table" && entry.name === "comment_item_acceptances")!;
      entry.sql = entry.sql!.replace("item_id TEXT PRIMARY KEY NOT NULL,", "item_id TEXT PRIMARY KEY NOT NULL, future_secret TEXT,");
      manifest.artifacts.sourceSchema = await createExportArtifact(EXPORT_SOURCE_SCHEMA_PATH, manifest.artifacts.sourceSchema.value);
      await expect(validateFullExportV13(manifest)).rejects.toThrow("schema columns differ");
      expect(f.read).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each([
    ["actor", (row: ExportRow) => { row.actor_email = "changed@example.com"; }],
    ["request hash", (row: ExportRow) => { row.request_sha256 = "0".repeat(64); }],
    ["scope", (row: ExportRow) => { row.request_scope = "other"; }],
    ["operation", (row: ExportRow) => { row.operation_id = "invalid"; }],
    ["lifetime", (row: ExportRow) => { row.expires_at = String(row.created_at); }],
    ["late completion", (row: ExportRow) => { row.completed_at = row.expires_at; }],
    ["missing result", (row: ExportRow) => { row.accepted_result_json = null; }],
    ["duplicate result member", (row: ExportRow) => { row.accepted_result_json = String(row.accepted_result_json).replace('"submissionId":', '"submissionId":"hidden","submissionId":'); }],
    ["event publication", (row: ExportRow) => { const result = JSON.parse(String(row.accepted_result_json)); result.eventIds = [crypto.randomUUID()]; row.accepted_result_json = JSON.stringify(result); }],
    ["ordered item set", (row: ExportRow) => { const result = JSON.parse(String(row.accepted_result_json)); result.itemIds.reverse(); row.accepted_result_json = JSON.stringify(result); }],
    ["wrong publication sample", (row: ExportRow) => { const plan = JSON.parse(String(row.publication_plan_json)); plan.events[0].sampleId = "different-sample"; row.publication_plan_json = stableJson(plan); }],
  ] as const)("rejects corrupted submission %s before byte downloads", async (_name, corrupt) => {
    const f = await fixture();
    try {
      const manifest = await f.manifest(); corrupt(manifest.tables.comment_submission_acceptances[0]);
      await expect(buildFullExportArchiveV13(manifest, undefined, f.fetcher)).rejects.toThrow("invalid Comment acceptance");
      expect(f.read).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each([
    ["item identity", (row: ExportRow) => { row.item_id = "other-item"; }],
    ["profile", (row: ExportRow) => { row.storage_profile_revision = 2; }],
    ["purpose", (row: ExportRow) => { row.purpose = "derived_preview"; }],
    ["checksum", (row: ExportRow) => { row.expected_sha256 = "0".repeat(64); }],
    ["size", (row: ExportRow) => { row.expected_byte_size = Number(row.expected_byte_size) + 1; }],
    ["candidate", (row: ExportRow) => { row.candidate_blob_id = crypto.randomUUID(); }],
    ["execution", (row: ExportRow) => { row.execution_token = null; row.started_at = null; }],
    ["late execution", (row: ExportRow) => { row.started_at = "2099-01-01T00:00:00.000Z"; }],
    ["missing byte result", (row: ExportRow) => { row.accepted_result_json = null; }],
    ["provider", (row: ExportRow) => { const result = JSON.parse(String(row.accepted_result_json)); result.provider = "switchdrive"; row.accepted_result_json = JSON.stringify(result); }],
    ["duplicate result member", (row: ExportRow) => { row.accepted_result_json = String(row.accepted_result_json).replace('"objectKey":', '"objectKey":"hidden","objectKey":'); }],
  ] as const)("rejects corrupted item %s before byte downloads", async (_name, corrupt) => {
    const f = await fixture();
    try {
      const manifest = await f.manifest(); corrupt(manifest.tables.comment_item_acceptances[0]);
      await expect(buildFullExportArchiveV13(manifest, undefined, f.fetcher)).rejects.toThrow("invalid Comment acceptance");
      expect(f.read).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("round-trips a retained JPEG preview after its paired original was cancelled, while rejecting the equivalent TIFF publication", async () => {
    const f = await fixture(), scratch = await mkdtemp(join(tmpdir(), "export-v13-paired-"));
    try {
      const original = await f.manifest();
      const jpeg = await pairedPreviewSnapshot(original, false);
      await expect(validateFullExportV13(jpeg)).resolves.toEqual(jpeg);
      const { archive, restored } = await roundtrip(jpeg, f.fetcher, scratch);
      expect(archive.warnings).toEqual([]);
      expect(restored.report.verification).toMatchObject({ rowsEqual: true, foreignKeys: true, schemaEqual: true });
      const tiff = await pairedPreviewSnapshot(original, true);
      await expect(validateFullExportV13(tiff)).rejects.toThrow("published preview without its original");
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  }, 15_000);

  it.each(["unknown-field", "duplicate-input", "duplicate-plan", "input-order", "empty-publication"])("rejects a rehashed %s envelope", async (kind) => {
    const f = await fixture();
    try {
      const manifest = await f.manifest(), row = manifest.tables.comment_submission_acceptances[0];
      const input = JSON.parse(String(row.request_input_json));
      if (kind === "unknown-field") input.credential = "unexpected";
      if (kind === "input-order") input.items.reverse();
      if (kind === "empty-publication") {
        input.body = ""; const result = JSON.parse(String(row.accepted_result_json)); result.itemIds = []; row.accepted_result_json = JSON.stringify(result);
      }
      row.request_input_json = kind === "duplicate-input" ? stableJson(input).replace('"protocol":', '"protocol":"comment-submission/1","protocol":') : stableJson(input);
      row.request_sha256 = hash(row.request_input_json);
      if (kind === "duplicate-plan") row.publication_plan_json = String(row.publication_plan_json).replace('"schema":', '"schema":"comment-publication/1","schema":');
      await expect(validateFullExportV13(manifest)).rejects.toThrow("invalid Comment acceptance");
    } finally { f.database.close(); }
  });

  it("rejects a rehashed corrupt receipt and removes the private restore destination", async () => {
    const f = await fixture(), scratch = await mkdtemp(join(tmpdir(), "export-v13-invalid-"));
    try {
      const archive = await buildFullExportArchiveV13(await f.manifest(), undefined, f.fetcher);
      const zip = await JSZip.loadAsync(await archive.archive.arrayBuffer());
      const manifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      const descriptor = manifest.tables.comment_item_acceptances;
      const rows = JSON.parse(await zip.file(descriptor.path)!.async("string")); rows[0].accepted_result_json = null;
      const artifact = await createExportArtifact(descriptor.path, rows); zip.file(artifact.path, `${stableJson(rows)}\n`);
      Object.assign(descriptor, { sha256: artifact.sha256, byteSize: artifact.byteSize }); zip.file("export-manifest.json", JSON.stringify(manifest));
      const archivePath = join(scratch, "invalid.zip"), destination = join(scratch, "restored");
      await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      await expect(restoreExportToIsolatedDirectory({ archivePath, destination, migrationsDirectory, targetCompatibilitySchema: "S2" })).rejects.toThrow("invalid Comment acceptance");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { f.database.close(); await rm(scratch, { recursive: true, force: true }); }
  }, 15_000);

  it("does not require current canonical occurrences, assets or retention edges for historical receipts", async () => {
    const f = await fixture();
    try {
      const manifest = await f.manifest();
      for (const table of ["comment_submissions", "comment_submission_items", "comment_submission_targets", "run_step_comments", "events", "assets", "blob_retention_edges"]) manifest.tables[table] = [];
      manifest.blobs = buildBlobExportPlan(manifest.tables);
      await expect(validateFullExportV13(manifest)).resolves.toEqual(manifest);
      expect(manifest.blobs).toEqual([]);
    } finally { f.database.close(); }
  });
});
