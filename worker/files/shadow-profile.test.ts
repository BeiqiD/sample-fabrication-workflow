import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { openShadowProfile } from "./shadow-profile";
import { managedBootstrapNamespace } from "./managed-bootstrap-profile";

const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "file-shadow-test" });
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.unstubAllGlobals(); });
function fixture(recordedNamespace = namespace) {
  const sql = referenceTestDatabase({ throughMigration: "0007_fp1_file_authority_transition.sql" });
  databases.push(sql);
  sql.prepare(`INSERT INTO storage_profiles VALUES ('bound-r2','r2',?,'bootstrap',NULL,1,'historical','2026-09-25T00:00:00.000Z')`).run(recordedNamespace);
  const get = vi.fn(async () => null);
  const put = vi.fn(async () => { throw new Error("Unexpected write"); });
  const env = { DB: new SqliteD1Database(sql), ASSETS: { get, head: get, put }, R2_BOOTSTRAP_NAMESPACE: namespace } as unknown as Env;
  return { env, get, put };
}
describe("exact File shadow profile binding", () => {
  it("binds the recorded namespace without provider I/O, registration or default selection", async () => {
    const { env, get, put } = fixture();
    const bound = await openShadowProfile(env, { profileId: "bound-r2", configurationRevision: 1 }, "read");
    expect(bound.storage).toEqual({ profileId: "bound-r2", configurationRevision: 1, adapterType: "r2", namespaceIdentity: namespace });
    expect(bound.writer).toBeUndefined();
    expect(bound.deleter).toBeUndefined();
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect(await bound.reader.read("exact-key")).toEqual({ outcome: "missing" });
    expect(get).toHaveBeenCalledExactlyOnceWith("exact-key");
  });
  it("does not infer access from a matching profile ID or adapter label", async () => {
    const other = JSON.stringify({ kind: "cloudflare-r2", accountId: "b".repeat(32), bucketName: "file-shadow-test" });
    const { env, get, put } = fixture(other);
    await expect(openShadowProfile(env, { profileId: "bound-r2", configurationRevision: 1 }, "read")).rejects.toThrow("recorded File storage profile is unavailable");
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
  it("rejects missing/revised identities and read-only destinations before transport", async () => {
    const { env, get, put } = fixture();
    for (const frozen of [{ profileId: "missing", configurationRevision: 1 }, { profileId: "bound-r2", configurationRevision: 2 }]) {
      await expect(openShadowProfile(env, frozen, "read")).rejects.toThrow("profile is unavailable");
    }
    await expect(openShadowProfile(env, { profileId: "bound-r2", configurationRevision: 1 }, "write")).rejects.toThrow("profile is unavailable");
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
});

function writableFixture(managed = false) {
  const sql = referenceTestDatabase(); databases.push(sql);
  const remove = vi.fn(async () => undefined), get = vi.fn(async () => null), put = vi.fn();
  const providerFetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", providerFetch);
  const env = { DB: new SqliteD1Database(sql), ASSETS: { get, head: get, put, delete: remove },
    R2_BOOTSTRAP_NAMESPACE: namespace, MANAGED_STORAGE_PROVIDER: "switchdrive",
    SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/fixture%40example.test",
    SWITCHDRIVE_USERNAME: "fixture@example.test", SWITCHDRIVE_APP_PASSWORD: "fixture-only", SWITCHDRIVE_ROOT: "research" } as unknown as Env;
  const now = new Date().toISOString();
  sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'test',? FROM file_shadow_control").run(now);
  sql.prepare("INSERT INTO storage_profiles VALUES('bound',?,?,?,?,1,'historical',?)")
    .run(managed ? "switchdrive" : "r2", managed ? managedBootstrapNamespace(env) : namespace,
      managed ? "environment" : "bootstrap", managed ? "environment:SWITCHDRIVE" : null, now);
  sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES('bound',1,'test',?)").run(now);
  return { sql, env, remove, get, put, providerFetch };
}

describe("profile-bound File deletion", () => {
  it("captures one immutable target, exposes deletion only on write access and consults a new primary session each time", async () => {
    const f = writableFixture(), database = f.env.DB;
    const sessions: { constraint: string | undefined; queries: string[] }[] = [];
    f.env.DB = { withSession(constraint: string | undefined) {
      const session = { constraint, queries: [] as string[] }; sessions.push(session);
      return { prepare(sql: string) { session.queries.push(sql); return database.prepare(sql); } };
    } } as unknown as D1Database;
    const frozen = { profileId: "bound", configurationRevision: 1 };
    const bound = await openShadowProfile(f.env, frozen, "write");
    frozen.profileId = "changed";
    expect(Object.isFrozen(bound.storage)).toBe(true);
    expect(() => { bound.storage.profileId = "changed"; }).toThrow();
    expect(bound.writer).toBeDefined(); expect(bound.deleter).toBeDefined();
    expect(f.remove).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
    expect(await bound.deleter!.delete("exact-key")).toEqual({ outcome: "acknowledged" });
    expect(await bound.deleter!.delete("other-key")).toEqual({ outcome: "acknowledged" });
    const guards = sessions.filter(session => session.queries.some(sql => sql.startsWith("SELECT 1 AS writable")));
    expect(guards).toHaveLength(2); expect(guards.every(session => session.queries.length === 1)).toBe(true);
    expect(sessions.every(session => session.constraint === "first-primary")).toBe(true);
    expect(f.remove.mock.calls).toEqual([["exact-key"], ["other-key"]]);
    const readOnly = await openShadowProfile(f.env, { profileId: "bound", configurationRevision: 1 }, "read");
    expect(readOnly.deleter).toBeUndefined();
  });

  it.each(["false", "throws", "binding", "namespace"])("prevents deletion after a final lifecycle failure or binding change: %s", async mode => {
    const f = writableFixture(), replacement = vi.fn(async () => undefined);
    const beforeDelete = vi.fn(async (key: string) => {
      expect(key).toBe("owned/file");
      if (mode === "throws") throw new Error("private credential detail");
      if (mode === "binding") f.env.ASSETS = { delete: replacement } as unknown as R2Bucket;
      if (mode === "namespace") f.env.R2_BOOTSTRAP_NAMESPACE = namespace.replace("file-shadow-test", "different-files");
      return mode !== "false";
    });
    const bound = await openShadowProfile(f.env, { profileId: "bound", configurationRevision: 1 }, "write", { beforeDelete });
    expect(await bound.deleter!.delete("owned/file")).toEqual({ outcome: "unavailable" });
    expect(beforeDelete).toHaveBeenCalledOnce();
    expect(f.remove).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });

  it("fails closed when the final primary profile observation is missing, before invoking the caller or provider", async () => {
    const f = writableFixture(), database = f.env.DB, beforeDelete = vi.fn(async () => true);
    let missing = false;
    f.env.DB = { withSession: () => ({ prepare: (sql: string) => missing && sql.startsWith("SELECT 1 AS writable")
      ? { bind: () => ({ first: async () => null }) } : database.prepare(sql) }) } as unknown as D1Database;
    const bound = await openShadowProfile(f.env, { profileId: "bound", configurationRevision: 1 }, "write", { beforeDelete });
    missing = true;
    expect(await bound.deleter!.delete("owned/file")).toEqual({ outcome: "unavailable" });
    expect(beforeDelete).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });

  it("uses the same SWITCHdrive instance and preserves safe denial semantics without R2 fallback", async () => {
    const f = writableFixture(true);
    const bound = await openShadowProfile(f.env, { profileId: "bound", configurationRevision: 1 }, "write");
    expect(f.providerFetch).not.toHaveBeenCalled();
    f.providerFetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await bound.deleter!.delete("owned/file")).toEqual({ outcome: "denied", status: 403 });
    expect(f.providerFetch).toHaveBeenCalledExactlyOnceWith(
      "https://drive.switch.ch/remote.php/dav/files/fixture%40example.test/research/owned/file",
      expect.objectContaining({ method: "DELETE", redirect: "manual" }));
    expect(f.remove).not.toHaveBeenCalled();
    f.env.SWITCHDRIVE_APP_PASSWORD = "fixture-rotated";
    expect(await bound.deleter!.delete("owned/file")).toEqual({ outcome: "unavailable" });
    expect(f.providerFetch).toHaveBeenCalledOnce();
  });
});
