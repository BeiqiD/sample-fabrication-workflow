import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { createExportArtifact, validateFullExportV15 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV15 } from "../src/lib/exportAll";
import { snapshotFullExportV18 } from "./export-v18-snapshot";
import { snapshotFullExportV15 } from "./export-v15-snapshot";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const databases: DatabaseSync[] = [];
const rowids = ["-9223372036854775808", "-9007199254740993", "0", "9007199254740992", "9007199254740993", "9223372036854775807"];
const now = "2026-09-25T00:00:00.000Z";
afterEach(() => { while (databases.length) databases.pop()!.close(); });
const snapshot = (db: DatabaseSync) => snapshotFullExportV15(new SqliteD1Database(db) as unknown as D1Database);

function fixture() {
  const db = referenceTestDatabase({ throughMigration: "0008_fp1_shadow_runtime.sql" }); databases.push(db);
  db.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample','R','Rowids',?,?)").run(now, now);
  const insert = db.prepare(`INSERT INTO events(rowid,id,sample_id,kind,asset_key,metadata_json,created_at)
    VALUES(? ,?,'sample','image',?,'{"action":"sample_record"}',?)`);
  for (const [index, rowid] of rowids.entries()) insert.run(BigInt(rowid), `event-${index}`, `source-${index}`, now);
  return db;
}

describe("V15 signed int64 source identities", () => {
  // Archive/SQLite round trips need room for CPU contention on shared CI runners.
  it.each([false, true])("round-trips exact source and historical rowids after deletion=%s", async (deleted) => {
    const source = fixture();
    if (deleted) source.exec("DELETE FROM events");
    const manifest = await snapshot(source);
    expect(manifest.tables.file_shadow_occurrences.filter((row) => row.present === 1).map((row) => row.source_rowid).sort()).toEqual([...rowids].sort());
    expect(manifest.tables.file_shadow_heads.every((row) => deleted ? row.source_rowid === null : typeof row.source_rowid === "string")).toBe(true);
    expect(manifest.artifacts.sourceRowids.value.tables.events.map((row) => row.rowid)).toEqual(deleted ? [] : rowids);
    const packaged = await buildFullExportArchiveV15(manifest, undefined, vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch);
    const directory = await mkdtemp(join(tmpdir(), "shadow-rowids-"));
    try {
      const archivePath = join(directory, "archive.zip");
      await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
      const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
      const db = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
      try {
        expect(db.prepare("SELECT CAST(rowid AS TEXT) AS rowid FROM events ORDER BY id").all().map((row) => row.rowid)).toEqual(deleted ? [] : rowids);
        expect(db.prepare("SELECT COUNT(*) AS n FROM file_shadow_occurrences WHERE present=1 AND typeof(source_rowid)<>'integer'").get()).toEqual({ n: 0 });
        const recovered = await snapshotFullExportV18(new SqliteD1Database(db) as unknown as D1Database);
        expect(recovered.tables.file_shadow_occurrences).toEqual(manifest.tables.file_shadow_occurrences);
        expect(recovered.tables.file_shadow_heads).toEqual(manifest.tables.file_shadow_heads);
        expect(recovered.artifacts.sourceRowids).toEqual(manifest.artifacts.sourceRowids);
      } finally { db.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("rejects numeric, noncanonical and out-of-range shadow rowid cells", async () => {
    const original = await snapshot(fixture());
    for (const invalid of [0, "-0", "+1", "00", "1e3", "9223372036854775808", "-9223372036854775809"]) {
      const manifest = structuredClone(original);
      const occurrence = manifest.tables.file_shadow_occurrences[0];
      occurrence.source_rowid = invalid;
      manifest.tables.file_shadow_heads.find((row) => row.occurrence_id === occurrence.id)!.source_rowid = invalid;
      await expect(validateFullExportV15(manifest), String(invalid)).rejects.toThrow(/occurrence slot\/source identity/);
    }
  });

  it("rejects a rehashed source-rowid artifact outside signed int64", async () => {
    const manifest = await snapshot(fixture());
    manifest.artifacts.sourceRowids.value.tables.events[0].rowid = "-9223372036854775809";
    manifest.artifacts.sourceRowids = await createExportArtifact(manifest.artifacts.sourceRowids.path, manifest.artifacts.sourceRowids.value);
    await expect(validateFullExportV15(manifest)).rejects.toThrow(/source-rowid identity/);
  });
});
