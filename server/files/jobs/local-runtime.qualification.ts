import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect } from "vitest";
import { actor, count, fixture, it, retainOriginalOperation, volumes } from "./local-runtime.qualification-support";
import { NODE_LOCAL_FILE_JOB_CADENCE_MS } from "./local-runtime";
import { assertNodeRuntimeConfiguration } from "../../node-runtime-config";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const prefix = "/api/files/migrations";
const bytes = new TextEncoder().encode("Same original Local Job bytes 🧪");
const digest = createHash("sha256").update(bytes).digest("hex");
const tables = ["file_job_runtime_guard", "file_migration_jobs", "file_migration_items", "file_migration_attempts",
  "file_publications", "file_location_publications", "file_location_holds", "file_job_cleanup_grants"];
function snapshot(native: DatabaseSync) {
  return tables.map(table => { const query = native.prepare(`SELECT * FROM ${table} ORDER BY 1`); query.setReadBigInts(true); return [table, query.all()]; });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Original local Job JSON required");
  return value as Record<string, unknown>;
}
function released(f: Fixture) {
  expect(count(f.native, "system_recovery_write_leases", "released_at IS NULL")).toBe(0);
  expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}
async function prepareFile(f: Fixture): Promise<string> {
  // Genuine mounted ordinary acceptance and original byte/provider ACK.
  const answer = await f.request("POST", "/api/assets", bytes, { "content-type": "image/png",
    "x-filename": "same-application-job.png", "x-upload-request-id": crypto.randomUUID() });
  expect(answer.status).toBe(201);
  const asset = object(answer.value);
  if (typeof asset.id !== "string") throw new Error("Actual accepted Job source asset required");
  const row = f.native.prepare("SELECT file_id,storage_profile_id,sha256,byte_size FROM assets WHERE id=?").get(asset.id)!;
  expect(row).toMatchObject({ storage_profile_id: volumes[0]!.profileId, sha256: digest, byte_size: bytes.byteLength });
  if (typeof row.file_id !== "string") throw new Error("Actual accepted native Job File required");
  released(f); return row.file_id;
}
function selection(fileId: string) {
  return { requestId: crypto.randomUUID(), fileIds: [fileId], target: { profileId: volumes[1]!.profileId, configurationRevision: 1 } };
}
async function enable(f: Fixture) {
  const answer = await f.request("POST", prefix + "/executor", { enabled: true });
  expect(answer.status).toBe(200); expect(object(answer.value).enabled).toBe(true); released(f);
}
async function accept(f: Fixture, input: ReturnType<typeof selection>) {
  const answer = await f.request("POST", prefix, input);
  expect(answer.status).toBe(202); const job = object(answer.value);
  if (typeof job.id !== "string") throw new Error("Actual immutable Job identity required");
  expect(job).toMatchObject({ actor, state: "queued", remaining: 1, moved: 0 }); released(f); return job.id;
}

// Fixture creation and real upload prerequisites have their own original
// hook10s boundary. Each finite domain control retains the default case5s;
// the copied genuine catalog/KDF template alone has explicit beforeAll20s.
function scenario(title: string, setup: { administrator: boolean; enableLocalJobs?: boolean; file?: boolean; enabled?: boolean; accepted?: boolean },
  work: (f: Fixture, fileId?: string, jobId?: string) => Promise<void>) {
  describe(title, () => {
    let f: Fixture, fileId: string | undefined, jobId: string | undefined;
    beforeEach(() => retainOriginalOperation(async () => {
      f = await fixture(setup);
      if (setup.file) fileId = await prepareFile(f);
      if (setup.enabled) await enable(f);
      if (setup.accepted) jobId = await accept(f, selection(fileId!));
    }));
    it(title, () => work(f, fileId, jobId));
  });
}

scenario("keeps omitted Job opt-in and the persisted executor disabled on the actual application", { administrator: true }, async f => {
  const before = snapshot(f.native);
  expect(assertNodeRuntimeConfiguration(f.configuration).enableLocalJobs).toBe(false);
  expect(f.prototype.unsupportedRouteOwners).toContain("migration");
  expect((await f.request("GET", prefix + "/executor")).status).toBe(503);
  expect(await f.dispatchJobsOnce()).toEqual({ jobId: null, outcome: "disabled" });
  expect(snapshot(f.native)).toEqual(before); released(f);
});

scenario("mounts current administrator Job HTTP without enabling startup work or shortening the original cadence", { administrator: true, enableLocalJobs: true }, async f => {
  expect(f.prototype.unsupportedRouteOwners).not.toContain("migration");
  const before = snapshot(f.native), answer = await f.request("GET", prefix + "/executor");
  expect(answer.status).toBe(200); expect(answer.headers.get("cache-control")).toBe("private, no-store");
  expect(answer.value).toEqual({ enabled: false, lastHeartbeatAt: null, stale: true, cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60000 });
  const absentRequestId = crypto.randomUUID(), receipt = await f.request("GET", prefix + "/requests/" + absentRequestId);
  expect(receipt.status).toBe(404); expect(receipt.headers.get("cache-control")).toBe("private, no-store");
  expect(receipt.value).toEqual({ schema: "file-migration-request-absent/1", requestId: absentRequestId });
  expect(NODE_LOCAL_FILE_JOB_CADENCE_MS).toBe(120000);
  expect(await f.dispatchJobsOnce()).toEqual({ jobId: null, outcome: "disabled" });
  expect(snapshot(f.native)).toEqual(before); released(f);
});

scenario("denies an ordinary authenticated account through the mounted current administrator boundary", { administrator: false, enableLocalJobs: true }, async f => {
  const before = snapshot(f.native);
  const answer = await f.request("POST", prefix + "/executor", { enabled: true });
  expect(answer.status).toBe(403); expect(snapshot(f.native)).toEqual(before);
  expect(count(f.native, "local_admin_grants")).toBe(0); released(f);
});

scenario("executes genuine accepted Local source bytes through one scheduled slot and exact verified cutover", { administrator: true, enableLocalJobs: true, file: true, enabled: true, accepted: true }, async (f, fileId, jobId) => {
  const before = f.native.prepare("SELECT active_location_id FROM file_publications WHERE file_id=?").get(fileId!)!;
  const result = await f.dispatchJobsOnce(); expect(result).toEqual({ jobId, outcome: "moved" });
  const after = f.native.prepare("SELECT active_location_id FROM file_publications WHERE file_id=?").get(fileId!)!;
  expect(after.active_location_id).not.toBe(before.active_location_id);
  expect(f.native.prepare("SELECT storage_profile_id,verified_sha256,verified_byte_size FROM file_location_publications WHERE location_id=?").get(after.active_location_id!))
    .toEqual({ storage_profile_id: volumes[1]!.profileId, verified_sha256: digest, verified_byte_size: bytes.byteLength });
  const sources = f.native.prepare("SELECT kind,owner,released_at FROM system_recovery_write_leases WHERE kind='scheduled'").all();
  expect(sources).toHaveLength(1); expect(sources[0]!.owner).toMatch(/^node-file-job:/); expect(typeof sources[0]!.released_at).toBe("string");
  const status = await f.request("GET", prefix + "/" + jobId!); expect(status.status).toBe(200);
  expect(status.value).toMatchObject({ id: jobId, actor, moved: 1, remaining: 0 }); released(f);
});

scenario("pauses queued accepted history on explicit executor reconfiguration and requires per-job resume", { administrator: true, enableLocalJobs: true, file: true, enabled: true, accepted: true }, async (f, _fileId, jobId) => {
  const disabled = await f.request("POST", prefix + "/executor", { enabled: false }); expect(disabled.status).toBe(200);
  await enable(f); const before = snapshot(f.native);
  expect(f.native.prepare("SELECT state,reason FROM file_migration_jobs WHERE id=?").get(jobId!))
    .toEqual({ state: "paused", reason: "executor_reconfigured" });
  await f.restart();
  expect(f.native.prepare("SELECT state,reason,actor FROM file_migration_jobs WHERE id=?").get(jobId!))
    .toEqual({ state: "paused", reason: "executor_reconfigured", actor });
  expect(await f.dispatchJobsOnce()).toEqual({ jobId: null, outcome: "idle" });
  expect(count(f.native, "file_migration_attempts")).toBe(0);
  const after = snapshot(f.native);
  expect(after.filter((_, index) => tables[index] !== "file_job_runtime_guard"))
    .toEqual(before.filter((_, index) => tables[index] !== "file_job_runtime_guard"));
  const resumed = await f.request("POST", prefix + "/" + jobId! + "/resume", {});
  expect(resumed.status).toBe(200); expect(resumed.value).toMatchObject({ id: jobId, state: "queued" });
  expect(count(f.native, "file_migration_attempts")).toBe(0); released(f);
});

scenario("refuses a new scheduled source while real recovery is draining without touching queued history", { administrator: true, enableLocalJobs: true, file: true, enabled: true, accepted: true }, async f => {
  const other = f.secondary(); other.prepare("UPDATE system_recovery_maintenance SET state='draining',generation=generation+1 WHERE singleton=1").run();
  const before = snapshot(f.native), sources = count(f.native, "system_recovery_write_leases");
  expect(await f.dispatchJobsOnce()).toEqual({ jobId: null, outcome: "paused" });
  expect(snapshot(f.native)).toEqual(before); expect(count(f.native, "system_recovery_write_leases")).toBe(sources); released(f);
});

scenario("rechecks the real current Job administrator before claim and byte opening", { administrator: true, enableLocalJobs: true, file: true, enabled: true, accepted: true }, async (f, _fileId, jobId) => {
  const other = f.secondary(); other.prepare("DELETE FROM local_admin_grants").run();
  const before = f.native.prepare("SELECT * FROM file_publications ORDER BY file_id").all();
  expect(await f.dispatchJobsOnce()).toEqual({ jobId: null, outcome: "idle" });
  expect(f.native.prepare("SELECT state,reason FROM file_migration_jobs WHERE id=?").get(jobId!))
    .toEqual({ state: "paused", reason: "administrator_revoked" });
  expect(count(f.native, "file_migration_attempts")).toBe(0);
  expect(f.native.prepare("SELECT * FROM file_publications ORDER BY file_id").all()).toEqual(before); released(f);
});

scenario("drains the original scheduled Local byte work before its sole application native and physical owner closes", { administrator: true, enableLocalJobs: true, file: true, enabled: true, accepted: true }, async (f, _fileId, jobId) => {
  const native = f.native, original = f.dispatchJobsOnce();
  const closing = f.stopAndDrainApplication();
  expect(native.isOpen).toBe(true);
  expect((await original).jobId).toBe(jobId); await closing; expect(native.isOpen).toBe(false);
  await expect(f.dispatchJobsOnce()).rejects.toThrow("closed");
  await f.restart(); expect(f.native === native).toBe(false);
  expect(count(f.native, "system_recovery_write_leases", "released_at IS NULL")).toBe(0);
  expect(f.native.prepare("SELECT moved FROM (SELECT count(*) moved FROM file_migration_items WHERE job_id=? AND state='moved')").get(jobId!)?.moved).toBe(1);
  released(f);
});
