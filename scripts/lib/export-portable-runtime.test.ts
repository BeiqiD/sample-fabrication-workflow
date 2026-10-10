import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "../../server/installation-catalog";
import { installReviewedSqliteCatalog } from "../../server/migrations";
import { createSqliteCapability } from "../../server/sqlite";
import { captureQuiescedNodeSystemBackup } from "../../server/recovery/snapshot";
import { buildFullExportArchiveV25 } from "../../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "./export-restore";

it("packages and restores actual non-empty V25 research bytes/rowids while excluding protected accounts and all installation authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portable-v25-research-"));
  const database = new DatabaseSync(join(directory, "source.sqlite")), core = createSqliteCapability(database);
  try {
    installReviewedSqliteCatalog(database, CURRENT_NODE_INSTALLATION_CATALOG);
    const at = "2026-10-10T12:00:00.000Z", payload = Uint8Array.of(0, 1, 255, 7);
    database.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(?,'retained','KEPT','Portable sample','Retained中文',?,?)")
      .run(-9223372036854775808n, at, at);
    database.prepare("INSERT INTO assets(rowid,id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES(?,'original','retained/original','original.bin','application/octet-stream',4,'ready',?,?)")
      .run(9007199254740993n, createHash("sha256").update(payload).digest("hex"), at);
    database.prepare("INSERT INTO events(rowid,id,sample_id,kind,body,asset_key,metadata_json,created_at) VALUES(?,'retained-event','retained','image','Retained event','retained/original','{}',?)")
      .run(9007199254740993n, at);
    const verifier = "protected-research-archive-must-not-contain-this-verifier";
    database.prepare("INSERT INTO local_accounts VALUES('local_10000000-0000-4000-8000-000000000001','retained.admin',?,1,1,0)").run(verifier);
    const content = (await captureQuiescedNodeSystemBackup(core, database, { backupId: "research-only", createdAt: at })).content;
    const fetched: string[] = [];
    const built = await buildFullExportArchiveV25(content, undefined, async input => {
      const address = String(input); fetched.push(address);
      expect(content.blobs.some(blob => blob.downloadUrl === address)).toBe(true);
      return new Response(payload.slice().buffer);
    });
    expect(built.warnings).toEqual([]); expect(fetched).toHaveLength(1);
    const bytes = Buffer.from(await built.archive.arrayBuffer()), zip = await JSZip.loadAsync(bytes);
    const archived = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
    expect(archived.schemaVersion).toBe(25);
    const sourceRowids = JSON.parse(await zip.file(archived.artifacts.sourceRowids.path)!.async("string"));
    expect(sourceRowids.tables.events).toEqual([
      expect.objectContaining({ rowid: "9007199254740993" }),
    ]);
    expect(Object.keys(archived.tables).some(name => name.startsWith("local_") || name.startsWith("node_"))).toBe(false);
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir && /\.json$/.test(entry.name)) expect(await entry.async("string")).not.toContain(verifier);
    }
    expect(zip.file("artifacts/portable-runtime-checkpoint.json")).not.toBeNull();
    const archivePath = join(directory, "research.zip"); await writeFile(archivePath, bytes);
    const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "research-restored"),
      migrationsDirectory: new URL("../../migrations/", import.meta.url).pathname, targetCompatibilitySchema: "S2" });
    const restored = new DatabaseSync(join(result.restoredDirectory, "database.sqlite"));
    try {
      // Research provenance preserves physical IDs for File consumer tables;
      // samples retain their canonical stable ID, not an unexported rowid.
      expect(restored.prepare("SELECT id,title,description FROM samples WHERE id='retained'").get())
        .toEqual({ id: "retained", title: "Portable sample", description: "Retained中文" });
      expect(restored.prepare("SELECT CAST(rowid AS TEXT) rowid,id,body FROM events WHERE id='retained-event'").get())
        .toEqual({ rowid: "9007199254740993", id: "retained-event", body: "Retained event" });
      expect(restored.prepare("SELECT id,r2_key,original_name,byte_size FROM assets WHERE id='original'").get())
        .toEqual({ id: "original", r2_key: "retained/original", original_name: "original.bin", byte_size: 4 });
      expect(restored.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name GLOB 'local_*' OR name GLOB 'node_*')").all()).toEqual([]);
      expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { restored.close(); }
    const providers = JSON.parse(await readFile(join(result.restoredDirectory, "provider-manifest.json"), "utf8"));
    const blobPath = providers.find((blob: { outcome: string }) => blob.outcome === "packaged").path;
    expect(await readFile(join(result.restoredDirectory, blobPath))).toEqual(Buffer.from(payload));
    expect(await readFile(archivePath)).toEqual(bytes);
  } finally { core.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
