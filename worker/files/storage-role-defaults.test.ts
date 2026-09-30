import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteD1Database } from "../reference-test-support";
import { futureActiveRuntimeDatabase } from "./authority-runtime-test-support";
import { prepareR2StorageRoleDefaults, readStorageRoleDefaults } from "./storage-role-defaults";

const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "role-test-assets" });
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const now = new Date().toISOString();
  const sql = futureActiveRuntimeDatabase(db => {
    db.prepare("INSERT INTO storage_profiles VALUES('existing-r2','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
    db.prepare("INSERT INTO file_shadow_profile_enablements VALUES('existing-r2',1,'role-test',?)").run(now);
  });
  databases.push(sql);
  return { sql, db: new SqliteD1Database(sql) as unknown as D1Database, env: { R2_BOOTSTRAP_NAMESPACE: namespace }, now };
}
describe("once-only R2 role policy", () => {
  it("purely reads before bootstrap and rolls both roles back with a failed acceptance", async () => {
    const f = fixture();
    expect(await readStorageRoleDefaults(f.db)).toBeNull();
    const prepared = await prepareR2StorageRoleDefaults(f.db, f.env, f.now);
    expect(await readStorageRoleDefaults(f.db)).toBeNull();
    await expect(f.db.batch([...prepared.statements, f.db.prepare("SELECT json('rejected business acceptance')")])).rejects.toThrow();
    expect(await readStorageRoleDefaults(f.db)).toBeNull();
    await f.db.batch(prepared.statements);
    expect(await readStorageRoleDefaults(f.db)).toMatchObject({ internal: { role: "internal", storageProfileId: "existing-r2", policyRevision: 2 },
      originals: { role: "originals", storageProfileId: "existing-r2", policyRevision: 2 } });
  });
  it("keeps the actual recorded defaults and timestamps across restarted acceptance", async () => {
    const f = fixture();
    await f.db.batch((await prepareR2StorageRoleDefaults(f.db, f.env, f.now)).statements);
    const before = await readStorageRoleDefaults(f.db);
    await f.db.batch((await prepareR2StorageRoleDefaults(f.db, f.env, new Date(Date.parse(f.now) + 1000).toISOString())).statements);
    expect(await readStorageRoleDefaults(f.db)).toEqual(before);
    expect(() => f.sql.exec("UPDATE storage_role_defaults SET created_at='2026-09-01T00:00:00.000Z'")).toThrow(/initialized once/);
    expect(() => f.sql.exec("DELETE FROM storage_role_defaults")).toThrow(/cannot be deleted/);
    f.sql.exec("PRAGMA recursive_triggers=OFF");
    expect(() => f.sql.prepare(`INSERT OR REPLACE INTO storage_role_defaults VALUES('originals','existing-r2',1,2,?)`)
      .run("2026-09-01T00:00:00.000Z")).toThrow(/initialized once/);
    expect(await readStorageRoleDefaults(f.db)).toEqual(before);
    await expect(prepareR2StorageRoleDefaults(f.db, { R2_BOOTSTRAP_NAMESPACE: namespace.replace('a'.repeat(32), 'b'.repeat(32)) }, f.now)).rejects.toThrow();
    expect(await readStorageRoleDefaults(f.db)).toEqual(before);
  });
  it("does not enable a read-only profile or mutate defaults when local execution is disabled", async () => {
    const f = fixture();
    f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    await expect(prepareR2StorageRoleDefaults(f.db, f.env, f.now)).rejects.toThrow();
    expect(await readStorageRoleDefaults(f.db)).toBeNull();
    expect(f.sql.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id='existing-r2'").get()!.state).toBe("read_write");
  });
});
