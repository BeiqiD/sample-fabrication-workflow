import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import type { ExportSchemaObject } from "../shared/contracts/export";
import { stableJson } from "../shared/domain/content-addressing";
import { FILE_SHADOW_WITHDRAWAL_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-shadow-withdrawals";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { shadowWithdrawalRequestSha256, type ShadowWithdrawalRequest } from "../shared/contracts/file-shadow-withdrawal";
import { validateFullExportV16 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV16 } from "../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { inspectFileShadowSnapshot } from "../scripts/lib/file-shadow-inspection-cli";
import { snapshotFullExportV15 } from "./export-v15-snapshot";
import { snapshotFullExportV16 } from "./export-v16-snapshot";
import { snapshotRoutes } from "./export-routes";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const databases: DatabaseSync[] = [];
const directories: string[] = [];
const now = "2026-09-28T00:00:00.000Z";
const request: ShadowWithdrawalRequest = {
  operationId: "0f4039ca-56db-4a03-a617-05b01f32a5dc",
  key: { consumerKind: "project_content_attachment", consumerId: "missing\0historical", consumerSubId: "", fileSlot: "primary" },
  expectedBaselineSha256: "a".repeat(64), destinationProfile: { profileId: "missing-profile", configurationRevision: 1 },
  runtimeIncarnation: "b38d2793-3ac1-4d17-8499-d9f2d74d8134",
};
afterEach(async () => {
  while (databases.length) databases.pop()!.close();
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
});
function database(throughMigration?: string) {
  const db = referenceTestDatabase({ throughMigration }); databases.push(db); return db;
}
const adapter = (db: DatabaseSync) => new SqliteD1Database(db) as unknown as D1Database;
async function fixture() {
  const db = database();
  db.prepare("INSERT INTO file_shadow_withdrawals(operation_id,request_json,request_sha256,created_by,created_at) VALUES(?,?,?,?,?)")
    .run(request.operationId, stableJson(request), await shadowWithdrawalRequestSha256(request), "archive-fixture", now);
  return db;
}

describe("V16 durable no-claim withdrawal archive", () => {
  it("pins an independent exact schema after whole-file and Wrangler-split execution", async () => {
    const whole = database(), split = new DatabaseSync(":memory:"); databases.push(split);
    for (const name of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
      for (const sql of splitSql(await readFile(join(migrationsDirectory, name), "utf8"))) split.exec(sql);
    }
    for (const db of [whole, split]) expect(await fileShadowSchemaFingerprint(db.prepare(
      "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name",
    ).all() as unknown as ExportSchemaObject[])).toBe(FILE_SHADOW_WITHDRAWAL_SCHEMA_FINGERPRINT_SHA256);
  }, 30_000);

  it("round-trips terminal receipts in legacy mode without inventing consumers or provider byte roots", async () => {
    const db = await fixture();
    const manifest = await snapshotFullExportV16(adapter(db));
    expect(manifest.tables.file_shadow_withdrawals).toEqual(db.prepare("SELECT * FROM file_shadow_withdrawals").all());
    expect(manifest.tables.file_shadow_operations).toEqual([]);
    expect(manifest.blobs).toEqual([]);
    const fetcher = vi.fn();
    const packaged = await buildFullExportArchiveV16(manifest, undefined, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    const directory = await mkdtemp(join(tmpdir(), "shadow-withdrawal-archive-")); directories.push(directory);
    const archivePath = join(directory, "archive.zip");
    await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
    const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
    const databasePath = join(restored.restoredDirectory, "database.sqlite");
    const recovered = new DatabaseSync(databasePath);
    try {
      expect(recovered.prepare("SELECT * FROM file_shadow_withdrawals").all()).toEqual(manifest.tables.file_shadow_withdrawals);
      expect(recovered.prepare("SELECT mode FROM file_authority_control").get()).toEqual({ mode: "legacy" });
      expect(recovered.prepare("SELECT enabled,incarnation FROM file_shadow_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
      expect(() => recovered.prepare("INSERT INTO file_shadow_operations(id) VALUES(?)").run(request.operationId)).toThrow(/withdrawn/);
      expect(() => recovered.exec("DELETE FROM file_shadow_withdrawals")).toThrow(/immutable/);
      expect((await snapshotFullExportV16(adapter(recovered))).tables).toEqual(manifest.tables);
    } finally { recovered.close(); }
    const outputPath = join(directory, "inspection.json");
    await inspectFileShadowSnapshot({ databasePath, outputPath });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({ schemaVersion: 16, executable: false, providerIO: false, runtime: { enabled: false } });
  }, 30_000);

  it.each(["request", "digest", "identity", "actor", "time", "duplicate"])("rejects corrupt %s receipts before any byte request", async (kind) => {
    const manifest = await snapshotFullExportV16(adapter(await fixture()));
    const row = manifest.tables.file_shadow_withdrawals[0];
    if (kind === "request") row.request_json = JSON.stringify(request, null, 2);
    if (kind === "digest") row.request_sha256 = "b".repeat(64);
    if (kind === "identity") row.operation_id = crypto.randomUUID();
    if (kind === "actor") row.created_by = "";
    if (kind === "time") row.created_at = "not a timestamp";
    if (kind === "duplicate") manifest.tables.file_shadow_withdrawals.push({ ...row });
    const fetcher = vi.fn();
    await expect(validateFullExportV16(manifest)).rejects.toThrow();
    await expect(buildFullExportArchiveV16(manifest, undefined, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("negotiates exact V15/V16 generations and refuses a partial withdrawal installation", async () => {
    const old = database("0008_fp1_shadow_runtime.sql"), current = database();
    for (const [db, version] of [[old, 15], [current, 16]] as const) {
      const env = { DB: adapter(db) } as Env;
      expect((await snapshotRoutes.request(`/exports/all?archiveSchema=${version}&archiveWriter=1`, {}, env)).status).toBe(200);
      expect((await snapshotRoutes.request(`/exports/all?archiveSchema=${version === 15 ? 16 : 15}&archiveWriter=1`, {}, env)).status).toBe(409);
    }
    await expect(snapshotFullExportV15(adapter(current))).rejects.toThrow();
    current.exec("DROP TRIGGER file_shadow_operations_withdrawal_guard");
    expect((await snapshotRoutes.request("/exports/all?archiveSchema=16&archiveWriter=1", {}, { DB: adapter(current) } as Env)).status).toBe(500);
  });
});
