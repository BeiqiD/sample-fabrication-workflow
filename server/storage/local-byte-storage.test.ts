import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, statfs, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ByteVerificationError, verifyStoredBytes } from "../../worker/files/byte-verification";
import { writeVerifiedBytes, type ByteWriteInput } from "../../worker/files/byte-writer";
import { openLocalByteStorage, type LocalByteBinding, type LocalByteStorage } from "./local-byte-storage";
import { nodeSha256 } from "./node-sha256";

const value = new TextEncoder().encode("real local bytes — 文件");
const expected = (bytes = value) => ({ byteSize: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
const bytesBuffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;
const input = (key = "opaque/key", body: ByteWriteInput["body"] = bytesBuffer(value), bytes = value): ByteWriteInput => ({
  key, body, ...expected(bytes), contentType: "application/octet-stream", filename: "source.bin",
});
const roots: string[] = [], opened: LocalByteStorage[] = [];
const observations: Record<string, unknown>[] = [];
const fixtureParent = process.env.RT3_LOCAL_BYTE_FIXTURE_PARENT ?? tmpdir();
if (!["/tmp", "/workspace"].includes(fixtureParent)) throw new Error("Use an explicit private scratch fixture parent");
let bundleDirectory: string, modulePath: string, processModulePath: string;
beforeAll(async () => {
  bundleDirectory = await mkdtemp(join(tmpdir(), "rt3-node-byte-bundle-"));
  modulePath = join(bundleDirectory, "local-byte-storage.mjs");
  processModulePath = join(bundleDirectory, "process-fixture.mjs");
  await build({ entryPoints: [resolve("server/storage/local-byte-storage.ts")], outfile: modulePath, bundle: true, platform: "node", format: "esm" });
  await build({ entryPoints: [resolve("server/storage/local-byte-storage.process-fixture.ts")], outfile: processModulePath, bundle: true, platform: "node", format: "esm" });
});
afterAll(async () => {
  await rm(bundleDirectory, { recursive: true, force: true });
  const receiptPath = process.env.RT3_LOCAL_BYTE_RECEIPT_PATH;
  if (receiptPath) {
    if (!/^\/tmp\/portable-rt3-byte-[^/]+\.json$/.test(receiptPath)) throw new Error("Use a fresh private receipt path");
    await writeFile(receiptPath, JSON.stringify({ version: 1, node: process.version, platform: process.platform,
      fixtureParent, filesystemTypeHex: (await statfs(fixtureParent, { bigint: true })).type.toString(16),
      scope: "Actual synthetic filesystem operations and independent Node processes; no application/profile/schema/provider composition.", observations }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const parent = await mkdtemp(join(fixtureParent, "rt3-local-byte-")); roots.push(parent);
  const root = join(parent, "private-objects");
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, "objects"), { mode: 0o700 }); await mkdir(join(root, "staging"), { mode: 0o700 });
  const binding: LocalByteBinding = { root, namespace: { volumeId: randomUUID(), rootId: randomUUID(), profileId: randomUUID(), namespaceRevision: 1 } };
  await writeFile(join(root, "namespace.json"), JSON.stringify({ format: "local-byte-namespace-v1", namespace: binding.namespace }), { flag: "wx", mode: 0o600 });
  const storage = await reopen(binding);
  return { parent, root, binding, storage };
}
async function reopen(binding: LocalByteBinding) {
  const storage = await openLocalByteStorage(binding); opened.push(storage); return storage;
}
async function onlyObject(root: string) {
  const names = await readdir(join(root, "objects")); expect(names).toHaveLength(1); expect(names[0]).toMatch(/^[a-f0-9]{64}$/);
  return join(root, "objects", names[0]);
}
function controlled(bytes = value) {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (!pulls++) controller.enqueue(bytes);
    else { await held; controller.close(); }
  } }, { highWaterMark: 0 });
  return { body, release };
}
async function staged(root: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const entries = await readdir(join(root, "staging"));
    if (entries.length) return entries;
    await new Promise<void>(done => setImmediate(done));
  }
  throw new Error("No actual staging directory appeared");
}

describe("server-only incremental SHA-256", () => {
  it("hashes chunk views immediately, empty EOF and closed lifecycle without a content-sized buffer", async () => {
    const sink = nodeSha256(), original = Uint8Array.from(value);
    await sink.write(original.subarray(0, 5)); await sink.write(original.subarray(5)); original.fill(0);
    expect(await sink.finish()).toBe(expected().sha256);
    await expect(sink.write(value)).rejects.toThrow("closed"); await expect(sink.finish()).rejects.toThrow("closed");
    const empty = nodeSha256(); expect(await empty.finish()).toBe(expected(new Uint8Array()).sha256);
    const abandoned = nodeSha256(); await abandoned.abort(); await abandoned.abort(); await expect(abandoned.finish()).rejects.toThrow("closed");
  });
});

describe("actual private local byte transport", () => {
  it.each(["buffer", "stream"] as const)("uses existing source/destination verification for %s and survives adapter restart", async kind => {
    const { root, storage, binding } = await fixture();
    const payload = new Uint8Array(200_000).map((_, index) => index % 251);
    const body = kind === "buffer" ? bytesBuffer(payload) : new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(payload); controller.close(); } });
    expect(await writeVerifiedBytes({ reader: storage.reader, writer: storage.writer, createHash: nodeSha256 }, input("exact-original", body, payload))).toEqual(expected(payload));
    const published = await onlyObject(root);
    expect((await stat(published)).mode & 0o777).toBe(0o700); expect((await stat(join(published, "data"))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, "staging"))).toEqual([]);
    expect(await storage.reader.stat("exact-original")).toMatchObject({ outcome: "available", byteSize: payload.length, etag: null });
    await storage.close(); const restarted = await reopen(binding);
    expect(await verifyStoredBytes(restarted.reader, "exact-original", expected(payload), nodeSha256)).toEqual(expected(payload));
  });

  it("publishes empty bytes only with successful EOF and the exact empty hash", async () => {
    const { storage } = await fixture(); const empty = new Uint8Array();
    expect(await writeVerifiedBytes({ reader: storage.reader, writer: storage.writer, createHash: nodeSha256 }, input("empty", bytesBuffer(empty), empty))).toEqual(expected(empty));
  });

  it("keeps traversal-looking and separator-looking keys distinct without physical path interpretation", async () => {
    const { root, storage } = await fixture(); const keys = ["../a", "a", "a//b", "a/b", "a\\b", "%2Fname", "中文", " a "];
    for (const key of keys) await storage.writer.write(input(key));
    const entries = await readdir(join(root, "objects")); expect(entries).toHaveLength(keys.length); expect(entries.every(name => /^[a-f0-9]{64}$/.test(name))).toBe(true);
    const logical = await Promise.all(entries.map(async name => JSON.parse(await readFile(join(root, "objects", name, "metadata.json"), "utf8")).key));
    expect(logical.sort()).toEqual(keys.sort());
    for (const key of keys) expect(await verifyStoredBytes(storage.reader, key, expected(), nodeSha256)).toEqual(expected());
    expect(await readdir(root)).toEqual(expect.arrayContaining(["objects", "staging", "namespace.json"]));
  });

  it.each(["", " ", "a\0b", "a\ud800", "e\u0301"])("rejects malformed or noncanonical key %j without staging/publication", async key => {
    const { root, storage } = await fixture();
    await expect(storage.writer.write(input(key))).rejects.toMatchObject({ phase: "source", reason: "invalid_expectation" });
    expect(await storage.reader.read(key)).toEqual({ outcome: "unavailable" });
    expect(await storage.deleter.delete(key)).toEqual({ outcome: "unavailable" });
    expect(await readdir(join(root, "objects"))).toEqual([]); expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("keeps in-progress complete source chunks invisible until EOF and one atomic publication", async () => {
    const { root, storage } = await fixture(), source = controlled();
    const writing = storage.writer.write(input("held", source.body));
    await staged(root); expect(await storage.reader.stat("held")).toEqual({ outcome: "missing" });
    source.release(); await writing;
    expect(await verifyStoredBytes(storage.reader, "held", expected(), nodeSha256)).toEqual(expected());
  });

  it("captures the exact original key and expectation before awaited I/O, despite caller-object changes", async () => {
    const { root, storage } = await fixture(), source = controlled();
    const request = input("original-attempt", source.body), writing = storage.writer.write(request); void writing.catch(() => {});
    await staged(root);
    request.key = "changed-attempt"; request.sha256 = "0".repeat(64); request.filename = "changed.bin";
    source.release(); await writing;
    expect(await verifyStoredBytes(storage.reader, "original-attempt", expected(), nodeSha256)).toEqual(expected());
    expect(await storage.reader.stat("changed-attempt")).toEqual({ outcome: "missing" });
    const description = JSON.parse(await readFile(join(await onlyObject(root), "metadata.json"), "utf8"));
    expect(description).toMatchObject({ key: "original-attempt", sha256: expected().sha256, filename: "source.bin" });
  });

  it("bounds serialized identity metadata before I/O instead of publishing an unreadable object", async () => {
    const { storage, root, binding } = await fixture(); await storage.close();
    const namespace = { volumeId: "\\".repeat(1024), rootId: "\\".repeat(1024), profileId: "\\".repeat(1024), namespaceRevision: 1 };
    await writeFile(join(root, "namespace.json"), JSON.stringify({ format: "local-byte-namespace-v1", namespace }));
    const selected = await reopen({ ...binding, namespace });
    const request = { ...input("\\".repeat(4096)), filename: "\\".repeat(1024) };
    await expect(selected.writer.write(request)).rejects.toMatchObject({ phase: "source", reason: "invalid_expectation" });
    expect(await readdir(join(root, "objects"))).toEqual([]); expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it.each(["truncated", "wrong-hash"] as const)("retains failed %s staging without publishing or destructive cleanup", async fault => {
    const { root, storage } = await fixture();
    const request = fault === "truncated" ? input("failed", bytesBuffer(value.subarray(0, 5))) : { ...input("failed"), sha256: "0".repeat(64) };
    await expect(storage.writer.write(request)).rejects.toMatchObject({ phase: "source", reason: fault === "truncated" ? "size_mismatch" : "hash_mismatch" });
    expect(await storage.reader.stat("failed")).toEqual({ outcome: "missing" });
    expect(await readdir(join(root, "objects"))).toEqual([]); expect(await readdir(join(root, "staging"))).toHaveLength(1);
  });

  it("never overwrites or reinterprets an already published exact key", async () => {
    const { storage, root } = await fixture(); await storage.writer.write(input("immutable"));
    const published = await onlyObject(root), before = await readFile(join(published, "metadata.json"));
    await expect(storage.writer.write(input("immutable", bytesBuffer(new Uint8Array([1])), new Uint8Array([1])))).rejects.toMatchObject({ reason: "conflict" });
    expect(await readFile(join(published, "metadata.json"))).toEqual(before);
    expect(await verifyStoredBytes(storage.reader, "immutable", expected(), nodeSha256)).toEqual(expected());
  });

  it("keeps the first complete object under competing staged writes and retains the rejected attempt", async () => {
    const { storage, binding, root } = await fixture(); const competing = await reopen(binding);
    const a = controlled(), other = new TextEncoder().encode("different complete source"), b = controlled(other);
    const first = storage.writer.write(input("same-key", a.body));
    const second = competing.writer.write(input("same-key", b.body, other)); void second.catch(() => {});
    for (let attempt = 0; attempt < 100 && (await readdir(join(root, "staging"))).length < 2; attempt++) await new Promise<void>(done => setImmediate(done));
    expect(await readdir(join(root, "staging"))).toHaveLength(2);
    a.release(); await first; b.release(); await expect(second).rejects.toMatchObject({ reason: "unavailable" });
    expect(await verifyStoredBytes(competing.reader, "same-key", expected(), nodeSha256)).toEqual(expected());
    expect(await readdir(join(root, "objects"))).toHaveLength(1); expect(await readdir(join(root, "staging"))).toHaveLength(1);
  });

  it.each(["same-size-corruption", "truncation"] as const)("independently rejects actual %s after transport ACK without retry or delete", async fault => {
    const { storage, root } = await fixture(); let writes = 0;
    const writer = { accepts: "both" as const, async write(request: ByteWriteInput) {
      writes++; await storage.writer.write(request); const path = join(await onlyObject(root), "data");
      await writeFile(path, fault === "truncation" ? value.subarray(0, 5) : value.map(byte => byte ^ 1));
    } };
    await expect(writeVerifiedBytes({ reader: storage.reader, writer, createHash: nodeSha256 }, input("corrupted"))).rejects.toMatchObject({ phase: "destination", reason: fault === "truncation" ? "size_mismatch" : "hash_mismatch" });
    expect(writes).toBe(1); expect(await readdir(join(root, "objects"))).toHaveLength(1);
  });

  it("reconciles a lost ACK through a fresh exact-key read without replaying or removing committed bytes", async () => {
    const { binding, storage, root } = await fixture(); let writes = 0;
    const uncertain = { accepts: "both" as const, async write(request: ByteWriteInput) { writes++; await storage.writer.write(request); throw new Error("Injected lost ACK"); } };
    await expect(writeVerifiedBytes({ reader: storage.reader, writer: uncertain, createHash: nodeSha256 }, input("lost-ack"))).rejects.toEqual(new ByteVerificationError("destination", "unavailable"));
    expect(writes).toBe(1); expect(await readdir(join(root, "objects"))).toHaveLength(1);
    await storage.close(); const fresh = await reopen(binding);
    expect(await verifyStoredBytes(fresh.reader, "lost-ack", expected(), nodeSha256)).toEqual(expected());
    observations.push({ case: "lost-ACK", writerCalls: writes, committedObjects: 1, freshExactKeyVerification: expected(), replayOrDelete: false });
  });

  it("rejects exact metadata/key identity substitution for read and deletion", async () => {
    const { storage, root } = await fixture(); await storage.writer.write(input("original")); const published = await onlyObject(root);
    const description = JSON.parse(await readFile(join(published, "metadata.json"), "utf8"));
    await writeFile(join(published, "metadata.json"), JSON.stringify({ ...description, key: "foreign" }));
    expect(await storage.reader.read("original")).toEqual({ outcome: "unavailable" }); expect(await storage.deleter.delete("original")).toEqual({ outcome: "unavailable" });
    expect(await readFile(join(published, "data"))).toEqual(Buffer.from(value));
  });

  it("fails a changed namespace marker before publication without fallback", async () => {
    const { binding, storage, root } = await fixture(), source = controlled();
    const writing = storage.writer.write(input("held", source.body)); void writing.catch(() => {}); await staged(root);
    await writeFile(join(root, "namespace.json"), JSON.stringify({ format: "local-byte-namespace-v1", namespace: { ...binding.namespace, volumeId: randomUUID() } }));
    source.release(); await expect(writing).rejects.toMatchObject({ reason: "unavailable" });
    expect(await readdir(join(root, "objects"))).toEqual([]); expect(await readdir(join(root, "staging"))).toHaveLength(1);
    expect(await storage.reader.read("held")).toEqual({ outcome: "unavailable" });
  });

  it("freezes the original binding and preserves namespace identity after an explicitly reopened relocation", async () => {
    const { binding, storage, root, parent } = await fixture(); await storage.writer.write(input("accepted"));
    (binding.namespace as { profileId: string }).profileId = randomUUID();
    expect(await verifyStoredBytes(storage.reader, "accepted", expected(), nodeSha256)).toEqual(expected());
    const original = JSON.parse(await readFile(join(root, "namespace.json"), "utf8")).namespace;
    const moved = join(parent, "relocated-volume"); await rename(root, moved);
    expect(await storage.reader.stat("accepted")).toEqual({ outcome: "unavailable" });
    const relocated = await reopen({ root: moved, namespace: original });
    expect(await verifyStoredBytes(relocated.reader, "accepted", expected(), nodeSha256)).toEqual(expected());
  });

  it.each(["symlink", "hardlink"] as const)("rejects a %s data object and leaves the outside target untouched", async kind => {
    const { storage, root, parent } = await fixture(); await storage.writer.write(input("linked")); const published = await onlyObject(root);
    const outside = join(parent, "outside-sentinel"); await writeFile(outside, value, { mode: 0o600 }); await rm(join(published, "data"));
    if (kind === "symlink") await symlink(outside, join(published, "data")); else await link(outside, join(published, "data"));
    expect(await storage.reader.read("linked")).toEqual({ outcome: "unavailable" }); expect(await storage.deleter.delete("linked")).toEqual({ outcome: "unavailable" });
    expect(await readFile(outside)).toEqual(Buffer.from(value));
  });

  it("rejects symlink roots and group/other-accessible provisioned directories", async () => {
    const { binding, root, parent } = await fixture(); const alias = join(parent, "alias"); await symlink(root, alias);
    await expect(openLocalByteStorage({ ...binding, root: alias })).rejects.toMatchObject({ reason: "unavailable" });
    await chmod(join(root, "objects"), 0o755);
    await expect(openLocalByteStorage(binding)).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("never regenerates a missing namespace marker or creates an unprovisioned root", async () => {
    const { binding, root, parent, storage } = await fixture(); await rm(join(root, "namespace.json"));
    await expect(openLocalByteStorage(binding)).rejects.toMatchObject({ reason: "unavailable" });
    expect(await storage.reader.stat("any")).toEqual({ outcome: "unavailable" });
    expect(await readdir(root)).not.toContain("namespace.json");
    const missing = join(parent, "not-provisioned"); await expect(openLocalByteStorage({ ...binding, root: missing })).rejects.toMatchObject({ reason: "unavailable" });
    expect(await readdir(parent)).not.toContain("not-provisioned");
  });

  it("deletes only the exact identity-checked object and acknowledges already absent without key-reuse authority", async () => {
    const { storage } = await fixture(); await storage.writer.write(input("delete")); await storage.writer.write(input("retained"));
    expect(await storage.deleter.delete("delete")).toEqual({ outcome: "acknowledged" }); expect(await storage.reader.stat("delete")).toEqual({ outcome: "missing" });
    expect(await storage.deleter.delete("delete")).toEqual({ outcome: "acknowledged" }); expect(await verifyStoredBytes(storage.reader, "retained", expected(), nodeSha256)).toEqual(expected());
    await storage.close(); expect(await storage.reader.read("retained")).toEqual({ outcome: "unavailable" }); expect(await storage.deleter.delete("retained")).toEqual({ outcome: "unavailable" });
  });
});

async function child(binding: LocalByteBinding, mode: "before-publish" | "after-publish" | "file-limit") {
  const args = [processModulePath, pathToFileURL(modulePath).href, binding.root, JSON.stringify(binding.namespace), mode];
  const processChild = mode === "file-limit" ? spawn("bash", ["-c", 'ulimit -f 1\nexec "$@"', "rt3-limit", process.execPath, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  processChild.stdout.on("data", data => { stdout += String(data); }); processChild.stderr.on("data", data => { stderr += String(data); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
    processChild.once("error", fail); processChild.once("exit", (code, signal) => done({ code, signal }));
  });
  if (mode === "before-publish") {
    await new Promise<void>((done, fail) => {
      const timeout = setTimeout(() => { processChild.kill("SIGKILL"); fail(new Error("Child did not reach actual staged I/O")); }, 2000);
      processChild.stdout.on("data", () => { if (stdout.includes("STAGED")) { clearTimeout(timeout); done(); } });
      processChild.once("exit", () => { clearTimeout(timeout); if (!stdout.includes("STAGED")) fail(new Error(`Child exited early: ${stderr}`)); });
    });
    processChild.kill("SIGKILL");
  }
  const outcome = await exit; return { ...outcome, stdout, stderr };
}
describe("independent-process disk publication faults", () => {
  it.each(["before-publish", "after-publish"] as const)("survives SIGKILL %s and reconciles from a new adapter", async mode => {
    const { binding, storage, root } = await fixture(); await storage.close();
    const result = await child(binding, mode); expect(result.signal).toBe("SIGKILL");
    const fresh = await reopen(binding);
    if (mode === "before-publish") {
      expect(await fresh.reader.stat(mode)).toEqual({ outcome: "missing" }); expect(await readdir(join(root, "staging"))).toHaveLength(1);
    } else expect(await verifyStoredBytes(fresh.reader, mode, expected(new TextEncoder().encode("independent process bytes")), nodeSha256))
      .toEqual(expected(new TextEncoder().encode("independent process bytes")));
    observations.push({ case: mode, independentProcess: true, signal: result.signal, exitCode: result.code,
      freshStat: (await fresh.reader.stat(mode)).outcome, committedObjects: (await readdir(join(root, "objects"))).length,
      retainedStages: (await readdir(join(root, "staging"))).length });
  });

  it("fails actual process-limited disk writes with retained partial staging, not a fabricated ENOSPC claim", async () => {
    const { binding, storage, root } = await fixture(); await storage.close();
    const result = await child(binding, "file-limit"); expect(result.code).toBe(0); expect(result.stdout).toContain("WRITE_FAILED");
    const fresh = await reopen(binding); expect(await fresh.reader.stat("file-limit")).toEqual({ outcome: "missing" });
    const retained = await readdir(join(root, "staging")); expect(retained).toHaveLength(1);
    const partialBytes = (await stat(join(root, "staging", retained[0], "data"))).size;
    expect(partialBytes).toBeLessThanOrEqual(1024);
    observations.push({ case: "RLIMIT_FSIZE", independentProcess: true, exitCode: result.code, signal: result.signal,
      actualWriteFailureObserved: result.stdout.includes("WRITE_FAILED"), configuredMaximumBytes: 1024, retainedPartialBytes: partialBytes,
      freshStat: (await fresh.reader.stat("file-limit")).outcome, committedObjects: (await readdir(join(root, "objects"))).length });
  });
});
