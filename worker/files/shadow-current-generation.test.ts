import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-file-native-runtime";
import { FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-file-migrations";
import { RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-research-packages";
import { SYSTEM_RECOVERY_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-system-recovery";
import { sha256Hex } from "../../shared/domain/content-addressing";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { acceptAndUploadR2Asset } from "../uploads/r2-upload-acceptance";
import { canonicalShadowMetadata, readShadowBaseline } from "./shadow-baseline";
import { convertShadowConsumer } from "./shadow-service";

const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(database => database.close()); });
const key = (id: string) => ({ consumerKind: "event", consumerId: id, consumerSubId: "", fileSlot: "primary" });

describe("operational shadow metadata on the current native File generations", () => {
  it.each([
    ["0018_fp2_native_file_runtime.sql", FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256],
    ["0019_fp3_file_jobs.sql", FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256],
    ["0020_fp4_research_packages.sql", RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256],
    ["0022_fp5_recovery_evidence.sql", SYSTEM_RECOVERY_SCHEMA_FINGERPRINT_SHA256],
  ] as const)("qualifies an actual historical consumer on %s within the unchanged complete schema bounds", async (throughMigration, fingerprint) => {
    const sql = referenceTestDatabase({ throughMigration }); databases.push(sql);
    const now = new Date().toISOString(), db = new SqliteD1Database(sql), opaqueKey = "historical/%2F shared key";
    sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample','SHADOW','Historical shadow consumer',?,?)").run(now, now);
    sql.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
      VALUES('asset',?,'historical.png','image/png',4,'ready',?,?)`).run(opaqueKey, "a".repeat(64), now);
    sql.prepare(`INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at)
      VALUES('historical-event','sample','image',?,'{"action":"sample_record"}',?)`).run(opaqueKey, now);
    const schema = sql.prepare("SELECT type,name,tbl_name table_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    expect(schema.length).toBeLessThanOrEqual(2048);
    expect(new TextEncoder().encode(JSON.stringify(schema)).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    const baseline = await readShadowBaseline(db, key("historical-event"));
    expect(baseline).toMatchObject({ version: 1, kind: "file-shadow-baseline", bytesVerified: false,
      schemaSha256: fingerprint, adjudication: null, head: { present: 1 }, purpose: "embedded_content",
      sourceLocator: { storeKind: "r2", provider: "r2", objectKey: opaqueKey } });
    expect(baseline.record).toMatchObject({ key: key("historical-event"), source: { asset_key: opaqueKey },
      locator: { storeKind: "r2", provider: "r2", objectKey: opaqueKey } });
    const { baselineSha256, ...metadata } = baseline;
    expect(baselineSha256).toBe(await sha256Hex(canonicalShadowMetadata(metadata)));
    expect(sql.prepare("SELECT count(*) n FROM file_shadow_operations").get()).toEqual({ n: 0 });
  });

  it("keeps a real native consumer's legacy locator empty and refuses legacy conversion after active File cutover", async () => {
    const f = await nativeAcceptanceFixture(); databases.push(f.sql);
    const uploaded = await acceptAndUploadR2Asset(f.env, { requestId: crypto.randomUUID(), actorEmail: f.actor,
      ingress: "ordinary_image", originalName: "native.png", mimeType: "image/png", bytes: Uint8Array.of(137, 80, 78, 71).buffer });
    expect(uploaded.state.status).toBe("ready");
    if (uploaded.state.status !== "ready" || uploaded.state.result.key !== null) throw new Error("Native publication was not accepted");
    const result = uploaded.state.result;
    f.sql.prepare(`INSERT INTO events(id,sample_id,kind,asset_key,asset_file_id,metadata_json,created_at)
      VALUES('native-event','sample-native','image',NULL,?,?,?)`).run(result.fileId, JSON.stringify({ action: "sample_record", assetId: result.id }), f.now);
    expect(f.sql.prepare("SELECT asset_key,asset_file_id FROM events WHERE id='native-event'").get())
      .toEqual({ asset_key: null, asset_file_id: result.fileId });
    expect(f.sql.prepare(`SELECT file_id,resolution_state,legacy_r2_object_key,legacy_managed_provider,legacy_managed_object_key
      FROM file_consumer_projection WHERE consumer_kind='event' AND consumer_id='native-event' AND file_slot='primary'`).get())
      .toEqual({ file_id: result.fileId, resolution_state: "resolved", legacy_r2_object_key: null,
        legacy_managed_provider: null, legacy_managed_object_key: null });
    // A native-only event has no legacy source key, so the frozen shadow
    // projection must not manufacture a legacy occurrence for it.
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_heads WHERE consumer_kind='event' AND consumer_id='native-event'").get())
      .toEqual({ n: 0 });
    const locations = f.sql.prepare("SELECT count(*) n FROM file_locations").get();
    f.s3Fetch.mockClear(); f.r2Get.mockClear(); f.r2Put.mockClear();
    await expect(readShadowBaseline(f.db, key("native-event"))).rejects.toThrow("Unsupported shadow authority mode");
    const openProfile = vi.fn(async () => { throw new Error("Unexpected legacy storage opening"); });
    await expect(convertShadowConsumer({ db: f.env.DB, actor: f.actor, runtimeIncarnation: crypto.randomUUID(), openProfile }, {
      operationId: crypto.randomUUID(), key: key("native-event"), expectedBaselineSha256: "a".repeat(64),
      destinationProfile: { profileId: "r2-profile", configurationRevision: 1 },
    })).rejects.toThrow();
    expect(openProfile).not.toHaveBeenCalled(); expect(f.s3Fetch).not.toHaveBeenCalled();
    expect(f.r2Get).not.toHaveBeenCalled(); expect(f.r2Put).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT count(*) n FROM file_locations").get()).toEqual(locations);
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_operations").get()).toEqual({ n: 0 });
  });
});
