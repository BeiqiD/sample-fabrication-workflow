import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import type { CompatibilitySchema, ExportRow, ExportTables, FullExportManifestV8, RetiredExportFields } from "../shared/contracts/export";
import type { FullExportManifest } from "../shared/contracts/types";
import { createExportArtifact, exportArtifactText } from "../shared/contracts/export-protocol";
import { buildFullExportArchive, buildFullExportArchiveV8 } from "../src/lib/exportAll";
import { FULL_EXPORT_V8_TABLE_QUERIES } from "./export-catalog";
import { buildBlobExportPlan } from "./export-data";
import worker from "./index";
import { historicalReferenceTestDatabase, seedHistoricalReferenceGraph, seedReferenceGraph, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const root = fileURLToPath(new URL("../", import.meta.url));
const candidatesDirectory = join(root, "scripts/fixtures/backend-schema");
const targets = ["S0", "S1", "S2"] as const;
const sourceKinds = ["S0", "S1", "S1-C", "S2"] as const;
type SourceKind = typeof sourceKinds[number] | "S2-baseline";
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const sortedRows = (rows: ExportRow[]) => rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();
const sortedValues = (values: Array<{ id: string; value: string | number }>) => [...values].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
const legacyText = "Legacy text: 中文, 'quoted', empty lines\n\nkept exactly.";
const cText = "C writes only operational legacy text: 中文\nwithout inventing an old body.";

type SourceArchive = {
  kind: SourceKind;
  version: 7 | 8;
  bytes: Buffer;
  archivePath: string;
  physicalTables: ExportTables;
  provider: Map<string, Uint8Array>;
};

describe("complete ZIP recovery across reviewed S0, S1 and S2 schemas", () => {
  let scratch: string;
  const migrationDirectories = {} as Record<CompatibilitySchema, string>;
  const archives = {} as Record<SourceKind | "v7", SourceArchive>;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "export-schema-matrix-"));
    const bridge = await readFile(join(candidatesDirectory, "s1-compatibility-bridge.sql"), "utf8");
    const contraction = await readFile(join(candidatesDirectory, "s2-final-schema.sql"), "utf8");
    const retainedData = await readFile(join(candidatesDirectory, "retained-data.sql"), "utf8");
    for (const target of targets) {
      const directory = join(scratch, `reviewed-${target}`);
      await cp(join(root, "migrations-history/s0"), directory, { recursive: true });
      if (target !== "S0") await writeFile(join(directory, "0037_compatibility_bridge.sql"), bridge);
      if (target === "S2") await writeFile(join(directory, "0038_final_schema.sql"), contraction);
      migrationDirectories[target] = directory;
    }
    for (const kind of [...sourceKinds, "S2-baseline"] as const) {
      const database = kind === "S2-baseline" ? new DatabaseSync(":memory:") : historicalReferenceTestDatabase();
      if (kind === "S2-baseline") database.exec(await readFile(join(root, "migrations/0001_v3_baseline.sql"), "utf8"));
      try {
        if (kind === "S2-baseline") {
          seedReferenceGraph(database);
          database.prepare(`INSERT INTO run_step_comments
            (id, run_step_id, scope, legacy_body, created_at)
            VALUES ('retained-legacy-individual', 'reference-step-a', 'individual', ?, '2026-08-07T00:00:00.000Z')`).run(legacyText);
        } else {
        seedHistoricalReferenceGraph(database);
        database.exec(retainedData);
        // Exercise both an old duplicate and an empty canonical placeholder.
        // Neither is the operational text owned by comment_submissions.
        database.exec(`UPDATE run_step_comments SET body = 'Retired duplicate differs from canonical text'
          WHERE id = 'reference-comment-occurrence-a';
          UPDATE run_step_comments SET body = '' WHERE id = 'reference-comment-occurrence-b';`);
        if (kind !== "S0") database.exec(`BEGIN; ${bridge} COMMIT;`);
        if (kind === "S1-C") {
          // This is C's physical insert contract on the real S1 candidate:
          // body is omitted and its recorded DEFAULT remains the empty string.
          database.prepare(`INSERT INTO run_step_comments
            (id, run_step_id, scope, legacy_body, created_at)
            VALUES ('matrix-c-legacy', 'reference-step-a', 'individual', ?, '2026-08-07T00:00:00.000Z')`).run(cText);
        }
        if (kind === "S2") database.exec(`BEGIN; ${contraction} COMMIT;`);
        }
        const provider = new Map<string, Uint8Array>();
        for (const asset of database.prepare("SELECT id, r2_key, byte_size FROM assets").all()) {
          const bytes = new Uint8Array(Number(asset.byte_size)).fill(Number(asset.byte_size));
          provider.set(String(asset.r2_key), bytes);
          database.prepare("UPDATE assets SET sha256 = ? WHERE id = ?").run(hash(bytes), asset.id);
        }
        const d1 = new SqliteD1Database(database);
        const env = {
          AUTH_MODE: "disabled", DB: d1 as unknown as D1Database,
          ASSETS: { async get(key: string) {
            const bytes = provider.get(key);
            return bytes ? { body: bytes, httpEtag: `"${hash(bytes)}"`,
              writeHttpMetadata(headers: Headers) { headers.set("content-type", "application/octet-stream"); } } : null;
          } } as unknown as R2Bucket,
        } satisfies Env;
        const fetcher = ((input: string | URL | Request) => worker.fetch(
          new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://matrix.test")), env, context)) as typeof fetch;
        const response = await fetcher("/api/exports/all?archiveSchema=8&archiveWriter=1");
        expect(response.status).toBe(200);
        const manifest = await response.json() as FullExportManifestV8;
        const physicalTables = Object.fromEntries(Object.keys(FULL_EXPORT_V8_TABLE_QUERIES).map((name) =>
          [name, database.prepare(`SELECT * FROM ${quote(name)}`).all()])) as ExportTables;
        const result = await buildFullExportArchiveV8(manifest, undefined, fetcher);
        const bytes = Buffer.from(await result.archive.arrayBuffer());
        const archivePath = join(scratch, `source-${kind}.zip`);
        await writeFile(archivePath, bytes);
        archives[kind] = { kind, version: 8, bytes, archivePath, physicalTables, provider };
        if (kind === "S0") {
          // Capture actual v7 physical SELECTs and use the old browser writer;
          // no v8 projection or compatibility restoration constructs this ZIP.
          const entries = Object.entries(FULL_EXPORT_V8_TABLE_QUERIES);
          const snapshot = await d1.batch(entries.map(([, sql]) => d1.prepare(sql)) as unknown as D1PreparedStatement[]);
          const tables = Object.fromEntries(entries.map(([name], index) => [name, snapshot[index].results])) as ExportTables;
          const oldManifest = { schemaVersion: 7, exportedAt: new Date().toISOString(), tables,
            blobs: buildBlobExportPlan(tables) } as FullExportManifest;
          const oldArchive = await buildFullExportArchive(oldManifest, undefined, fetcher);
          const oldBytes = Buffer.from(await oldArchive.archive.arrayBuffer());
          const oldPath = join(scratch, "source-v7.zip");
          await writeFile(oldPath, oldBytes);
          archives.v7 = { kind, version: 7, bytes: oldBytes, archivePath: oldPath, physicalTables, provider };
        }
      } finally { database.close(); }
    }
  }, 30_000);

  afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

  async function assertRestored(source: SourceArchive, target: CompatibilitySchema, suffix: string, migrationsDirectory = migrationDirectories[target]) {
    const destination = join(scratch, suffix);
    const result = await restoreExportToIsolatedDirectory({ archivePath: source.archivePath, destination,
      migrationsDirectory, targetCompatibilitySchema: target });
    expect(result.report).toMatchObject({ schemaVersion: source.version, targetCompatibilitySchema: target,
      archiveSha256: hash(source.bytes), sourceSchemaEvidence: source.version === 8 ? "observed-in-source-snapshot" : "unavailable-in-v7",
      verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", schemaEqual: true } });
    if (migrationsDirectory === join(root, "migrations")) {
      expect(result.report.appliedForwardMigrations).toEqual([
        { name: "0002_fp1_file_registry.sql", sha256: hash(Buffer.from(await readFile(join(root, "migrations/0002_fp1_file_registry.sql"), "utf8"))) },
      ]);
    } else expect(result.report.appliedForwardMigrations).toEqual([]);
    const restored = new DatabaseSync(join(result.restoredDirectory, "database.sqlite"));
    try {
      // Compare every physical table and the retention projection independently
      // of the conversion codec, preserving all unrelated historical rows.
      for (const [name, original] of Object.entries(source.physicalTables)) {
        const expected = original.map((row) => {
          const copy = { ...row };
          if (name === "samples" && target === "S2") delete copy.process_revision;
          if (name === "run_step_comments") {
            if (target !== "S0" && source.kind === "S0") copy.legacy_body = row.submission_id === null ? row.body : null;
            if (target === "S0") delete copy.legacy_body;
            if (target === "S2") delete copy.body;
          }
          return copy;
        });
        expect(sortedRows(restored.prepare(`SELECT * FROM ${quote(name)}`).all() as ExportRow[]), name).toEqual(sortedRows(expected));
      }
      if (migrationsDirectory === join(root, "migrations")) {
        for (const name of ["storage_profiles", "files", "file_locations", "legacy_file_mappings"]) {
          expect(restored.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get()?.count).toBe(0);
        }
      }
      const sampleColumns = restored.prepare("PRAGMA table_xinfo(samples)").all().map((column) => column.name);
      const commentColumns = restored.prepare("PRAGMA table_xinfo(run_step_comments)").all().map((column) => column.name);
      expect(sampleColumns.includes("process_revision")).toBe(target !== "S2");
      expect(commentColumns.includes("body")).toBe(target !== "S2");
      expect(commentColumns.includes("legacy_body")).toBe(target !== "S0");
      if (target !== "S2") {
        expect(restored.prepare("SELECT id, process_revision FROM samples ORDER BY id").all()).toEqual([
          { id: "reference-sample-a", process_revision: 37 },
          { id: "reference-sample-b", process_revision: 9007199254740000 },
        ]);
        expect(restored.prepare("SELECT body FROM run_step_comments WHERE id = 'reference-comment-occurrence-a'").get()?.body).toBe("Retired duplicate differs from canonical text");
        expect(restored.prepare("SELECT body FROM run_step_comments WHERE id = 'reference-comment-occurrence-b'").get()?.body).toBe("");
      }
      const operationalColumn = target === "S0" ? "body" : "legacy_body";
      expect(restored.prepare(`SELECT ${operationalColumn} AS text FROM run_step_comments WHERE id = 'retained-legacy-individual'`).get()?.text).toBe(legacyText);
      expect(restored.prepare("SELECT body FROM comment_submissions WHERE id = 'reference-comment'").get()?.body).toBe("Shared reference Comment body");
      if (target !== "S0") {
        expect(restored.prepare("SELECT legacy_body FROM run_step_comments WHERE submission_id IS NOT NULL").all().every((row) => row.legacy_body === null)).toBe(true);
        if (source.kind === "S1-C") {
          expect(restored.prepare("SELECT legacy_body FROM run_step_comments WHERE id = 'matrix-c-legacy'").get()?.legacy_body).toBe(cText);
          if (target === "S1") expect(restored.prepare("SELECT body FROM run_step_comments WHERE id = 'matrix-c-legacy'").get()?.body).toBe("");
        }
      }
    } finally { restored.close(); }
    expect(await readFile(join(result.restoredDirectory, "original-archive.zip"))).toEqual(source.bytes);
    expect(await readFile(source.archivePath)).toEqual(source.bytes);
    const retired = JSON.parse(await readFile(join(result.restoredDirectory, "provenance/retired-fields.json"), "utf8")) as RetiredExportFields;
    for (const [family, name, column] of [["samplesProcessRevision", "samples", "process_revision"],
      ["runStepCommentsBody", "run_step_comments", "body"]] as const) {
      const present = source.kind !== "S2" && source.kind !== "S2-baseline";
      expect(retired[family]).toMatchObject({ presentInSourceSchema: present, complete: present, sourceRowCount: source.physicalTables[name].length });
      expect(sortedValues(retired[family].values)).toEqual(present
        ? sortedValues(source.physicalTables[name].map((row) => ({ id: String(row.id), value: row[column] as string | number }))) : []);
    }
    if (source.version === 8) {
      const zip = await JSZip.loadAsync(source.bytes);
      expect(result.report.retainedArtifactPaths).toEqual(["provenance/source-schema.json", "provenance/retired-fields.json"]);
      for (const path of result.report.retainedArtifactPaths) expect(await readFile(join(result.restoredDirectory, path))).toEqual(await zip.file(path)!.async("nodebuffer"));
    } else {
      expect(result.report.retainedArtifactPaths).toEqual(["provenance/retired-fields.json"]);
      await expect(stat(join(result.restoredDirectory, "provenance/source-schema.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const providers = JSON.parse(await readFile(join(result.restoredDirectory, "provider-manifest.json"), "utf8")) as Array<{ objectKey: string; path: string | null; outcome: string }>;
    expect(providers).toHaveLength(source.provider.size);
    for (const entry of providers) {
      expect(entry.outcome).toBe("packaged");
      expect(await readFile(join(result.restoredDirectory, entry.path!))).toEqual(Buffer.from(source.provider.get(entry.objectKey)!));
    }
    expect(await readdir(destination)).toEqual(["restored"]);
  }

  it("restores actual default-baseline S2 API and browser ZIP into the current S2 schema with a recorded dormant-registry upgrade with exact rows, bytes and unavailable retired-field evidence", async () => {
    await assertRestored(archives["S2-baseline"], "S2", "default-baseline-roundtrip", join(root, "migrations"));
  }, 15_000);

  it("restores the historical v7 ZIP into the current S2 schema with a recorded dormant-registry upgrade while preserving the nonzero retired values outside active rows", async () => {
    await assertRestored(archives.v7, "S2", "v7-default-baseline", join(root, "migrations"));
  }, 15_000);

  it.each(sourceKinds.flatMap((source) => targets.map((target) => ({ source, target }))))(
    "v8 source $source restores to $target only when its actual evidence permits it", async ({ source, target }) => {
      const archive = archives[source];
      const destination = join(scratch, `matrix-${source}-${target}`);
      const unavailable = source === "S2" && target !== "S2";
      const incompatibleLegacy = source === "S1-C" && target === "S0";
      if (unavailable || incompatibleLegacy) {
        await expect(restoreExportToIsolatedDirectory({ archivePath: archive.archivePath, destination,
          migrationsDirectory: migrationDirectories[target], targetCompatibilitySchema: target }))
          .rejects.toThrow(unavailable ? /unavailable for the requested physical target/ : /cannot preserve recorded body and readable legacy text together/);
        await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(archive.archivePath)).toEqual(archive.bytes);
      } else await assertRestored(archive, target, `matrix-${source}-${target}`);
    }, 15_000,
  );

  it.each(targets)("the actual v7 catalog and browser ZIP restore to explicit %s with original retired values retained", async (target) => {
    await assertRestored(archives.v7, target, `matrix-v7-${target}`);
  }, 15_000);

  it.each([{ requested: "S0", migrated: "S1" }, { requested: "S1", migrated: "S2" }, { requested: "S2", migrated: "S0" }] as const)(
    "rejects requested $requested when reviewed local migrations actually create $migrated and removes the new destination", async ({ requested, migrated }) => {
      const destination = join(scratch, `mismatch-${requested}-${migrated}`);
      await expect(restoreExportToIsolatedDirectory({ archivePath: archives.S0.archivePath, destination,
        migrationsDirectory: migrationDirectories[migrated], targetCompatibilitySchema: requested }))
        .rejects.toThrow("Requested compatibility target differs from the reviewed migration schema");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(archives.S0.archivePath)).toEqual(archives.S0.bytes);
    }, 15_000,
  );

  async function alterArtifact(name: "sourceSchema" | "retiredFields", mutate: (value: any) => void, rehash: boolean) {
    const zip = await JSZip.loadAsync(archives.S0.bytes);
    const manifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
    const descriptor = manifest.artifacts[name];
    const value = JSON.parse(await zip.file(descriptor.path)!.async("string"));
    mutate(value);
    zip.file(descriptor.path, exportArtifactText(value));
    if (rehash) {
      const artifact = await createExportArtifact(descriptor.path, value);
      manifest.artifacts[name] = { path: artifact.path, byteSize: artifact.byteSize, sha256: artifact.sha256 };
      zip.file("export-manifest.json", JSON.stringify(manifest));
    }
    return zip;
  }

  it.each(["missing sidecar", "sidecar hash", "rehashed missing coverage"] as const)(
    "rejects actual v8 ZIP with %s corruption and removes the new destination", async (kind) => {
      const zip = kind === "missing sidecar" ? await JSZip.loadAsync(archives.S0.bytes)
        : await alterArtifact("retiredFields", (value) => {
          if (kind === "sidecar hash") value.samplesProcessRevision.values[0].value += 1;
          else value.samplesProcessRevision.values.pop();
        }, kind === "rehashed missing coverage");
      if (kind === "missing sidecar") zip.remove("provenance/retired-fields.json");
      const archivePath = join(scratch, `corrupt-${kind.replaceAll(" ", "-")}.zip`);
      const bytes = await zip.generateAsync({ type: "nodebuffer" });
      await writeFile(archivePath, bytes);
      const destination = `${archivePath}-restore`;
      await expect(restoreExportToIsolatedDirectory({ archivePath, destination,
        migrationsDirectory: migrationDirectories.S0, targetCompatibilitySchema: "S0" }))
        .rejects.toThrow(kind === "missing sidecar" ? /Missing archive entry/ : kind === "sidecar hash" ? /artifact SHA-256 or size mismatch/ : /coverage is incomplete/);
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(archivePath)).toEqual(bytes);
    }, 15_000,
  );

  it("retains rehashed source SQL as evidence without executing its injected trigger", async () => {
    const injectedName = "archive_ddl_must_not_execute";
    const zip = await alterArtifact("sourceSchema", (value) => {
      value.objects.push({ type: "trigger", name: injectedName, tableName: "samples",
        sql: `CREATE TRIGGER ${injectedName} AFTER INSERT ON samples BEGIN SELECT RAISE(ABORT, 'archive SQL was executed'); END` });
    }, true);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const archivePath = join(scratch, "injected-source-evidence.zip");
    await writeFile(archivePath, bytes);
    const source = { ...archives.S0, bytes, archivePath };
    await assertRestored(source, "S0", "injected-source-evidence");
    const restored = new DatabaseSync(join(scratch, "injected-source-evidence/restored/database.sqlite"));
    try {
      expect(restored.prepare("SELECT name FROM sqlite_schema WHERE name = ?").all(injectedName)).toEqual([]);
    } finally { restored.close(); }
  }, 15_000);
});
