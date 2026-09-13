import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import type { FullExportManifestV8 } from "../shared/contracts/export";
import { createExportArtifact, EXPORT_RETIRED_FIELDS_PATH, EXPORT_SOURCE_SCHEMA_PATH, validateFullExportV8 } from "../shared/contracts/export-protocol";
import { api } from "../src/lib/api";
import { buildFullExportArchive, buildFullExportArchiveV8 } from "../src/lib/exportAll";
import worker from "./index";
import { referenceTestDatabase, seedReferenceGraph, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const endpoint = "/api/exports/all?archiveSchema=8&archiveWriter=1";
const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  database.exec(`UPDATE samples SET process_revision = 37 WHERE id = 'reference-sample-a';
    UPDATE run_step_comments SET body = 'Actual retired duplicate';
    INSERT INTO run_step_comments (id, run_step_id, scope, body, created_at)
      VALUES ('v8-legacy', 'reference-step-a', 'individual', 'Retained legacy text', '2026-08-01T06:00:00.000Z');`);
  const provider = new Map<string, Uint8Array>();
  for (const asset of database.prepare("SELECT id, r2_key, byte_size FROM assets").all()) {
    const bytes = new Uint8Array(Number(asset.byte_size)).fill(Number(asset.byte_size));
    provider.set(String(asset.r2_key), bytes);
    database.prepare("UPDATE assets SET sha256 = ? WHERE id = ?").run(sha256(bytes), asset.id);
  }
  const d1 = new SqliteD1Database(database);
  const batch = vi.spyOn(d1, "batch");
  const env = {
    AUTH_MODE: "disabled", DB: d1 as unknown as D1Database,
    ASSETS: { async get(key: string) {
      const bytes = provider.get(key);
      return bytes ? { body: bytes, httpEtag: `"${sha256(bytes)}"`, writeHttpMetadata(headers: Headers) { headers.set("content-type", "application/octet-stream"); } } : null;
    } } as unknown as R2Bucket,
  } satisfies Env;
  const request = (path: string) => worker.fetch(new Request(new URL(path, "https://app.test")), env, context);
  const fetcher = vi.fn((url: string | URL | Request) => request(typeof url === "string" ? url : url instanceof URL ? url.href : url.url)) as unknown as typeof fetch;
  return { database, d1, batch, env, provider, request, fetcher,
    async manifest() { const response = await request(endpoint); expect(response.status).toBe(200); return response.json() as Promise<FullExportManifestV8>; },
  };
}

describe("negotiated v8 API, browser archive writer and isolated recovery", () => {
  it.each(["", "?archiveSchema=7&archiveWriter=1", "?archiveSchema=8", "?archiveSchema=8&archiveWriter=2", "?archiveSchema=8&archiveWriter=1&archiveWriter=1", "?archiveSchema=8&archiveWriter=1&extra=1"])("rejects an old or unsupported writer request before any snapshot: %s", async (query) => {
    const f = fixture();
    try {
      const legacyWriter = vi.fn(buildFullExportArchive);
      // Preserve the old request() control flow: non-2xx rejects before the
      // old ZIP writer receives a manifest it cannot fully serialize.
      const oldClient = async () => {
        const response = await f.request(`/api/exports/all${query}`);
        if (!response.ok) throw new Error((await response.json() as { error: string }).error);
        return legacyWriter(await response.json(), undefined, f.fetcher);
      };
      await expect(oldClient()).rejects.toThrow("Refresh the page");
      expect(legacyWriter).not.toHaveBeenCalled();
      expect(f.batch).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("uses the negotiated browser API and packages exact provenance, table inventory and provider bytes", async () => {
    const f = fixture();
    try {
      const before = f.database.prepare("SELECT * FROM run_step_comments ORDER BY id").all();
      vi.stubGlobal("fetch", f.fetcher);
      const manifest = await api.getFullExport();
      expect(f.fetcher).toHaveBeenCalledWith(endpoint, undefined);
      expect(f.batch).toHaveBeenCalledTimes(1);
      expect(f.batch.mock.calls[0][0]).toHaveLength(Object.keys(manifest.tables).length + 3);
      expect(f.d1.queryCount).toBe(Object.keys(manifest.tables).length + 3);
      expect(manifest.artifacts.retiredFields.value.samplesProcessRevision.values).toContainEqual({ id: "reference-sample-a", value: 37 });
      const result = await buildFullExportArchiveV8(manifest, undefined, f.fetcher);
      expect(result.warnings).toEqual([]);
      const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
      const archived = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      expect(archived).toMatchObject({ schemaVersion: 8, archiveWriter: 1 });
      for (const [name, artifact] of Object.entries(manifest.artifacts)) {
        const bytes = await zip.file(archived.artifacts[name].path)!.async("uint8array");
        expect(bytes.length).toBe(artifact.byteSize);
        expect(sha256(bytes)).toBe(artifact.sha256);
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(artifact.value);
      }
      for (const [name, rows] of Object.entries(manifest.tables)) {
        const bytes = await zip.file(archived.tables[name].path)!.async("uint8array");
        expect(bytes.length).toBe(archived.tables[name].byteSize);
        expect(sha256(bytes)).toBe(archived.tables[name].sha256);
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(rows);
      }
      for (const blob of archived.blobs) expect(await zip.file(blob.path)!.async("uint8array")).toEqual(f.provider.get(blob.objectKey));
      expect(f.database.prepare("SELECT * FROM run_step_comments ORDER BY id").all()).toEqual(before);
    } finally { f.database.close(); }
  });

  it("rejects A's v7 response and incomplete or contradictory provenance before any blob fetch", async () => {
    const f = fixture();
    try {
      const manifest = await f.manifest();
      const previous = { schemaVersion: 7, exportedAt: manifest.exportedAt, tables: manifest.tables, blobs: manifest.blobs };
      await expect(buildFullExportArchiveV8(previous, undefined, f.fetcher)).rejects.toThrow("versions differ");
      const missing = structuredClone(manifest) as any;
      delete missing.artifacts.retiredFields;
      await expect(buildFullExportArchiveV8(missing, undefined, f.fetcher)).rejects.toThrow("missing provenance");
      const corrupt = structuredClone(manifest);
      corrupt.artifacts.retiredFields.value.samplesProcessRevision.values[0].value += 1;
      await expect(buildFullExportArchiveV8(corrupt, undefined, f.fetcher)).rejects.toThrow("hash or size mismatch");
      const inconsistent = structuredClone(manifest);
      inconsistent.artifacts.retiredFields.value.samplesProcessRevision = {
        presentInSourceSchema: false, complete: false, sourceRowCount: manifest.tables.samples.length, values: [],
      };
      inconsistent.artifacts.retiredFields = await createExportArtifact(EXPORT_RETIRED_FIELDS_PATH, inconsistent.artifacts.retiredFields.value);
      await expect(buildFullExportArchiveV8(inconsistent, undefined, f.fetcher)).rejects.toThrow("unavailable");
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("observes schema and retired values inside the row batch when expansion happens before execution", async () => {
    const f = fixture();
    try {
      f.batch.mockImplementationOnce(async (statements) => {
        f.database.exec("ALTER TABLE run_step_comments ADD COLUMN legacy_body TEXT; UPDATE run_step_comments SET legacy_body = CASE WHEN submission_id IS NULL THEN body ELSE NULL END; UPDATE run_step_comments SET body = '' WHERE submission_id IS NOT NULL;");
        return SqliteD1Database.prototype.batch.call(f.d1, statements);
      });
      const manifest = await f.manifest();
      expect(manifest.artifacts.sourceSchema.value.compatibilityColumns.run_step_comments).toContain("legacy_body");
      expect(manifest.artifacts.retiredFields.value.runStepCommentsBody.values.filter((entry) => entry.id !== "v8-legacy").every((entry) => entry.value === "")).toBe(true);
      expect(manifest.tables.run_step_comments.find((row) => row.id === "v8-legacy")?.legacy_body).toBe("Retained legacy text");
      await expect(validateFullExportV8(manifest)).resolves.toEqual(manifest);
      expect(f.batch).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it("rejects omitted tables, non-JSON cells and column labels that contradict recorded SQL before blob fetch", async () => {
    const f = fixture();
    try {
      const manifest = await f.manifest();
      const missing = structuredClone(manifest);
      delete missing.tables.events;
      await expect(buildFullExportArchiveV8(missing, undefined, f.fetcher)).rejects.toThrow("table inventory differs");
      const extra = structuredClone(manifest);
      extra.tables.undeclared = [];
      await expect(buildFullExportArchiveV8(extra, undefined, f.fetcher)).rejects.toThrow("table inventory differs");
      for (const cell of [undefined, NaN, Infinity, {}, new Date()]) {
        const bad = structuredClone(manifest) as any;
        bad.tables.events[0].body = cell;
        await expect(buildFullExportArchiveV8(bad, undefined, f.fetcher)).rejects.toThrow("unsupported values");
      }
      const missingColumn = structuredClone(manifest);
      delete missingColumn.tables.events[0].body;
      await expect(buildFullExportArchiveV8(missingColumn, undefined, f.fetcher)).rejects.toThrow("row columns differ");
      const extraColumn = structuredClone(manifest);
      extraColumn.tables.events[0].undeclared = "extra";
      await expect(buildFullExportArchiveV8(extraColumn, undefined, f.fetcher)).rejects.toThrow("row columns differ");
      for (const alter of [
        (bad: FullExportManifestV8) => { bad.blobs = []; },
        (bad: FullExportManifestV8) => { bad.blobs.push(structuredClone(bad.blobs[0])); },
        (bad: FullExportManifestV8) => { bad.blobs[0].downloadUrl = "/api/exports/r2/unrelated"; },
        (bad: FullExportManifestV8) => { bad.blobs[0].expectedSha256 = "0".repeat(64); },
        (bad: FullExportManifestV8) => { bad.blobs.find((blob) => blob.sourceOccurrences.length)!.sourceOccurrences.pop(); },
      ]) {
        const bad = structuredClone(manifest);
        alter(bad);
        await expect(buildFullExportArchiveV8(bad, undefined, f.fetcher)).rejects.toThrow("blob catalog differs");
      }
      const contradictory = structuredClone(manifest);
      contradictory.artifacts.sourceSchema.value.compatibilityColumns.samples = contradictory.artifacts.sourceSchema.value.compatibilityColumns.samples.filter((name) => name !== "process_revision");
      contradictory.artifacts.sourceSchema.value.compatibilityColumns.run_step_comments = contradictory.artifacts.sourceSchema.value.compatibilityColumns.run_step_comments.filter((name) => name !== "body").concat("legacy_body");
      for (const field of Object.values(contradictory.artifacts.retiredFields.value).filter((field) => typeof field === "object")) {
        field.presentInSourceSchema = false; field.complete = false; field.values = [];
      }
      contradictory.artifacts.sourceSchema = await createExportArtifact(EXPORT_SOURCE_SCHEMA_PATH, contradictory.artifacts.sourceSchema.value);
      contradictory.artifacts.retiredFields = await createExportArtifact(EXPORT_RETIRED_FIELDS_PATH, contradictory.artifacts.retiredFields.value);
      await expect(buildFullExportArchiveV8(contradictory, undefined, f.fetcher)).rejects.toThrow("columns disagree with recorded SQL");
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("restores a differently ordered v8 occurrence multiset to S0 and retains every row, ZIP and artifact", async () => {
    const f = fixture();
    const temporary = await mkdtemp(join(tmpdir(), "v8-recovery-"));
    try {
      f.database.exec(`INSERT INTO events (id, sample_id, kind, asset_key, created_at)
        SELECT 'occurrence-order-' || suffix, 'reference-sample-a', 'image',
          (SELECT r2_key FROM assets ORDER BY id LIMIT 1), '2026-08-01T07:00:00.000Z'
        FROM (SELECT 'a' AS suffix UNION ALL SELECT 'b');`);
      const before = Object.fromEntries(["samples", "run_step_comments"].map((name) => [name, f.database.prepare(`SELECT * FROM ${name} ORDER BY id`).all()]));
      const manifest = await f.manifest();
      const multiple = manifest.blobs.filter((blob) => blob.sourceOccurrences.length > 1);
      expect(multiple.length).toBeGreaterThan(0);
      const originalOrder = JSON.stringify(multiple);
      for (const blob of multiple) blob.sourceOccurrences.reverse();
      expect(JSON.stringify(multiple)).not.toBe(originalOrder);
      const archive = await buildFullExportArchiveV8(manifest, undefined, f.fetcher);
      const bytes = Buffer.from(await archive.archive.arrayBuffer());
      const archivePath = join(temporary, "input.zip");
      await writeFile(archivePath, bytes);
      const destination = join(temporary, "restored-result");
      const result = await restoreExportToIsolatedDirectory({ archivePath, destination, migrationsDirectory, targetCompatibilitySchema: "S0" });
      expect(result.report).toMatchObject({ schemaVersion: 8, targetCompatibilitySchema: "S0", archiveSha256: sha256(bytes), sourceSchemaEvidence: "observed-in-source-snapshot" });
      const restored = new DatabaseSync(join(result.restoredDirectory, "database.sqlite"));
      try {
        for (const [name, rows] of Object.entries(before)) expect(restored.prepare(`SELECT * FROM ${name} ORDER BY id`).all()).toEqual(rows);
      } finally { restored.close(); }
      expect(await readFile(join(result.restoredDirectory, "original-archive.zip"))).toEqual(bytes);
      expect(result.report.retainedArtifactPaths).toEqual(["provenance/source-schema.json", "provenance/retired-fields.json"]);
      await expect(restoreExportToIsolatedDirectory({ archivePath, destination: join(temporary, "unspecified"), migrationsDirectory })).rejects.toThrow("explicit compatibility target");
      await expect(stat(join(temporary, "unspecified"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(archivePath)).toEqual(bytes);
    } finally { f.database.close(); await rm(temporary, { recursive: true, force: true }); }
  }, 15_000);
});
