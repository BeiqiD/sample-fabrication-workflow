import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { readStorageSettings } from "./settings-read-model";
import { managedBootstrapNamespace } from "../files/managed-bootstrap-profile";
import { activateFileAuthority } from "../files/authority-activation";
import { prepareR2StorageRoleDefaults } from "../files/storage-role-defaults";

const databases: DatabaseSync[] = [];
const now = "2026-09-28T12:00:00.000Z";
const r2Namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "private-r2-bucket" });
const configuration = { R2_BOOTSTRAP_NAMESPACE: r2Namespace, MANAGED_STORAGE_PROVIDER: "switchdrive", SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/private-account%40example.org/",
  SWITCHDRIVE_USERNAME: "private-user", SWITCHDRIVE_APP_PASSWORD: "private-password", SWITCHDRIVE_ROOT: "/private-root//nested/" };
function fixture(profiles = true) {
  const sql = referenceTestDatabase(); databases.push(sql); const local = new SqliteD1Database(sql), db = local as unknown as D1Database;
  if (profiles) {
    sql.prepare("INSERT INTO storage_profiles VALUES('profile-r2','r2',?,'bootstrap',NULL,1,'historical',?)").run(r2Namespace, now);
    sql.prepare("INSERT INTO storage_profiles VALUES('profile-managed','switchdrive',?,'environment','environment:SWITCHDRIVE',1,'historical',?)")
      .run(managedBootstrapNamespace(configuration), now);
  }
  const activate = () => {
    sql.prepare("INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at) SELECT 1,epoch,'private-operator@example.org',? FROM file_shadow_control").run(now);
    sql.prepare("INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at) VALUES('profile-r2',1,'private-operator@example.org',?)").run(now);
    sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='private-operator@example.org',updated_at=?").run(crypto.randomUUID(), now);
  };
  const activateAuthority = async () => {
    activate();
    sql.exec("UPDATE file_shadow_runtime_guard SET enabled=0");
    const cutoff = sql.prepare("SELECT c.epoch,r.incarnation FROM file_shadow_control c JOIN file_shadow_runtime_guard r ON r.singleton=c.singleton").get()!;
    await activateFileAuthority(db, "operator", { requestId: crypto.randomUUID(), expectedEpoch: Number(cutoff.epoch), expectedShadowIncarnation: cutoff.incarnation as string });
  };
  return { sql, local, db, activate, activateAuthority };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(database => database.close()); });

describe("read-only Storage Settings metadata", () => {
  it("reads one first-primary snapshot and returns only bounded safe configuration/profile metadata", async () => {
    const f = fixture(); f.activate(); const before = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const withSession = vi.fn(() => f.local), forbiddenPrepare = vi.fn(() => { throw new Error("Must use primary session"); });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await readStorageSettings({ withSession, prepare: forbiddenPrepare } as unknown as D1Database, configuration);
    expect(withSession).toHaveBeenCalledExactlyOnceWith("first-primary"); expect(f.local.queryCount).toBe(1);
    expect(forbiddenPrepare).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ version: 2, kind: "storage-settings-status", readOnly: true, configurationSource: "deployment", health: "not_checked",
      authority: { mode: "overlap", shadowConversions: "enabled" }, roleDefaults: { state: "legacy" }, bindings: { r2: { configuration: "configured" }, managed: { provider: "switchdrive", configuration: "configured" } },
      uploadDestinations: { ordinaryUploads: "r2", commentOriginals: "switchdrive" }, profiles: { items: [
        { id: "profile-managed", adapterType: "switchdrive", configurationRevision: 1, runtimeAccess: "read_only", bindingMatch: "matched" },
        { id: "profile-r2", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched" },
      ], hasMore: false, limit: 100 } });
    const encoded = JSON.stringify(result);
    for (const privateValue of [r2Namespace, "a".repeat(32), "private-r2-bucket", "private-account%40example.org", "private-user", "private-password", "private-root", "environment:SWITCHDRIVE", "private-operator@example.org", "namespace_identity", "credential_reference"])
      expect(encoded).not.toContain(privateValue);
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
  });

  it("does not register profiles just because deployment configuration is valid", async () => {
    const f = fixture(false), before = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const result = await readStorageSettings(f.db, configuration);
    expect(result).toMatchObject({ authority: { mode: "legacy", shadowConversions: "paused" }, bindings: { r2: { configuration: "configured" } },
      profiles: { items: [], hasMore: false, limit: 100 }, health: "not_checked" });
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
    expect(f.sql.prepare("SELECT count(*) n FROM storage_profiles").get()!.n).toBe(0);
  });

  it("reports planned R2 roles without bootstrapping them during an active Settings read", async () => {
    const f = fixture(); await f.activateAuthority();
    const before = f.sql.prepare("SELECT total_changes() n").get()!.n, queries = f.local.queryCount;
    const result = await readStorageSettings(f.db, { R2_BOOTSTRAP_NAMESPACE: r2Namespace });
    expect(result).toMatchObject({ authority: { mode: "active" }, roleDefaults: { state: "pending_bootstrap" },
      uploadDestinations: { ordinaryUploads: "r2", commentOriginals: "r2" },
      bindings: { managed: { provider: "none", configuration: "missing" } } });
    expect(f.sql.prepare("SELECT count(*) n FROM storage_role_defaults").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
    expect(f.local.queryCount - queries).toBe(1);
  });

  it("reads persisted defaults and reports drift without replacing their selected R2 destination", async () => {
    const f = fixture(); await f.activateAuthority();
    const policy = await prepareR2StorageRoleDefaults(f.db, configuration, now); await f.db.batch(policy.statements);
    const before = f.sql.prepare("SELECT total_changes() n").get()!.n, queries = f.local.queryCount;
    const result = await readStorageSettings(f.db, { R2_BOOTSTRAP_NAMESPACE: r2Namespace.replace("private-r2-bucket", "another-bucket") });
    expect(result).toMatchObject({ roleDefaults: { state: "configured" }, uploadDestinations: { commentOriginals: "r2" } });
    expect(result.profiles.items.find(profile => profile.id === "profile-r2")?.bindingMatch).toBe("mismatch");
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
    expect(f.local.queryCount - queries).toBe(1);
  });

  it.each([
    [{}, "none", "missing", "missing", "unconfigured"],
    [{ R2_BOOTSTRAP_NAMESPACE: " malformed secret ", MANAGED_STORAGE_PROVIDER: "secret-provider" }, "unsupported", "invalid", "invalid", "unsupported"],
    [{ ...configuration, R2_BOOTSTRAP_NAMESPACE: "" }, "switchdrive", "configured", "missing", "switchdrive"],
    [{ ...configuration, SWITCHDRIVE_APP_PASSWORD: "" }, "switchdrive", "missing", "configured", "switchdrive"],
    [{ ...configuration, SWITCHDRIVE_WEBDAV_URL: "http://private-insecure.example" }, "switchdrive", "invalid", "configured", "switchdrive"],
    [{ ...configuration, SWITCHDRIVE_ROOT: "../private-escape" }, "switchdrive", "invalid", "configured", "switchdrive"],
  ] as const)("classifies missing/invalid deployment fields without echoing inputs (%j)", async (env, provider, managedState, r2State, destination) => {
    const f = fixture(), result = await readStorageSettings(f.db, env);
    expect(result.bindings).toEqual({ r2: { configuration: r2State }, managed: { provider, configuration: managedState } });
    expect(result.uploadDestinations.commentOriginals).toBe(destination);
    for (const profile of result.profiles.items) expect(profile.bindingMatch).toBe((profile.adapterType === "r2" ? r2State : managedState) === "configured"
      ? "matched" : (profile.adapterType === "r2" ? r2State : managedState) === "missing" ? "not_configured" : "invalid_configuration");
    expect(JSON.stringify(result)).not.toContain("secret-provider"); expect(JSON.stringify(result)).not.toContain("private-escape");
  });

  it("distinguishes valid deployment drift from a matching frozen registered profile", async () => {
    const f = fixture();
    const result = await readStorageSettings(f.db, { ...configuration,
      R2_BOOTSTRAP_NAMESPACE: r2Namespace.replace("private-r2-bucket", "new-bucket"), SWITCHDRIVE_ROOT: "new-root" });
    expect(result.bindings.r2.configuration).toBe("configured"); expect(result.bindings.managed.configuration).toBe("configured");
    expect(result.profiles.items.map(profile => profile.bindingMatch)).toEqual(["mismatch", "mismatch"]);
  });

  it("returns at most 100 profiles and reports the bounded sentinel without an unbounded count", async () => {
    const f = fixture(false), insert = f.sql.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)");
    for (let index = 0; index < 103; index += 1) insert.run(`profile-${String(index).padStart(3, "0")}`, `historical:${index}`, now);
    const result = await readStorageSettings(f.db, configuration);
    expect(result.profiles.items).toHaveLength(100); expect(result.profiles.hasMore).toBe(true); expect(result.profiles.limit).toBe(100);
    expect(result.profiles.items[0].id).toBe("profile-000"); expect(result.profiles.items.at(-1)!.id).toBe("profile-099");
    expect(f.local.queryCount).toBe(1);
  });

  it("does not combine old authority/runtime with profiles changed after its SELECT", async () => {
    const f = fixture(), original = await readStorageSettings(f.db, configuration), prepare = f.local.prepare.bind(f.local); let changed = false;
    vi.spyOn(f.local, "prepare").mockImplementation(query => {
      const statement = prepare(query), bind = statement.bind.bind(statement);
      vi.spyOn(statement, "bind").mockImplementation((...values) => {
        const bound = bind(...values), all = bound.all.bind(bound);
        vi.spyOn(bound, "all").mockImplementation(async () => {
          const result = await all(); if (!changed) { changed = true; f.activate(); } return result;
        });
        return bound;
      }); return statement;
    });
    expect(await readStorageSettings(f.db, configuration)).toEqual(original);
    expect(await readStorageSettings(f.db, configuration)).toMatchObject({ authority: { mode: "overlap", shadowConversions: "enabled" },
      profiles: { items: [{ runtimeAccess: "read_only" }, { runtimeAccess: "read_write" }] } });
  });

  it.each(["authority", "runtime", "profile-runtime"])("fails closed on missing %s without exposing a raw database error", async target => {
    const f = fixture();
    const table = target === "authority" ? "file_authority_control" : target === "runtime" ? "file_shadow_runtime_guard" : "storage_profile_runtime";
    const triggers = f.sql.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table) as { name: string }[];
    for (const trigger of triggers) f.sql.exec(`DROP TRIGGER "${trigger.name}"`);
    f.sql.exec(`DELETE FROM ${table}`);
    await expect(readStorageSettings(f.db, configuration)).rejects.toThrow("Storage settings are temporarily unavailable.");
  });
});
