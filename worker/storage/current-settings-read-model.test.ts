import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { readCurrentStorageSettings, readStorageSettings } from "./settings-read-model";
import worker from "../index";
import type { Env } from "../types";
import { managedBootstrapNamespace } from "../files/managed-bootstrap-profile";
import { futureActiveRuntimeDatabase } from "../files/authority-runtime-test-support";
import { setStorageRoleDefaults } from "./storage-role-policy";

const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); });
async function fixture() { const f = await nativeAcceptanceFixture(false); databases.push(f.sql); return f; }
async function mappedR2Fixture() {
  const now = new Date().toISOString(), namespaces = ["main", "independent", "readonly"].map(name => JSON.stringify({
    kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: `private-${name}-bucket` }));
  const sql = futureActiveRuntimeDatabase(database => {
    for (const [index, name] of ["main", "independent", "readonly"].entries()) {
      database.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)").run(`r2-${name}`, namespaces[index], now);
      if (name !== "readonly") database.prepare("INSERT INTO file_shadow_profile_enablements VALUES(?,1,'fixture',?)").run(`r2-${name}`, now);
    }
  });
  databases.push(sql);
  const bucket = () => ({ get: vi.fn(), head: vi.fn(), put: vi.fn(), delete: vi.fn() }), main = bucket(), independent = bucket(), readonly = bucket();
  const db = new SqliteD1Database(sql), env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.test",
    R2_BOOTSTRAP_NAMESPACE: namespaces[0], ASSETS: main,
    R2_PROFILE_BINDINGS: JSON.stringify({ "r2-independent": { namespaceIdentity: namespaces[1], bindingName: "INDEPENDENT_R2" },
      "r2-readonly": { namespaceIdentity: namespaces[2], bindingName: "READONLY_R2" } }), INDEPENDENT_R2: independent, READONLY_R2: readonly } as unknown as Env;
  await setStorageRoleDefaults(env, { operationId: crypto.randomUUID(), expectedPolicyRevision: null,
    internalProfileId: "r2-main", originalsProfileId: "r2-independent" }, "admin@example.test");
  return { sql, db, env, main, independent, readonly };
}
describe("current Storage Settings successor", () => {
  it("projects exact independent roles and authenticated local availability without writes or provider requests", async () => {
    const f = await fixture(), io = vi.fn(() => { throw new Error("Forbidden provider I/O"); }); vi.stubGlobal("fetch", io);
    const changes = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const value = await readCurrentStorageSettings(f.env.DB, f.env);
    expect(value).toMatchObject({ version: 3, health: "not_checked", authority: { mode: "active", fileAccess: "enabled" },
      roleDefaults: { state: "configured", policyRevision: 3, internal: { profileId: "r2-profile", adapterType: "r2", availability: "available" },
        originals: { profileId: f.admission.nativeProfileId, adapterType: "s3", availability: "available" } } });
    expect(value.profiles.items.find(profile => profile.id === f.admission.nativeProfileId)).toMatchObject({ runtimeAccess: "read_write", bindingMatch: "matched",
      bindingRevision: 1, availability: "available" });
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(changes);
    expect(io).not.toHaveBeenCalled(); expect(f.s3Fetch).not.toHaveBeenCalled(); expect(f.r2Put).not.toHaveBeenCalled(); expect(f.r2Get).not.toHaveBeenCalled();
    for (const secret of ["namespace_identity", "credential_ref", "configuration_sha256", "ciphertext", f.saved.credentials.ref, f.actor]) expect(JSON.stringify(value)).not.toContain(secret);
    await expect(readStorageSettings(f.env.DB, f.env)).rejects.toThrow("Storage settings are temporarily unavailable.");
  });
  it("retains unavailable selected S3 and independently available R2 when encryption keys disappear", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = undefined;
    const value = await readCurrentStorageSettings(f.env.DB, f.env);
    expect(value).toMatchObject({ version: 3, roleDefaults: { policyRevision: 3,
      internal: { profileId: "r2-profile", availability: "available" }, originals: { profileId: f.admission.nativeProfileId, availability: "unavailable" } } });
    expect(value.profiles.items.find(profile => profile.id === f.admission.nativeProfileId)).toMatchObject({ bindingRevision: 1, availability: "unavailable" });
    expect(f.s3Fetch).not.toHaveBeenCalled(); expect(f.r2Put).not.toHaveBeenCalled();
  });
  it("keeps a registered read-only native profile visible without manufacturing activation or role choices", async () => {
    const sql = referenceTestDatabase(); databases.push(sql);
    const namespace = JSON.stringify({ kind: "aws-s3", partition: "aws", accountId: "123456789012", bucketName: "private-bucket", root: "private-root" });
    const id = `storage-profile:aws-s3:${createHash("sha256").update(namespace).digest("hex")}`;
    sql.prepare("INSERT INTO storage_profiles VALUES(?,'s3',?,'system',NULL,1,'historical','2026-10-05T00:00:00.000Z')").run(id, namespace);
    const value = await readCurrentStorageSettings(new SqliteD1Database(sql) as unknown as D1Database, {});
    expect(value).toMatchObject({ version: 3, roleDefaults: { state: "legacy", policyRevision: null, internal: null, originals: null } });
    expect(value.profiles.items).toEqual([{ id, adapterType: "s3", configurationRevision: 1, runtimeAccess: "read_only",
      bindingMatch: "registered", bindingRevision: null, availability: "registered" }]);
    expect(JSON.stringify(value)).not.toMatch(/private-bucket|private-root|123456789012/);
  });
  it("reports restored portable writable history without local credential bindings as unavailable", async () => {
    const f = await fixture();
    // A restore preserves portable activation history but omits installation
    // bindings. Simulate that exact boundary on the qualified source fixture.
    f.sql.exec("DROP TRIGGER system_storage_native_bindings_delete_guard; DELETE FROM system_storage_native_bindings");
    const value = await readCurrentStorageSettings(f.env.DB, f.env);
    expect(value).toMatchObject({ version: 3, roleDefaults: { originals: { profileId: f.admission.nativeProfileId, availability: "unavailable" } } });
    expect(value.profiles.items.find(profile => profile.id === f.admission.nativeProfileId)).toMatchObject({ runtimeAccess: "read_write",
      availability: "unavailable", bindingMatch: "mismatch", bindingRevision: null });
    expect(f.s3Fetch).not.toHaveBeenCalled();
  });
  it("opens existing writable managed storage locally without making it a selectable upload role", async () => {
    const sql = referenceTestDatabase(); databases.push(sql);
    const env = { MANAGED_STORAGE_PROVIDER: "switchdrive", SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/private-account/",
      SWITCHDRIVE_USERNAME: "private-account", SWITCHDRIVE_APP_PASSWORD: "private-secret", SWITCHDRIVE_ROOT: "private-root" };
    const now = "2026-10-05T00:00:00.000Z";
    sql.prepare("INSERT INTO storage_profiles VALUES('managed','switchdrive',?,'environment','environment:SWITCHDRIVE',1,'historical',?)")
      .run(managedBootstrapNamespace(env), now);
    sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'fixture',? FROM file_shadow_control").run(now);
    sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES('managed',1,'fixture',?)").run(now);
    const io = vi.fn(() => { throw new Error("Provider request forbidden"); }); vi.stubGlobal("fetch", io);
    const value = await readCurrentStorageSettings(new SqliteD1Database(sql) as unknown as D1Database, env);
    expect(value).toMatchObject({ version: 3, roleDefaults: { state: "legacy", internal: null, originals: null } });
    expect(value.profiles.items[0]).toMatchObject({ adapterType: "switchdrive", availability: "available", runtimeAccess: "read_write", bindingRevision: null });
    expect(io).not.toHaveBeenCalled(); expect(JSON.stringify(value)).not.toMatch(/private-account|private-secret|private-root/);
  });
  it("selects the explicit successor over the authenticated route even while File execution is paused", async () => {
    const f = await fixture(); f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const response = await worker.fetch(new Request("https://app.test/api/settings/storage?version=3"), { ...f.env, AUTH_MODE: "disabled" } as Env, context);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ version: 3, authority: { fileAccess: "paused" }, roleDefaults: { policyRevision: 3 } });
    const old = await worker.fetch(new Request("https://app.test/api/settings/storage"), { ...f.env, AUTH_MODE: "disabled" } as Env, context);
    expect(old.status).toBe(503); expect(await old.json()).toEqual({ error: "Storage settings are temporarily unavailable." });
    const invalid = await worker.fetch(new Request("https://app.test/api/settings/storage?version=4"), { ...f.env, AUTH_MODE: "disabled" } as Env, context);
    expect(invalid.status).toBe(400); expect(f.s3Fetch).not.toHaveBeenCalled();
  });
  it("reads the frozen V2 generation when the historical schema has no current policy tables", async () => {
    const sql = referenceTestDatabase({ throughMigration: "0017_fp2_native_storage_profiles.sql" }); databases.push(sql);
    expect(await readCurrentStorageSettings(new SqliteD1Database(sql) as unknown as D1Database, {})).toMatchObject({ version: 2, roleDefaults: { state: "legacy" } });
  });
  it("matches independent registered R2 mappings without relying on a broken bootstrap binding", async () => {
    const f = await mappedR2Fixture();
    f.env.R2_BOOTSTRAP_NAMESPACE = "private-broken-bootstrap";
    const changes = f.sql.prepare("SELECT total_changes() n").get()!.n, io = vi.fn(); vi.stubGlobal("fetch", io);
    const value = await readCurrentStorageSettings(f.env.DB, f.env);
    expect(value).toMatchObject({ version: 3, bindings: { r2: { configuration: "invalid" } },
      roleDefaults: { policyRevision: 3, internal: { profileId: "r2-main", availability: "unavailable" },
        originals: { profileId: "r2-independent", availability: "available" } } });
    expect(value.profiles.items.find(profile => profile.id === "r2-independent")).toMatchObject({ bindingMatch: "matched", availability: "available" });
    expect(value.profiles.items.find(profile => profile.id === "r2-readonly")).toMatchObject({ bindingMatch: "matched", availability: "unavailable", runtimeAccess: "read_only" });
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(changes); expect(io).not.toHaveBeenCalled();
    for (const bucket of [f.main, f.independent, f.readonly]) for (const method of Object.values(bucket)) expect(method).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).not.toMatch(/private-.*bucket|private-broken-bootstrap|INDEPENDENT_R2|READONLY_R2/);
  });
  it("keeps mapped destinations outside a truncated page and validates the extra profile without claiming a complete list", async () => {
    const f = await mappedR2Fixture(), now = new Date().toISOString();
    const insert = f.sql.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)");
    for (let index = 0; index < 100; index++) insert.run(`aa-${String(index).padStart(3, "0")}`, `historical:${index}`, now);
    const value = await readCurrentStorageSettings(f.env.DB, f.env);
    expect(value.profiles.items).toHaveLength(100); expect(value.profiles.hasMore).toBe(true);
    expect(value).toMatchObject({ version: 3, roleDefaults: { internal: { profileId: "r2-main", availability: "available" },
      originals: { profileId: "r2-independent", availability: "available" } } });
    expect(value.profiles.items.every(profile => profile.id.startsWith("aa-"))).toBe(true);
  });
});
