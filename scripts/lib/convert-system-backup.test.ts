import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { convertLegacySystemBackup } from "./convert-system-backup";
import { historicalReferenceTestDatabase, referenceTestDatabase, seedHistoricalReferenceGraph, SqliteD1Database } from "../../worker/reference-test-support";
import { snapshotFullExportV8 } from "../../worker/export-v8-snapshot";
import { snapshotFullExportV15 } from "../../worker/export-v15-snapshot";
import { snapshotFullExportV23 } from "../../worker/export-v23-snapshot";
import { snapshotFullExportV24 } from "../../worker/export-v24-snapshot";
import { FULL_EXPORT_V8_TABLE_QUERIES } from "../../worker/export-catalog";
import { buildBlobExportPlan } from "../../shared/contracts/export-blob-plan";
import { buildFullExportArchive, buildFullExportArchiveV8, buildFullExportArchiveV15, buildFullExportArchiveV23, buildFullExportArchiveV24 } from "../../src/lib/exportAll";
import type { FullExportManifest } from "../../shared/contracts/types";
import type { ExportTables } from "../../shared/contracts/export";
import { validateSystemBackupDocuments, type SystemBackupRecordsV1, type SystemBackupManifestV1 } from "../../shared/contracts/system-backup";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "../../worker/recovery/trusted-schema";
import { validateStoreArchive, sourceFromBlob } from "../../shared/domain/research-archive";
import { convertedLegacyAllSlotsFixture } from "../../worker/recovery/legacy-all-slots-test-support";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const adapter = (sql: DatabaseSync) => new SqliteD1Database(sql) as unknown as D1Database;

async function historicalArchive(version: 7 | 8) {
  const source = historicalReferenceTestDatabase();
  try {
    seedHistoricalReferenceGraph(source);
    source.exec("UPDATE samples SET process_revision=37 WHERE id='reference-sample-a'; UPDATE run_step_comments SET body='Exact retired duplicate 中文' WHERE id='reference-comment-occurrence-a'");
    const objects = new Map<string, Uint8Array>();
    for (const asset of source.prepare("SELECT id,r2_key,byte_size FROM assets").all()) {
      const bytes = new Uint8Array(Number(asset.byte_size)).fill(Number(asset.byte_size));
      objects.set(String(asset.r2_key), bytes); source.prepare("UPDATE assets SET sha256=? WHERE id=?").run(hash(bytes), asset.id);
    }
    const wire = version === 8 ? await snapshotFullExportV8(adapter(source)) : (() => {
      const tables = Object.fromEntries(Object.entries(FULL_EXPORT_V8_TABLE_QUERIES).map(([name, query]) => [name, source.prepare(query).all()])) as ExportTables;
      return { schemaVersion: 7, exportedAt: new Date().toISOString(), tables, blobs: buildBlobExportPlan(tables) } as FullExportManifest;
    })();
    const fetcher = async (input: RequestInfo | URL) => {
      const entry = wire.blobs.find(blob => blob.downloadUrl === String(input));
      const bytes = entry ? objects.get(entry.objectKey) : undefined;
      return new Response(bytes?.slice(0) ?? null, { status: bytes ? 200 : 404 });
    };
    const built = version === 8 ? await buildFullExportArchiveV8(wire, undefined, fetcher) : await buildFullExportArchive(wire as FullExportManifest, undefined, fetcher);
    expect(built.warnings).toEqual([]);
    return Buffer.from(await built.archive.arrayBuffer());
  } finally { source.close(); }
}
async function currentArchive(version: 15 | 23 | 24) {
  const source = referenceTestDatabase({ throughMigration: version === 15 ? "0008_fp1_shadow_runtime.sql" : version === 23 ? "0020_fp4_research_packages.sql" : "0022_fp5_recovery_evidence.sql" });
  try {
    const now = "2026-10-06T15:00:00.000Z";
    source.prepare("INSERT INTO samples(rowid,id,code,title,created_at,updated_at) VALUES(?,'int64-sample','INT64','Exact source',?,?)").run(9007199254740993n, now, now);
    source.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('int64-family','Int64 recipe','module',?)").run(now);
    source.prepare("INSERT INTO template_versions(rowid,id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at) VALUES(?,'int64-template','int64-family','Int64 recipe','module',1,'int64-manifest','{}',?)").run(9007199254740993n, now);
    if (version === 15) source.prepare("INSERT INTO events(rowid,id,sample_id,kind,asset_key,metadata_json,created_at) VALUES(?,'missing-event','int64-sample','image','missing-legacy-key','{\"action\":\"sample_record\"}',?)")
      .run(-9223372036854775808n, now);
    const wire = version === 15 ? await snapshotFullExportV15(adapter(source)) : version === 23 ? await snapshotFullExportV23(adapter(source)) : await snapshotFullExportV24(adapter(source));
    const fetcher = async () => new Response(null, { status: 404 });
    const built = version === 15 ? await buildFullExportArchiveV15(wire, undefined, fetcher) : version === 23 ? await buildFullExportArchiveV23(wire, undefined, fetcher) : await buildFullExportArchiveV24(wire, undefined, fetcher);
    return Buffer.from(await built.archive.arrayBuffer());
  } finally { source.close(); }
}

describe("reviewed legacy archive conversion to website system recovery", () => {
  it("converts actual historical bytes and provenance for all thirteen legacy consumer slots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "system-backup-all-slots-")); directories.push(directory);
    const fixture = await convertedLegacyAllSlotsFixture(directory);
    expect(fixture.manifest.completeness).toBe("complete");
    expect(fixture.manifest.counts.packagedFiles).toBe(13);
    const bindings = fixture.manifest.files.flatMap(file => file.bindings);
    expect(bindings).toHaveLength(13);
    expect(new Set(bindings.map(binding => `${binding.consumerKind}:${binding.fileSlot}`)).size).toBe(13);
    for (const file of fixture.manifest.files) {
      expect(file.outcome).toBe("packaged");
      expect(fixture.capsulePayloads.get(file.path!)).toEqual(fixture.payloads.get(file.source.objectKey));
      expect(file.sha256).toBe(hash(fixture.payloads.get(file.source.objectKey)!));
    }
    await expect(validateSystemBackupDocuments(fixture.manifest, fixture.records, { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES })).resolves.toMatchObject({ manifest: fixture.manifest });
    expect(fixture.records.origin.archiveSha256).toBe(hash(fixture.legacyArchiveBytes));
    expect(await readFile(join(fixture.converted.destination, fixture.converted.report.originalArchivePath))).toEqual(Buffer.from(fixture.legacyArchiveBytes));
  }, 30_000);

  it.each([7, 8, 15, 23, 24] as const)("converts actual V%i archive into a fully validated bounded capsule while retaining original identity/provenance and disabled jobs", async version => {
    const directory = await mkdtemp(join(tmpdir(), "system-backup-legacy-test-")); directories.push(directory);
    const bytes = version < 15 ? await historicalArchive(version as 7 | 8) : await currentArchive(version as 15 | 23 | 24);
    const archivePath = join(directory, "source.zip"); await writeFile(archivePath, bytes);
    const converted = await convertLegacySystemBackup({ archivePath, destination: join(directory, "converted"), migrationsDirectory });
    const emitted = await readFile(converted.archivePath);
    await expect(validateStoreArchive(sourceFromBlob(new Blob([emitted])), { expectedSha256: converted.report.archiveSha256 })).resolves.toMatchObject({ byteSize: emitted.length });
    const zip = await JSZip.loadAsync(emitted), records = JSON.parse(await zip.file("records.json")!.async("string")) as SystemBackupRecordsV1;
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as SystemBackupManifestV1;
    await expect(validateSystemBackupDocuments(manifest, records, { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES })).resolves.toMatchObject({ manifest });
    expect(records.origin).toMatchObject({ format: "legacy-converted", schemaVersion: version, archiveSha256: hash(bytes) });
    expect(records.protectedConfiguration.status).toBe("excluded_legacy_content");
    expect(records.sourceMigrationLedger).toEqual({ status: "unavailable", entries: [] });
    for (const table of RECOVERY_TABLES.filter(table => table.classification === "protected_configuration")) expect(records.image.tables[table.name].rows).toEqual([]);
    expect(converted.report).toMatchObject({ providerIO: false, executionResumed: false, nativeBindingsRestored: false, exactRecordedRowids: version >= 15 });
    expect(await readFile(join(converted.destination, converted.report.originalArchivePath))).toEqual(bytes);
    expect(await readFile(archivePath)).toEqual(bytes);
    if (version < 15) {
      const evidence = records.origin.legacyArtifacts as { sourceSchemaEvidence: string; artifacts: Record<string, { value?: { samplesProcessRevision: { values: { id: string; value: number }[] }; runStepCommentsBody: { values: { id: string; value: string }[] } } }> };
      expect(evidence.sourceSchemaEvidence).toBe(version === 7 ? "unavailable-in-v7" : "observed-in-source-snapshot");
      const retired = evidence.artifacts["provenance/retired-fields.json"].value!;
      expect(retired.samplesProcessRevision.values).toContainEqual({ id: "reference-sample-a", value: 37 });
      expect(retired.runStepCommentsBody.values).toContainEqual({ id: "reference-comment-occurrence-a", value: "Exact retired duplicate 中文" });
      expect(manifest.completeness).toBe("complete");
      if (version === 7) {
        const changedBytes = structuredClone(records), changedValue = structuredClone(records);
        const byteArtifact = (changedBytes.origin.legacyArtifacts as typeof evidence & { artifacts: Record<string, { originalText: string }> }).artifacts["provenance/retired-fields.json"];
        byteArtifact.originalText += " ";
        await expect(validateSystemBackupDocuments(manifest, changedBytes, { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES }))
          .rejects.toThrow("legacy_retired_artifact_hash");
        const valueArtifact = (changedValue.origin.legacyArtifacts as typeof evidence).artifacts["provenance/retired-fields.json"].value!;
        valueArtifact.samplesProcessRevision.values.find(row => row.id === "reference-sample-a")!.value = 38;
        await expect(validateSystemBackupDocuments(manifest, changedValue, { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES }))
          .rejects.toThrow("legacy_retired_artifact_value");
      }
    } else {
      const sample = records.image.tables.samples.rows.find(row => row.cells[0].type === "text" && row.cells[0].value === "int64-sample")!;
      // The old profile never recorded Sample hidden rowids. Its canonical id
      // survives, while the recorded File-consumer template rowid is exact.
      expect(sample.rowid).toBe("1");
      const template = records.image.tables.template_versions.rows.find(row => row.cells[0].type === "text" && row.cells[0].value === "int64-template")!;
      expect(template.rowid).toBe("9007199254740993");
      expect(converted.report.unrecordedHistoricalRowids).toBe("assigned-by-reviewed-isolated-restore");
      if (version === 15) {
        expect(records.image.tables.events.rows[0].rowid).toBe("-9223372036854775808");
        expect(manifest.completeness).toBe("partial");
        expect(manifest.counts.unavailableFiles).toBeGreaterThan(0);
      }
    }
    const restored = new DatabaseSync(join(converted.destination, "legacy/restored/database.sqlite"));
    try {
      expect(restored.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
      expect(restored.prepare("SELECT COUNT(*) AS count FROM system_storage_native_bindings").get()).toEqual({ count: 0 });
    } finally { restored.close(); }
  }, 30_000);

  it("rejects corrupted archives without publishing a capsule, and refuses existing destinations without modifying them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "system-backup-legacy-failure-")); directories.push(directory);
    const archivePath = join(directory, "corrupt.zip"); await writeFile(archivePath, Buffer.from("not a ZIP"));
    const destination = join(directory, "failed");
    await expect(convertLegacySystemBackup({ archivePath, destination, migrationsDirectory })).rejects.toThrow();
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(directory, "sentinel"), "untouched");
    await expect(convertLegacySystemBackup({ archivePath, destination: directory, migrationsDirectory })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(directory, "sentinel"), "utf8")).toBe("untouched");
  });
});
