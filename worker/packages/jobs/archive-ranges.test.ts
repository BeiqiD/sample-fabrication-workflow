import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStoreArchiveStream, measureStoreArchive, type ArchiveEntry, type ArchiveHashFactory } from "../../../shared/domain/research-archive";
import { bindPackageFormatCapabilities } from "./format-capabilities";
import type { PackageCapabilities, PackageClaim, PackageFile } from "./types";
import { freezeRecoveryArtifactNamespace, recoveryArchiveSource } from "../../recovery/service";
import type { RecoveryJob } from "../../recovery/repository";
import type { Env } from "../../types";

const hash: ArchiveHashFactory = () => { const value = createHash("sha256"); return { write(bytes) { value.update(bytes); }, finish: () => value.digest("hex") }; };
async function fixture() {
  const contents = new Map<string, Uint8Array>(["manifest.json", "records.json", "report/index.html", "report/report.md"].map(path => [path, new TextEncoder().encode("{}") as Uint8Array]));
  contents.set("files/f_1", new Uint8Array(1024).fill(37));
  const entries: ArchiveEntry[] = [...contents].map(([path, bytes]) => ({ path, kind: path.startsWith("files/") ? "payload" : path.startsWith("report/") ? "report" : "metadata", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
  const open = async (entry: ArchiveEntry) => new Response(contents.get(entry.path) as Uint8Array<ArrayBuffer>).body!;
  const measured = await measureStoreArchive(entries, open, { createHash: hash });
  const bytes = new Uint8Array(await new Response(createStoreArchiveStream(entries, open, { createHash: hash })).arrayBuffer());
  return { measured, bytes, payload: measured.entries.find(entry => entry.kind === "payload")! };
}
async function packageFixture(ranges = true) {
  const archive = await fixture(), control = { held: true, namespace: "frozen-r2", total: archive.bytes.length };
  const full = vi.fn(async () => ({ outcome: "available", body: new Response(archive.bytes).body! }));
  const cancelled = vi.fn();
  const ranged = vi.fn(async (_key: string, range: { offset: number; length: number }) => ({ outcome: "available", range, byteSize: control.total,
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(archive.bytes.subarray(range.offset, range.offset + range.length)); controller.close(); }, cancel: cancelled }) }));
  const file = { byte_size: archive.bytes.length, sha256: archive.measured.sha256, result_location_id: "loc", result_file_id: "file", entry_kind: "artifact" } as PackageFile;
  const database = { primary() { return this; }, prepare(sql: string) { return { bind() { return this; }, async first() {
    if (sql.includes("FROM file_location_publications")) return { object_key: "private/zip", storage_profile_id: "p", configuration_revision: 1, namespace_identity: "frozen-r2" };
    return control.held ? { present: 1 } : null;
  } }; } };
  const repository = { database, async job() { return { frozen_archive_json: JSON.stringify(archive.measured) }; }, async files() { return [file]; } };
  const openStorage = vi.fn(async (_target: unknown, _access: unknown, before: () => Promise<boolean>) => {
    if (!await before()) throw new Error("hold unavailable");
    return { namespaceIdentity: control.namespace, reader: { read: full, ...(ranges ? { readRange: ranged } : {}) } };
  });
  const capabilities = bindPackageFormatCapabilities({ repository, openStorage } as unknown as PackageCapabilities, hash);
  const claim = { id: "import", kind: "import", source_upload_job_id: "upload" } as PackageClaim;
  const input = { archive_path: archive.payload.path, byte_size: archive.payload.byteSize, sha256: archive.payload.sha256 } as PackageFile;
  return { archive, capabilities, claim, input, full, ranged, cancelled, control };
}

describe("frozen Package archive range transport", () => {
  it("extracts a verified member through its exact held range and does not read the prefix", async () => {
    const value = await packageFixture();
    const body = await value.capabilities.importBody(value.claim, value.input, async () => true, new AbortController().signal);
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(new Uint8Array(1024).fill(37));
    expect(value.full).not.toHaveBeenCalled();
    expect(value.ranged).toHaveBeenCalledExactlyOnceWith("private/zip", { offset: value.archive.payload.localHeaderOffset,
      length: value.archive.payload.descriptorOffset + 16 - value.archive.payload.localHeaderOffset });
  });
  it("preserves full-object transport for providers without range capability", async () => {
    const value = await packageFixture(false), body = await value.capabilities.importBody(value.claim, value.input, async () => true, new AbortController().signal);
    expect((await new Response(body).arrayBuffer()).byteLength).toBe(1024); expect(value.full).toHaveBeenCalledOnce(); expect(value.ranged).not.toHaveBeenCalled();
  });
  it.each(["hold", "namespace", "size"])("refuses changed %s evidence before returning an accepted payload", async change => {
    const value = await packageFixture(), body = await value.capabilities.importBody(value.claim, value.input, async () => true, new AbortController().signal);
    if (change === "hold") value.control.held = false;
    if (change === "namespace") value.control.namespace = "retargeted-r2";
    if (change === "size") value.control.total++;
    await expect(new Response(body).arrayBuffer()).rejects.toThrow(); expect(value.full).not.toHaveBeenCalled();
    if (change !== "size") expect(value.ranged).not.toHaveBeenCalled();
  });
});

async function recoveryFixture() {
  const archive = await fixture(), actor = "admin@example.test", cancelled = vi.fn(), control = { rangeMatches: true, current: true };
  const get = vi.fn(async (_key: string, options?: { range: { offset: number; length: number } }) => {
    const range = options?.range, bytes = range ? archive.bytes.subarray(range.offset, range.offset + range.length) : archive.bytes;
    return { size: archive.bytes.length, range: control.rangeMatches ? range : undefined,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); }, cancel: cancelled }) };
  });
  const env = { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor, ALLOWED_EMAILS: actor, ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com", ACCESS_AUD: "test",
    R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: "local-r2", installationId: "12345678-1234-4234-8234-123456789abc", bucketName: "private-archives" }),
    ASSETS: { get, put: vi.fn(), delete: vi.fn() }, DB: { prepare(sql: string) { return { bind() { return this; }, async first() { return null; }, async all() {
      return { results: sql.includes("system_recovery_attempts") ? [{ object_key: "fp5-system/upload/archive", state: "verified" }] : [] };
    } }; } } } as unknown as Env;
  const checkpoint = await freezeRecoveryArtifactNamespace(env);
  const job = { id: "upload", actor, artifact_key: "fp5-system/upload/archive", archive_byte_size: archive.bytes.length,
    archive_sha256: archive.measured.sha256, expires_at: new Date(Date.now() + 3600000).toISOString(), checkpoint_json: JSON.stringify(checkpoint) } as RecoveryJob;
  return { archive, env, job, get, cancelled, control };
}
describe("private Worker Recovery archive range transport", () => {
  it("uses exact native range options after current namespace and actor admission", async () => {
    const value = await recoveryFixture(), source = await recoveryArchiveSource(value.env, value.job, async () => value.control.current);
    expect(await source.read(20, 12)).toEqual(value.archive.bytes.subarray(20, 32));
    expect(value.get).toHaveBeenCalledExactlyOnceWith(value.job.artifact_key, { range: { offset: 20, length: 12 } }); await source.dispose?.();
  });
  it.each(["namespace", "actor", "current", "ignored_range"])("refuses changed %s evidence without falling back to whole-object reads", async change => {
    const value = await recoveryFixture(), source = await recoveryArchiveSource(value.env, value.job, async () => value.control.current);
    if (change === "namespace") value.env.R2_BOOTSTRAP_NAMESPACE = JSON.stringify({ kind: "local-r2", installationId: "12345678-1234-4234-8234-123456789abc", bucketName: "retargeted" });
    if (change === "actor") value.env.SYSTEM_ADMIN_EMAILS = "other@example.test";
    if (change === "current") value.control.current = false;
    if (change === "ignored_range") value.control.rangeMatches = false;
    await expect(source.read(20, 12)).rejects.toThrow();
    expect(value.get).toHaveBeenCalledTimes(change === "ignored_range" ? 1 : 0); await source.dispose?.();
  });
});
