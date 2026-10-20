import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { activateFileAuthority } from "../files/authority-activation";
import { prepareR2StorageRoleDefaults } from "../files/storage-role-defaults";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { originalFileStorageStatus } from "./originals-status";

const databases: DatabaseSync[] = [];
const now = "2026-09-30T12:00:00.000Z";
const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "private-fixture-bucket" });
async function fixture(writable = true) {
  const sql = referenceTestDatabase(); databases.push(sql); const local = new SqliteD1Database(sql), db = local as unknown as D1Database;
  sql.prepare("INSERT INTO storage_profiles VALUES('r2-profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
  sql.prepare("INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at) SELECT 1,epoch,'operator',? FROM file_shadow_control").run(now);
  if (writable) sql.prepare("INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at) VALUES('r2-profile',1,'operator',?)").run(now);
  await activateFileAuthority(db, "operator", { requestId: crypto.randomUUID(),
    expectedEpoch: Number(sql.prepare("SELECT epoch FROM file_shadow_control").get()!.epoch), expectedShadowIncarnation: null });
  const list = vi.fn(async () => ({ objects: [], truncated: false }));
  const provider = vi.fn(async () => { throw new Error("Historical provider must not be probed"); }); vi.stubGlobal("fetch", provider);
  const env = { DB: db, AUTH_MODE: "disabled", R2_BOOTSTRAP_NAMESPACE: namespace,
    ASSETS: { list }, MANAGED_STORAGE_PROVIDER: "switchdrive", SWITCHDRIVE_WEBDAV_URL: "invalid-old-location",
    SWITCHDRIVE_USERNAME: "private-user", SWITCHDRIVE_APP_PASSWORD: "private-password" } as unknown as Env;
  return { sql, db, list, provider, env };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(database => database.close()); });

describe("current original-file storage status", () => {
  it("allows first-upload R2 bootstrap without writing defaults or probing historical SWITCHdrive", async () => {
    const f = await fixture(), before = f.sql.prepare("SELECT total_changes() n").get()!.n;
    expect(await originalFileStorageStatus(f.env)).toEqual({ provider: "r2", available: true, authentication: "service_binding",
      message: "Cloudflare R2 is connected. New original files are stored without modification." });
    expect(f.sql.prepare("SELECT count(*) n FROM storage_role_defaults").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ limit: 1 }); expect(f.provider).not.toHaveBeenCalled();
  });

  it("reports the persisted R2 role after first acceptance and keeps it unchanged", async () => {
    const f = await fixture(), prepared = await prepareR2StorageRoleDefaults(f.db, f.env, now); await f.db.batch(prepared.statements);
    const rows = f.sql.prepare("SELECT * FROM storage_role_defaults ORDER BY role").all();
    expect(await originalFileStorageStatus(f.env)).toMatchObject({ provider: "r2", available: true });
    expect(f.sql.prepare("SELECT * FROM storage_role_defaults ORDER BY role").all()).toEqual(rows);
    expect(f.provider).not.toHaveBeenCalled();
  });

  it.each(["binding drift", "read only", "paused", "provider failure"])("keeps %s unavailable without switching back to historical storage", async problem => {
    const f = await fixture(problem !== "read only");
    if (problem === "binding drift") f.env.R2_BOOTSTRAP_NAMESPACE = namespace.replace("private-fixture-bucket", "different-bucket");
    if (problem === "paused") f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    if (problem === "provider failure") f.list.mockRejectedValueOnce(new Error("private-provider-error"));
    const result = await originalFileStorageStatus(f.env);
    expect(result).toMatchObject({ provider: "r2", available: false });
    expect(JSON.stringify(result)).not.toContain("private-"); expect(f.provider).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT count(*) n FROM storage_role_defaults").get()!.n).toBe(0);
    if (problem !== "provider failure") expect(f.list).not.toHaveBeenCalled();
  });

  it("keeps core readiness available while file execution and both optional providers are unavailable", async () => {
    const f = await fixture(); f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    f.list.mockRejectedValueOnce(new Error("R2 unavailable"));
    const response = await worker.fetch(new Request("https://app.test/api/ready"), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(f.list).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });

  it("returns private current-role status through the authenticated route", async () => {
    const f = await fixture();
    const response = await worker.fetch(new Request("https://app.test/api/storage/status"), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ provider: "r2", available: true });
    expect(f.provider).not.toHaveBeenCalled();
  });
});
