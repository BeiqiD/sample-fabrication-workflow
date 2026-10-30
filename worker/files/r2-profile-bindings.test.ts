import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import type { S3RequestOperation } from "../storage/s3-byte-adapter";
import { assertR2BootstrapProfile } from "./r2-bootstrap-profile";
import { openShadowProfile } from "./shadow-profile";
import { r2ProfileBindingStillCurrent, r2ProfileNamespace, resolveR2ProfileBinding } from "./r2-profile-bindings";

const source = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "source-fixture" });
const target = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "target-fixture" });
const profile = { id: "target-profile", configurationRevision: 1 as const, namespaceIdentity: target };
const map = (entries = { [profile.id]: { namespaceIdentity: target, bindingName: "R2_TARGET" } }) => JSON.stringify(entries);
function bucket() { return { get: vi.fn(async () => null), head: vi.fn(async () => null), put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) } as unknown as R2Bucket; }
function environment() { return { ASSETS: bucket(), R2_TARGET: bucket(), R2_BOOTSTRAP_NAMESPACE: source, R2_PROFILE_BINDINGS: map() }; }
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(database => database.close()); });

describe("deployment-owned exact R2 profile bindings", () => {
  it("resolves an independently declared bucket when the bootstrap declaration is unavailable, without provider I/O", () => {
    const env = { ...environment(), R2_BOOTSTRAP_NAMESPACE: "broken-bootstrap" };
    expect(r2ProfileNamespace(env, profile.id)).toBe(target);
    const resolved = resolveR2ProfileBinding(env, profile);
    expect(resolved.bucket).toBe(env.R2_TARGET); expect(resolved.bindingName).toBe("R2_TARGET");
    expect(Object.isFrozen(resolved)).toBe(true); expect(r2ProfileBindingStillCurrent(env, resolved)).toBe(true);
    expect(env.R2_TARGET.get).not.toHaveBeenCalled(); expect(env.ASSETS.get).not.toHaveBeenCalled();
  });

  it("preserves exact bootstrap resolution for undeclared registered profiles", () => {
    const env = environment();
    expect(resolveR2ProfileBinding(env, { ...profile, id: "source-profile", namespaceIdentity: source }).bucket).toBe(env.ASSETS);
    expect(() => resolveR2ProfileBinding(env, { ...profile, id: "missing-declaration" })).toThrow("unavailable");
    expect(env.ASSETS.get).not.toHaveBeenCalled(); expect(env.R2_TARGET.get).not.toHaveBeenCalled();
  });

  it("never falls back from an explicit unavailable binding to a namespace-matching ASSETS bucket", () => {
    const env = { ...environment(), R2_BOOTSTRAP_NAMESPACE: target, R2_TARGET: undefined };
    expect(r2ProfileNamespace(env, profile.id)).toBe(target);
    expect(() => resolveR2ProfileBinding(env, profile)).toThrow("unavailable");
    expect(env.ASSETS.get).not.toHaveBeenCalled();
  });

  it.each(["", "null", "[]", "{", JSON.stringify({ [profile.id]: { namespaceIdentity: target, bindingName: "target" } }),
    JSON.stringify({ [profile.id]: { namespaceIdentity: target, bindingName: "R2_TARGET", credential: "forbidden" } }),
    JSON.stringify({ [profile.id]: { namespaceIdentity: `${target} `, bindingName: "R2_TARGET" } }),
    JSON.stringify({ [profile.id]: { namespaceIdentity: target, bindingName: "A".repeat(65) } }),
    JSON.stringify({ "bad\0profile": { namespaceIdentity: target, bindingName: "R2_TARGET" } }),
    " ".repeat(262145), JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`profile-${index}`, { namespaceIdentity: target, bindingName: "R2_TARGET" }]))),
  ])("fails closed on an invalid deployment map %#", raw => {
    const env = { ...environment(), R2_PROFILE_BINDINGS: raw };
    expect(() => resolveR2ProfileBinding(env, profile)).toThrow("unavailable");
    expect(env.ASSETS.get).not.toHaveBeenCalled(); expect(env.R2_TARGET.get).not.toHaveBeenCalled();
  });

  it("rejects one binding name or capability object assigned to different physical namespaces", () => {
    const env = environment();
    const entries = { [profile.id]: { namespaceIdentity: target, bindingName: "R2_TARGET" },
      other: { namespaceIdentity: source, bindingName: "R2_TARGET" } };
    expect(() => resolveR2ProfileBinding({ ...env, R2_PROFILE_BINDINGS: map(entries) }, profile)).toThrow("unavailable");
    entries.other.bindingName = "R2_OTHER";
    expect(() => resolveR2ProfileBinding({ ...env, R2_OTHER: env.R2_TARGET, R2_PROFILE_BINDINGS: map(entries) }, profile)).toThrow("unavailable");
    expect(() => resolveR2ProfileBinding({ ...env, R2_TARGET: env.ASSETS }, profile)).toThrow("unavailable");
    expect(() => resolveR2ProfileBinding({ ...env, R2_PROFILE_BINDINGS: map({ [profile.id]: { namespaceIdentity: target, bindingName: "ASSETS" } }) }, profile)).toThrow("unavailable");
  });

  it("requires own deployment bindings and full capabilities for explicit mappings", () => {
    const env = environment(), inherited = Object.assign(Object.create({ R2_TARGET: env.R2_TARGET }), {
      ASSETS: env.ASSETS, R2_BOOTSTRAP_NAMESPACE: source, R2_PROFILE_BINDINGS: map(),
    });
    expect(() => resolveR2ProfileBinding(inherited, profile)).toThrow("unavailable");
    expect(() => resolveR2ProfileBinding({ ...env, R2_TARGET: { get: vi.fn() } }, profile, { allowLegacyBootstrap: true })).toThrow("unavailable");
    const legacy = { ASSETS: { get: vi.fn() } as unknown as R2Bucket, R2_BOOTSTRAP_NAMESPACE: source };
    expect(resolveR2ProfileBinding(legacy, { ...profile, namespaceIdentity: source }, { allowLegacyBootstrap: true }).bucket).toBe(legacy.ASSETS);
    expect(() => resolveR2ProfileBinding(legacy, { ...profile, namespaceIdentity: source })).toThrow("unavailable");
  });
});

function writableFixture() {
  const sql = referenceTestDatabase({ throughMigration: "0018_fp2_native_file_runtime.sql" }); databases.push(sql);
  const now = new Date().toISOString();
  sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'mapped-r2-fixture',? FROM file_shadow_control").run(now);
  sql.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)").run(profile.id, target, now);
  sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES(?,1,'mapped-r2-fixture',?)").run(profile.id, now);
  const env = { ...environment(), DB: new SqliteD1Database(sql) as unknown as D1Database, AUTH_MODE: "disabled" } as Env & { R2_TARGET: R2Bucket };
  return { sql, env };
}

describe("mapped R2 profile lifecycle fences", () => {
  it("asserts the registered additional namespace without creating profiles or making provider I/O", async () => {
    const f = writableFixture();
    expect(await assertR2BootstrapProfile(f.env.DB, f.env, profile.id, 1)).toEqual(profile);
    const opened = await openShadowProfile(f.env, { profileId: profile.id, configurationRevision: 1 }, "write");
    expect(await opened.reader.read("opaque/%2F space")).toEqual({ outcome: "missing" });
    expect(f.env.R2_TARGET.get).toHaveBeenCalledExactlyOnceWith("opaque/%2F space");
    expect(f.env.ASSETS.get).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT count(*) n FROM storage_profiles").get()).toEqual({ n: 1 });
  });

  it.each(["GET", "HEAD", "PUT", "DELETE"] as const)("blocks %s after the caller replaces the actual mapped capability", async method => {
    const f = writableFixture(), original = f.env.R2_TARGET;
    const beforeRequest = vi.fn(async (operation: S3RequestOperation) => {
      expect(operation).toEqual({ method, key: "opaque/%2F space" }); expect(Object.isFrozen(operation)).toBe(true);
      f.env.R2_TARGET = bucket(); return true;
    });
    const opened = await openShadowProfile(f.env, { profileId: profile.id, configurationRevision: 1 }, "write", { beforeRequest });
    if (method === "GET") expect(await opened.reader.read("opaque/%2F space")).toEqual({ outcome: "unavailable" });
    if (method === "HEAD") expect(await opened.reader.stat("opaque/%2F space")).toEqual({ outcome: "unavailable" });
    if (method === "DELETE") expect(await opened.deleter!.delete("opaque/%2F space")).toEqual({ outcome: "unavailable" });
    if (method === "PUT") await expect(opened.writer!.write({ key: "opaque/%2F space", body: new ArrayBuffer(0), byteSize: 0,
      sha256: "a".repeat(64), filename: "empty.bin", contentType: "application/octet-stream" })).rejects.toMatchObject({ phase: "destination", reason: "unavailable" });
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    for (const binding of [original, f.env.R2_TARGET, f.env.ASSETS]) {
      expect(binding.get).not.toHaveBeenCalled(); expect(binding.head).not.toHaveBeenCalled();
      expect(binding.put).not.toHaveBeenCalled(); expect(binding.delete).not.toHaveBeenCalled();
    }
  });

  it("blocks a changed raw map after the caller's suspension, even when its selected entry has equivalent fields", async () => {
    const f = writableFixture();
    const opened = await openShadowProfile(f.env, { profileId: profile.id, configurationRevision: 1 }, "read", {
      beforeRequest: async () => { f.env.R2_PROFILE_BINDINGS = `${f.env.R2_PROFILE_BINDINGS} `; return true; },
    });
    expect(await opened.reader.read("owned/file")).toEqual({ outcome: "unavailable" });
    expect(f.env.R2_TARGET.get).not.toHaveBeenCalled(); expect(f.env.ASSETS.get).not.toHaveBeenCalled();
  });
});
