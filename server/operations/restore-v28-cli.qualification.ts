import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, readFile, realpath, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStoreArchiveStream, openStoreArchiveEntry, type ArchiveEntry } from "../../shared/domain/research-archive";
import { validateV28SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission";
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource, nodeRecoveryFileSha256, writePrivateRecoveryStream } from "../../scripts/lib/system-backup-node-io";
import { verifyNodeDistribution } from "../../scripts/lib/node-distribution-v28-manifest.mjs";

// External inputs must be the separately qualified genuine D1-origin capsule
// and an actually built current distribution. This file fabricates neither a
// source producer nor destination authority; its three cases are all UNRUN.
interface Cleanup { close(): Promise<void>; original?: Promise<void> }
const roots = new Set<Cleanup>(), scopes = new AsyncLocalStorage<Set<Cleanup>>();
function retain(close: () => Promise<void>): Cleanup {
  const owner: Cleanup = { close }; (scopes.getStore() ?? roots).add(owner); return owner;
}
async function closeOriginal(owner: Cleanup): Promise<void> {
  if (!owner.original) {
    try { owner.original = owner.close(); } catch (error) { owner.original = Promise.reject(error); }
    owner.original.then(() => undefined, () => undefined);
  }
  await owner.original;
}
function own<T>(run: () => Promise<T>): Promise<T> {
  const children = new Set<Cleanup>(); let original: Promise<T> | undefined;
  const root = retain(async () => {
    if (original) await original.then(() => undefined, () => undefined);
    for (const child of [...children].reverse()) { await closeOriginal(child); children.delete(child); }
    roots.delete(root);
  });
  original = scopes.run(children, run); original.then(() => undefined, () => undefined); return original;
}
async function drain(): Promise<void> {
  for (const root of [...roots].reverse()) { await closeOriginal(root); roots.delete(root); }
}
afterEach(drain); afterAll(drain);
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "Expected object"); return value as Record<string, unknown>;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let directory: string, archive: string, archiveSha256: string, distribution: string, rootUid: string;
let admitted: Awaited<ReturnType<typeof validateV28SystemBackupArchiveCandidate>>;
beforeAll(() => own(async () => {
  archive = process.env.NODE_OFFLINE_V28_D1_ARCHIVE ?? "";
  archiveSha256 = process.env.NODE_OFFLINE_V28_D1_ARCHIVE_SHA256 ?? "";
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? "";
  rootUid = process.env.NODE_OFFLINE_V28_FILESYSTEM_ROOT_UID ?? "";
  ensure(archive && distribution && /^[0-9a-f]{64}$/.test(archiveSha256)
    && /^(?:0|[1-9][0-9]{0,9})$/.test(rootUid) && Number(rootUid) <= 0xffff_ffff, "Sealed archive/distribution/root UID inputs required");
  ensure(await realpath(archive) === archive && await realpath(distribution) === distribution, "Canonical actual inputs required");
  const stat = await lstat(archive);
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.geteuid?.()
    && [0o400, 0o600].includes(stat.mode & 0o7777), "Private original archive required");
  const checked = await nodeRecoveryFileSha256(archive); ensure(checked.sha256 === archiveSha256, "Original capsule hash required");
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
  ensure(manifest.version === 3 && manifest.installationCheckpoint.id === "portable-runtime/v26"
    && manifest.offlineRecoveryCheckpoint.id === "portable-runtime/v28"
    && manifest.offlineRecoveryCheckpoint.archiveFormat === "v5" && !manifest.offlineRecoveryCheckpoint.executionEnabled, "Fixed separate catalog tuples required");
  admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archive),
    { ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: archiveSha256 });
  ensure(admitted.records.sourceMigrationLedger.kind === "cloudflare-observed-migrations/1", "Actual D1-origin capsule required");
  directory = await mkdtemp(join(tmpdir(), "offline-v28-bundled-"));
}), 30000);

function cli(input: string, digest: string, destination: string): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  let child: ChildProcess | undefined, attempted = false, constructionFailure: unknown;
  let original: Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> | undefined;
  retain(async () => {
    if (attempted && !child) throw constructionFailure;
    if (!original) throw new Error("Original bundled CLI closure was not registered");
    await original; // Original close event, not an error event or forced replacement.
  });
  attempted = true;
  try {
    child = spawn(process.execPath, [join(distribution, "server/restore-v28-cli.cjs"), "restore", "--archive", input,
      "--destination", destination, "--sha256", digest, "--filesystem-root-owner-uid", rootUid],
    { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) { constructionFailure = error; throw error; }
  const accepted = child;
  original = new Promise((resolve, reject) => {
    let stdout = "", stderr = "", outputBytes = 0, outputFailure: Error | undefined, spawnError: unknown;
    accepted.stdout!.setEncoding("utf8"); accepted.stderr!.setEncoding("utf8");
    const capture = (value: string, standardOutput: boolean) => {
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > 16 * 1024) { outputFailure ??= new Error("Bundled CLI diagnostic budget exceeded"); return; }
      if (standardOutput) stdout += value; else stderr += value;
    };
    accepted.stdout!.on("data", (value: string) => { capture(value, true); });
    accepted.stderr!.on("data", (value: string) => { capture(value, false); });
    accepted.once("error", error => { spawnError = error; });
    accepted.once("close", (code, signal) => spawnError || outputFailure
      ? reject(spawnError ?? outputFailure) : resolve({ code, signal, stdout, stderr }));
  });
  original.then(() => undefined, () => undefined); return original;
}
async function missingDatabase(target: string) {
  try { await lstat(join(target, "database.sqlite")); throw new Error("Unknown archive constructed a database"); }
  catch (error) { ensure(error && typeof error === "object" && "code" in error && error.code === "ENOENT", "No database before admission required"); }
}
describe("actual fixed bundled V5 offline restore", () => {
  it("restores the same genuine D1-origin capsule through the fixed executable into an inert V28 destination", () => own(async () => {
    const target = join(directory, "supported"), result = await cli(archive, archiveSha256, target);
    expect(result.code).toBe(0); expect(result.signal).toBeNull();
    const output = object(JSON.parse(result.stdout));
    expect(output.kind).toBe("offline-v28-inert-restore/1"); expect(output.archiveFormat).toBe("v5");
    expect(output.sourceArchiveSha256).toBe(archiveSha256); expect(output.destinationCheckpoint).toBe("portable-runtime/v28");
    expect(output.executionEnabled).toBe(false);
    const report = object(JSON.parse(await readFile(join(target, "recovery-report.json"), "utf8")));
    expect(report.verification).toEqual({ exactTypedRows: true, exactRowids: true, foreignKeys: true, integrity: "ok", reviewedSchema: true });
    expect(report.nativeBindingsRestored).toBe(false); expect(report.executionEnabled).toBe(false);
    expect(report.maintenanceState).toBe("fenced");
    expect(report.collaborationPolicy).toEqual({ sourceAuthorityRowsRestored: false, destinationControl: "disabled", destinationAuthorityTables: "empty" });
    expect((await nodeRecoveryFileSha256(join(target, "original-archive.zip"))).sha256).toBe(archiveSha256);
    expect((await nodeRecoveryFileSha256(archive)).sha256).toBe(archiveSha256);
  }));
  it("rejects an unknown manifest version in a fully measured ZIP without any Native target construction or historical fallback", () => own(async () => {
    const source = await nodeRecoveryArchiveSource(archive), input = join(directory, "unknown.zip"), target = join(directory, "unknown-target");
    const metadata = new TextEncoder().encode(JSON.stringify({ ...admitted.manifest, schema: "system-backup/999" }));
    const entries: ArchiveEntry[] = admitted.entries.map(entry => entry.path === "manifest.json"
      ? { path: entry.path, kind: entry.kind, byteSize: metadata.byteLength, sha256: hash(metadata) } : entry);
    const stream = createStoreArchiveStream(entries, async entry => entry.path === "manifest.json"
      ? new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(metadata); controller.close(); } })
      : openStoreArchiveEntry(source, admitted.entries.find(original => original.path === entry.path)!, NODE_RECOVERY_ARCHIVE_OPTIONS), NODE_RECOVERY_ARCHIVE_OPTIONS);
    await writePrivateRecoveryStream(input, stream);
    const result = await cli(input, (await nodeRecoveryFileSha256(input)).sha256, target);
    expect(result.code).toBe(1); expect(result.signal).toBeNull(); expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Offline V28 restoration unavailable.\n"); expect(result.stderr).not.toContain(input);
    await missingDatabase(target); expect((await nodeRecoveryFileSha256(archive)).sha256).toBe(archiveSha256);
  }));
  it("rejects a truncated original ZIP with its real truncated digest before Native target construction", () => own(async () => {
    const input = join(directory, "truncated.zip"), target = join(directory, "truncated-target");
    await copyFile(archive, input); await chmod(input, 0o600); const stat = await lstat(input); await truncate(input, stat.size - 1);
    const result = await cli(input, (await nodeRecoveryFileSha256(input)).sha256, target);
    expect(result.code).toBe(1); expect(result.signal).toBeNull(); expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Offline V28 restoration unavailable.\n"); expect(result.stderr).not.toContain(input);
    await missingDatabase(target); expect((await nodeRecoveryFileSha256(archive)).sha256).toBe(archiveSha256);
  }));
});
