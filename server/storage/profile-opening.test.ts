import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asJobSqlDatabase, createSqliteCapability } from "../sqlite";
import { ByteVerificationError, verifyStoredBytes } from "../../worker/files/byte-verification";
import { openStorageProfile, ShadowProfileUnavailableError, type FileByteOperation,
  type RegisteredStorageProfile, type OpenedStorageProfile, type StorageProfileOpeningCapabilities } from "../../worker/files/storage-profile-opening";
import type { JobSqlDatabase, JobSqlStatement } from "../../worker/files/jobs/sql-repository";
import { openLocalByteStorage, type LocalByteStorage } from "./local-byte-storage";
import { nodeSha256 } from "./node-sha256";

const roots: string[] = [], closes: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const target = { profileId: "profile", configurationRevision: 1 };
const registered = { adapter_type: "r2", configuration_revision: 1, namespace_identity: "exact-registered-namespace", state: "read_write" };
function plainOpening() {
  const read = vi.fn(async () => ({ outcome: "missing" as const }));
  const writer = { accepts: "both" as const, write: vi.fn(async () => undefined) };
  const deleter = { delete: vi.fn(async () => ({ outcome: "acknowledged" as const })) };
  const opened: OpenedStorageProfile<"r2"> = { storage: { ...target, adapterType: "r2", namespaceIdentity: registered.namespace_identity },
    reader: { read, stat: read }, writer, deleter, createHash: nodeSha256 };
  const first = vi.fn(async () => ({ ...registered }));
  const bind = vi.fn(() => ({ first } as unknown as JobSqlStatement));
  const prepare = vi.fn(() => ({ bind } as unknown as JobSqlStatement));
  const database = { prepare, primary: vi.fn(() => ({ prepare })) } as unknown as JobSqlDatabase;
  const openProvider = vi.fn<StorageProfileOpeningCapabilities<"r2">["openProvider"]>(async () => opened);
  const isCurrent = vi.fn(() => true);
  const capabilities: StorageProfileOpeningCapabilities<"r2"> = { database, isCurrent, openProvider };
  return { capabilities, opened, openProvider, isCurrent, first, bind, prepare, read, writer, deleter };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
describe("neutral registered File profile opening", () => {
  it("uses primary SQL and freezes the exact recorded descriptor, without performing byte I/O", async () => {
    const f = plainOpening(), result = await openStorageProfile(f.capabilities, target, "write");
    expect(f.capabilities.database.primary).toHaveBeenCalledOnce();
    expect(f.bind).toHaveBeenCalledExactlyOnceWith("profile");
    expect(f.openProvider).toHaveBeenCalledWith({ ...target, adapterType: "r2", namespaceIdentity: registered.namespace_identity,
      runtimeState: "read_write" }, "write", expect.objectContaining({ beforeRequest: expect.any(Function) }));
    expect(Object.isFrozen(result.storage)).toBe(true);
    expect(Object.isFrozen(f.openProvider.mock.calls[0]![0])).toBe(true);
    expect(f.read).not.toHaveBeenCalled(); expect(f.writer.write).not.toHaveBeenCalled(); expect(f.deleter.delete).not.toHaveBeenCalled();
    expect(result.storage).not.toBe(f.opened.storage);
  });
  it.each(["missing", "revision", "retired", "readonly", "namespace"])("rejects unavailable recorded authority before provider opening: %s", async mode => {
    const f = plainOpening();
    f.first.mockResolvedValue(mode === "missing" ? null as never : { ...registered,
      ...(mode === "revision" ? { configuration_revision: 2 } : {}), ...(mode === "retired" ? { state: "retired" } : {}),
      ...(mode === "readonly" ? { state: "read_only" } : {}), ...(mode === "namespace" ? { namespace_identity: "\0bad" } : {}) });
    await expect(openStorageProfile(f.capabilities, target, "write")).rejects.toBeInstanceOf(ShadowProfileUnavailableError);
    expect(f.openProvider).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["profileId", "configurationRevision", "adapterType", "namespaceIdentity"] as const)("refuses a provider that returned a different %s without fallback", async field => {
    const f = plainOpening();
    f.opened.storage = { ...f.opened.storage, [field]: field === "configurationRevision" ? 2 : "different" };
    await expect(openStorageProfile(f.capabilities, target, "write")).rejects.toThrow("recorded File storage profile is unavailable");
    expect(f.openProvider).toHaveBeenCalledOnce(); expect(f.read).not.toHaveBeenCalled();
  });
  it("strips write/deletion capabilities from a read-only opening", async () => {
    const f = plainOpening(); f.first.mockResolvedValue({ ...registered, state: "read_only" });
    const result = await openStorageProfile(f.capabilities, target, "read");
    expect(result.writer).toBeUndefined(); expect(result.deleter).toBeUndefined();
    expect(await result.reader.read("opaque")).toEqual({ outcome: "missing" });
  });
  it("captures target and lifecycle functions before a delayed primary lookup", async () => {
    const f = plainOpening(), pending = deferred<typeof registered>(); f.first.mockReturnValue(pending.promise);
    const frozen = { ...target }, originalDelete = vi.fn(async () => true), replaced = vi.fn(async () => false);
    const lifecycle = { beforeDelete: originalDelete };
    const opening = openStorageProfile(f.capabilities, frozen, "write", lifecycle);
    frozen.profileId = "changed"; lifecycle.beforeDelete = replaced;
    pending.resolve({ ...registered }); await opening;
    const providerLifecycle = f.openProvider.mock.calls[0]![2];
    expect(await providerLifecycle.beforeRequest({ method: "DELETE", key: "exact/key" })).toBe(true);
    expect(originalDelete).toHaveBeenCalledExactlyOnceWith("exact/key"); expect(replaced).not.toHaveBeenCalled();
    expect(f.bind).toHaveBeenCalledExactlyOnceWith("profile");
  });
  it("captures the original DELETE operation while an asynchronous caller fence is pending", async () => {
    const f = plainOpening(), pending = deferred<boolean>(), beforeDelete = vi.fn(async () => true);
    await openStorageProfile(f.capabilities, target, "write", { beforeRequest: () => pending.promise, beforeDelete });
    const operation: { method: FileByteOperation["method"]; key: string } = { method: "DELETE", key: "original/key" };
    const allowed = f.openProvider.mock.calls[0]![2].beforeRequest(operation);
    operation.method = "GET"; operation.key = "replacement/key";
    pending.resolve(true); expect(await allowed).toBe(true);
    expect(beforeDelete).toHaveBeenCalledExactlyOnceWith("original/key");
  });
  it("checks current runtime and cancellation again after lookup, opening and caller authorization", async () => {
    const f = plainOpening(), pending = deferred<typeof registered>(); f.first.mockReturnValue(pending.promise);
    const opening = openStorageProfile(f.capabilities, target, "write");
    f.isCurrent.mockReturnValue(false); pending.resolve({ ...registered });
    await expect(opening).rejects.toBeInstanceOf(ShadowProfileUnavailableError); expect(f.openProvider).not.toHaveBeenCalled();
    const g = plainOpening(), controller = new AbortController();
    g.openProvider.mockImplementation(async () => { controller.abort(); return g.opened; });
    await expect(openStorageProfile(g.capabilities, target, "write", { signal: controller.signal })).rejects.toBeInstanceOf(ShadowProfileUnavailableError);
    const h = plainOpening();
    await openStorageProfile(h.capabilities, target, "write", { beforeRequest: async () => { h.isCurrent.mockReturnValue(false); return true; } });
    expect(await h.openProvider.mock.calls[0]![2].beforeRequest({ method: "PUT", key: "key" })).toBe(false);
  });
  it("sanitizes unsupported adapters and provider failures without selecting an alternate provider", async () => {
    const f = plainOpening(); f.first.mockResolvedValue({ ...registered, adapter_type: "local" });
    f.openProvider.mockRejectedValue(new Error("private disk path or credential"));
    await expect(openStorageProfile(f.capabilities, target, "write")).rejects.toMatchObject({ message: "The recorded File storage profile is unavailable" });
    expect(f.openProvider).toHaveBeenCalledOnce(); expect(f.read).not.toHaveBeenCalled();
  });
});

/** These tiny tables deliberately model a future registered provider capability;
 * they are NOT the application's migrated schema and grant no local admission. */
async function localFixture(admitted = true) {
  const root = await mkdtemp(join(tmpdir(), "rt3-profile-opening-")); roots.push(root);
  const privateRoot = join(root, "bytes"); await mkdir(privateRoot, { mode: 0o700 });
  await mkdir(join(privateRoot, "objects"), { mode: 0o700 }); await mkdir(join(privateRoot, "staging"), { mode: 0o700 });
  const namespace = { volumeId: "fixture-volume", rootId: "fixture-root", profileId: "fixture-local", namespaceRevision: 1 };
  const namespaceIdentity = JSON.stringify({ kind: "local", ...namespace });
  await writeFile(join(privateRoot, "namespace.json"), JSON.stringify({ format: "local-byte-namespace-v1", namespace }), { mode: 0o600 });
  const sql = new DatabaseSync(join(root, "authority.sqlite"), { allowExtension: false });
  const sqlite = createSqliteCapability(sql), database = asJobSqlDatabase(sqlite); closes.push(() => sqlite.close());
  sql.exec("CREATE TABLE storage_profiles(id TEXT PRIMARY KEY,adapter_type TEXT,configuration_revision INTEGER,namespace_identity TEXT); CREATE TABLE storage_profile_runtime(storage_profile_id TEXT,state TEXT); CREATE TABLE fixture_local_admission(profile_id TEXT PRIMARY KEY,admitted INTEGER)");
  sql.prepare("INSERT INTO storage_profiles VALUES(?,'local',1,?)").run(namespace.profileId, namespaceIdentity);
  sql.prepare("INSERT INTO storage_profile_runtime VALUES(?,'read_write')").run(namespace.profileId);
  sql.prepare("INSERT INTO fixture_local_admission VALUES(?,?)").run(namespace.profileId, admitted ? 1 : 0);
  let storage: LocalByteStorage | undefined, current = true;
  const calls: FileByteOperation[] = [];
  const permitted = async (profile: RegisteredStorageProfile, access: "read" | "write") => Boolean(await database.primary().prepare(`SELECT 1 FROM storage_profiles p
    JOIN storage_profile_runtime r ON r.storage_profile_id=p.id JOIN fixture_local_admission a ON a.profile_id=p.id
    WHERE p.id=? AND p.adapter_type='local' AND p.configuration_revision=? AND p.namespace_identity=? AND a.admitted=1
      AND r.state IN('read_only','read_write') AND (?='read' OR r.state='read_write')`)
    .bind(profile.profileId, profile.configurationRevision, profile.namespaceIdentity, access).first());
  const capabilities: StorageProfileOpeningCapabilities<"local"> = {
    database, isCurrent: () => current,
    async openProvider(profile, access, lifecycle) {
      if (profile.profileId !== namespace.profileId || profile.configurationRevision !== 1 || profile.adapterType !== "local"
        || profile.namespaceIdentity !== namespaceIdentity || !await permitted(profile, access)) throw new Error("Local registration unavailable");
      storage = await openLocalByteStorage({ root: privateRoot, namespace }); closes.push(() => storage!.close());
      const bytes = storage;
      const fence = async (operation: FileByteOperation) => {
        if (!await permitted(profile, access) || !await lifecycle.beforeRequest(operation) || !await permitted(profile, access)) return false;
        calls.push(operation); return true;
      };
      return { storage: { profileId: profile.profileId, configurationRevision: 1, adapterType: "local", namespaceIdentity }, createHash: nodeSha256,
        reader: { async read(key) { return await fence({ method: "GET", key }) ? bytes.reader.read(key) : { outcome: "unavailable" }; },
          async stat(key) { return await fence({ method: "HEAD", key }) ? bytes.reader.stat(key) : { outcome: "unavailable" }; } },
        writer: { accepts: "both", async write(input) { if (!await fence({ method: "PUT", key: input.key })) throw new ByteVerificationError("destination", "unavailable"); return bytes.writer.write(input); } },
        deleter: { async delete(key) { return await fence({ method: "DELETE", key }) ? bytes.deleter.delete(key) : { outcome: "unavailable" }; } } };
    },
  };
  return { capabilities, sql, namespace, namespaceIdentity, calls, privateRoot, hasOpenedStorage: () => !!storage,
    replaceRuntime: () => { current = false; }, target: { profileId: namespace.profileId, configurationRevision: 1 } };
}
describe("future Node provider injection uses actual disk bytes without an R2 binding", () => {
  it("opens exact fixture-only authority, writes once, verifies independently, then deletes through the exact caller claim", async () => {
    const f = await localFixture(), beforeDelete = vi.fn(async () => true);
    const opened = await openStorageProfile(f.capabilities, f.target, "write", { beforeDelete });
    const payload = new TextEncoder().encode("actual locally opened bytes"), expected = { byteSize: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex") };
    await opened.writer!.write({ key: "opaque/../key", body: payload.buffer, ...expected, contentType: "text/plain", filename: "example.txt" });
    expect(await verifyStoredBytes(opened.reader, "opaque/../key", expected, opened.createHash)).toEqual(expected);
    expect(await opened.deleter!.delete("opaque/../key")).toEqual({ outcome: "acknowledged" });
    expect(beforeDelete).toHaveBeenCalledExactlyOnceWith("opaque/../key");
    expect(await opened.reader.stat("opaque/../key")).toEqual({ outcome: "missing" });
    expect(f.calls.map(call => call.method)).toEqual(["PUT", "GET", "DELETE", "HEAD"]);
  });
  it("a local adapter label without separate fixture admission cannot open the disk capability", async () => {
    const f = await localFixture(false);
    await expect(openStorageProfile(f.capabilities, f.target, "write")).rejects.toBeInstanceOf(ShadowProfileUnavailableError);
    expect(f.hasOpenedStorage()).toBe(false); expect(f.calls).toEqual([]);
  });
  it("revocation during caller authorization prevents byte I/O even after opening", async () => {
    const f = await localFixture();
    const opened = await openStorageProfile(f.capabilities, f.target, "write", { beforeRequest: async () => {
      f.sql.prepare("UPDATE fixture_local_admission SET admitted=0").run(); return true;
    } });
    expect(await opened.reader.read("owned/key")).toEqual({ outcome: "unavailable" }); expect(f.calls).toEqual([]);
  });
  it("retirement and runtime replacement fail closed without replay, deletion, or provider fallback", async () => {
    const f = await localFixture(), opened = await openStorageProfile(f.capabilities, f.target, "write");
    f.sql.prepare("UPDATE storage_profile_runtime SET state='read_only'").run();
    expect(await opened.deleter!.delete("owned/key")).toEqual({ outcome: "unavailable" });
    f.replaceRuntime(); expect(await opened.reader.read("owned/key")).toEqual({ outcome: "unavailable" });
    expect(f.calls).toEqual([]);
  });
});
