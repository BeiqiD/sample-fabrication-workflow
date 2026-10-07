import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../../reference-test-support";
import { d1FileJobDatabase } from "./d1-repository";
import { SqlFileJobRepository } from "./sql-repository";
import { runFileJobStep, runFileJobCleanupStep } from "./migration-kernel";
import type { FileJobCapabilities } from "./types";
import type { Sha256Factory } from "../byte-verification";
import { runFileGarbageCollection } from "../authority-gc";
import { BLOB_ORPHAN_GRACE_MS, BLOB_REGISTRATION_GRACE_MS } from "../../blob-lifecycle/reachability";
import type { Env } from "../../types";
import { setFileJobExecution } from "./worker-runtime";
import { FILE_JOB_MAX_BYTES } from "../../../shared/contracts/file-jobs";

const data = new TextEncoder().encode("source bytes 验证");
const SHA = createHash("sha256").update(data).digest("hex");
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const hash: Sha256Factory = () => {
  const value = createHash("sha256");
  return { async write(bytes) { value.update(bytes); }, async finish() { return value.digest("hex"); }, async abort() {} };
};

function fixture(purposes = ["embedded_content"], byteSize = data.length) {
  const sql = referenceTestDatabase(); databases.push(sql);
  const triggers = sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as { name: string; sql: string }[];
  triggers.forEach(trigger => sql.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`));
  const now = new Date().toISOString();
  sql.prepare("UPDATE file_authority_control SET mode='active',activated_at=?,updated_at=?").run(now, now);
  sql.prepare("UPDATE file_authority_runtime_guard SET incarnation='fixture-authority',enabled=1,enabled_by='test',updated_at=?").run(now);
  sql.prepare("UPDATE file_job_runtime_guard SET enabled=1,incarnation='fixture-jobs'").run();
  for (const profile of ["source", "target"]) {
    sql.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)")
      .run(profile, JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: `fixture-${profile}` }), now);
    sql.prepare("INSERT INTO storage_profile_runtime VALUES(?,'read_write',?,?,NULL)").run(profile, now, now);
  }
  purposes.forEach((purpose, index) => {
    const file = `file-${index}`, location = `source-${index}`;
    sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES(?,?,'system',?,?,'unresolved',?)")
      .run(file, purpose, byteSize, SHA, now);
    sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES(?,?,'source',?,'unresolved',?)")
      .run(location, file, `original/${index}`, now);
    sql.prepare(`INSERT INTO file_location_publications VALUES(?,?,'source',?,?,?,'full_read_sha256','fixture',?,?)`)
      .run(location, file, `original/${index}`, byteSize, SHA, now, now);
    sql.prepare("INSERT INTO file_publications VALUES(?,?,'system',?,?,?,'ready',?,NULL)")
      .run(file, purpose, byteSize, SHA, location, now);
  });
  triggers.forEach(trigger => sql.exec(trigger.sql));
  const db = new SqliteD1Database(sql) as unknown as D1Database;
  const repository = new SqlFileJobRepository(d1FileJobDatabase(db), () => new Date(), () => crypto.randomUUID());
  const objects = new Map<string, Uint8Array>(), requests: string[] = [];
  let admin = true, corrupt = false, lostPutAck = false, missingCandidate = false;
  let beforePut: (() => Promise<void>) | undefined, afterPut: (() => Promise<void>) | undefined;
  const capabilities: FileJobCapabilities = {
    repository, now: () => new Date(), randomId: () => crypto.randomUUID(), incarnation: "fixture-jobs",
    authorizeAdministrator: () => admin, authorizeSystemCleanup: () => true,
    async openStorage(target, _access, guard) {
      const namespace = String(sql.prepare("SELECT namespace_identity FROM storage_profiles WHERE id=?").get(target.profileId)!.namespace_identity);
      return { namespaceIdentity: namespace, adapterType: "r2", createHash: hash, atomicSinglePut: true,
        reader: {
          async read(key) {
            if (!await guard({ method: "GET", key })) return { outcome: "unavailable" };
            requests.push(`GET:${target.profileId}`);
            let bytes = target.profileId === "source" ? data : objects.get(key);
            if (missingCandidate && target.profileId === "target") bytes = undefined;
            if (!bytes) return { outcome: "missing" };
            if (corrupt && target.profileId === "target") { bytes = bytes.slice(); bytes[0] ^= 1; }
            return { outcome: "available", body: new Response(bytes).body!, contentType: "application/octet-stream", etag: null, httpMetadata: {} };
          }, async stat() { return { outcome: "unavailable" }; },
        },
        writer: { accepts: "stream", async write(input) {
          await beforePut?.();
          if (!await guard({ method: "PUT", key: input.key })) throw new Error("denied");
          requests.push("PUT:target");
          const body = await new Response(input.body).arrayBuffer();
          objects.set(input.key, new Uint8Array(body));
          await afterPut?.();
          if (lostPutAck) throw new Error("lost provider acknowledgement");
        } },
      };
    },
  };
  const input = { requestId: crypto.randomUUID(), fileIds: purposes.map((_purpose, index) => `file-${index}`), target: { profileId: "target", configurationRevision: 1 } };
  return { sql, repository, capabilities, input, objects, requests,
    admin(value: boolean) { admin = value; }, corrupt(value: boolean) { corrupt = value; }, lostPutAck(value: boolean) { lostPutAck = value; },
    missingCandidate(value: boolean) { missingCandidate = value; }, beforePut(value: () => Promise<void>) { beforePut = value; },
    afterPut(value: () => Promise<void>) { afterPut = value; } };
}

describe("persisted bounded File migration kernel", () => {
  it("blocks oversized verified Files and more than 100 explicit Files before acceptance or provider I/O", async () => {
    const oversized = fixture(["embedded_content"], FILE_JOB_MAX_BYTES + 1);
    expect((await oversized.repository.plan(oversized.input)).items[0].status).toBe("unsupported_size");
    await expect(oversized.repository.accept(oversized.input, "admin@example.test")).rejects.toThrow("blocking Files");
    expect(oversized.sql.prepare("SELECT count(*) n FROM file_migration_jobs").get()!.n).toBe(0);
    expect(oversized.requests).toEqual([]);
    const many = fixture(Array.from({ length: 101 }, () => "embedded_content"));
    await expect(many.repository.plan(many.input)).rejects.toThrow();
    await expect(many.repository.accept(many.input, "admin@example.test")).rejects.toThrow();
    expect(many.sql.prepare("SELECT count(*) n FROM file_migration_jobs").get()!.n).toBe(0);
    expect(many.requests).toEqual([]);
    expect(many.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("global re-enablement cannot replay queued history until an explicit per-job resume", async () => {
    const f = fixture(), job = await f.repository.accept(f.input, "admin@example.test");
    const original = f.sql.prepare("SELECT input_json,actor,accepted_at FROM file_migration_jobs WHERE id=?").get(job.id);
    const env = { DB: new SqliteD1Database(f.sql) as unknown as D1Database } as Env;
    // A recovered installation restores exact queued history with its local
    // guard disabled. Global enablement alone fences, rather than replays it.
    f.sql.exec("UPDATE file_job_runtime_guard SET enabled=0,incarnation=NULL,last_heartbeat_at=NULL");
    await setFileJobExecution(env, true);
    const incarnation = String(f.sql.prepare("SELECT incarnation FROM file_job_runtime_guard").get()!.incarnation);
    const resumed = { ...f.capabilities, incarnation };
    expect(await f.repository.status(job.id)).toMatchObject({ state: "paused", reason: "executor_reconfigured" });
    expect(await runFileJobStep(resumed)).toEqual({ jobId: null, outcome: "idle" });
    expect(f.requests).toEqual([]);
    expect(f.sql.prepare("SELECT input_json,actor,accepted_at FROM file_migration_jobs WHERE id=?").get(job.id)).toEqual(original);
    await f.repository.control(job.id, "resume");
    expect(await runFileJobStep(resumed)).toMatchObject({ outcome: "moved" });
    expect(f.requests.filter(request => request === "PUT:target")).toHaveLength(1);
  });

  it("restored cleanup audit cannot release holds without a fresh installation cleanup request", async () => {
    const f = fixture(), job = await f.repository.accept(f.input, "admin@example.test");
    await runFileJobStep(f.capabilities);
    await f.repository.requestCleanup(job.id, "old-cleanup@example.test");
    f.sql.prepare("UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), job.id);
    const history = f.sql.prepare("SELECT cleanup_requested_at,cleanup_actor,cleanup_not_before FROM file_migration_items WHERE job_id=?").get(job.id);
    f.sql.exec("DELETE FROM file_job_cleanup_grants; UPDATE file_job_runtime_guard SET enabled=0,incarnation=NULL,last_heartbeat_at=NULL");
    await setFileJobExecution({ DB: new SqliteD1Database(f.sql) as unknown as D1Database } as Env, true);
    const incarnation = String(f.sql.prepare("SELECT incarnation FROM file_job_runtime_guard").get()!.incarnation);
    const resumed = { ...f.capabilities, incarnation }, requests = f.requests.length;
    expect(await runFileJobCleanupStep(resumed)).toEqual({ outcome: "idle" });
    expect(f.requests).toHaveLength(requests);
    expect(f.sql.prepare("SELECT released_at FROM file_location_holds WHERE location_id='source-0' AND hold_kind='transition_source'").get()!.released_at).toBeNull();
    await f.repository.requestCleanup(job.id, "new-cleanup@example.test");
    expect(f.sql.prepare("SELECT cleanup_requested_at,cleanup_actor,cleanup_not_before FROM file_migration_items WHERE job_id=?").get(job.id)).toEqual(history);
    expect(f.sql.prepare("SELECT actor,runtime_incarnation FROM file_job_cleanup_grants WHERE job_id=?").get(job.id))
      .toEqual({ actor: "new-cleanup@example.test", runtime_incarnation: incarnation });
    expect(await runFileJobCleanupStep(resumed)).toEqual({ outcome: "released_to_gc" });
  });
  it("atomically freezes every purpose and moves one independently verified File per invocation", async () => {
    const f = fixture(["research_source", "embedded_content", "derived_preview", "provenance", "job_output"]);
    const plan = await f.repository.plan(f.input);
    expect(plan.bytesVerified).toBe(false); expect(plan.transferAndVerificationBytes).toBe(data.length * 15);
    const job = await f.repository.accept(f.input, "admin@example.test");
    expect(await f.repository.accept(f.input, "admin@example.test")).toEqual(job);
    await expect(f.repository.accept({ ...f.input, fileIds: ["file-0"] }, "admin@example.test")).rejects.toThrow("differs");
    for (let remaining = 4; remaining >= 0; remaining--) {
      expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "moved" });
      expect(await f.repository.status(job.id)).toMatchObject({ remaining, moved: 5 - remaining, cleanupPending: 5 - remaining });
    }
    expect(f.requests.filter(request => request === "PUT:target")).toHaveLength(5);
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE hold_kind='transition_source' AND released_at IS NULL").get()!.n).toBe(5);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("never cuts over a corrupt target and retains both exact locations", async () => {
    const f = fixture(); f.corrupt(true);
    const job = await f.repository.accept(f.input, "admin@example.test");
    expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "paused" });
    expect(await f.repository.status(job.id)).toMatchObject({ moved: 0, cleanupPending: 1 });
    expect(f.sql.prepare("SELECT active_location_id FROM file_publications").get()!.active_location_id).toBe("source-0");
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(2);
  });

  it("reconciles a lost PUT acknowledgement after executor restart without another PUT", async () => {
    const f = fixture(); f.lostPutAck(true);
    const job = await f.repository.accept(f.input, "admin@example.test");
    expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "paused" });
    const restart = new SqlFileJobRepository(d1FileJobDatabase(new SqliteD1Database(f.sql) as unknown as D1Database), () => new Date(), () => crypto.randomUUID());
    await restart.control(job.id, "resume"); f.lostPutAck(false);
    expect(await runFileJobStep({ ...f.capabilities, repository: restart })).toMatchObject({ outcome: "moved" });
    expect(f.requests.filter(request => request === "PUT:target")).toHaveLength(1);
  });

  it("missing HEAD/GET and lease reclamation do not collect or replay an unknown candidate", async () => {
    const f = fixture(); f.lostPutAck(true);
    const job = await f.repository.accept(f.input, "admin@example.test");
    await runFileJobStep(f.capabilities); f.missingCandidate(true);
    await f.repository.control(job.id, "resume");
    expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "paused" });
    expect(f.requests.filter(request => request === "PUT:target")).toHaveLength(1);
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(2);
  });

  it("blocks a request reclaimed after caller admission and fences a late old executor", async () => {
    const f = fixture();
    const job = await f.repository.accept(f.input, "admin@example.test");
    f.beforePut(async () => { await f.repository.control(job.id, "pause"); });
    expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "paused" });
    expect(f.requests).not.toContain("PUT:target");
    expect(f.sql.prepare("SELECT active_location_id FROM file_publications").get()!.active_location_id).toBe("source-0");
    // The database cutover fence rejects even a manually inserted paired hold
    // without current verified ownership, independent of the service's check.
    const candidate = String(f.sql.prepare("SELECT location_id FROM file_migration_attempts").get()!.location_id);
    expect(() => f.sql.prepare("UPDATE file_publications SET active_location_id=? WHERE file_id='file-0'").run(candidate))
      .toThrow("fenced attempt");
  });

  it("records positive late settlement but revoked administrators cannot publish", async () => {
    const f = fixture(); const job = await f.repository.accept(f.input, "admin@example.test");
    f.afterPut(async () => { f.admin(false); await f.repository.control(job.id, "pause"); });
    await runFileJobStep(f.capabilities);
    expect(f.sql.prepare("SELECT io_settled_at FROM file_migration_attempts").get()!.io_settled_at).not.toBeNull();
    expect(f.sql.prepare("SELECT active_location_id FROM file_publications").get()!.active_location_id).toBe("source-0");
    await f.repository.control(job.id, "resume");
    const requests = f.requests.length; await runFileJobStep(f.capabilities);
    expect(f.requests).toHaveLength(requests);
  });

  it("requires explicit source cleanup, grace and a freshly verified protected destination", async () => {
    const f = fixture(); const job = await f.repository.accept(f.input, "admin@example.test");
    await runFileJobStep(f.capabilities);
    expect(await runFileJobCleanupStep(f.capabilities)).toEqual({ outcome: "idle" });
    await f.repository.requestCleanup(job.id, "cleanup-admin@example.test");
    expect(await runFileJobCleanupStep(f.capabilities)).toEqual({ outcome: "idle" });
    f.sql.prepare("UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), job.id);
    f.corrupt(true);
    expect(await runFileJobCleanupStep(f.capabilities)).toEqual({ outcome: "pending" });
    f.corrupt(false); f.admin(false);
    expect(await runFileJobCleanupStep(f.capabilities)).toEqual({ outcome: "released_to_gc" });
    expect(f.sql.prepare("SELECT released_at FROM file_location_holds WHERE location_id='source-0' AND hold_kind='transition_source'").get()!.released_at).not.toBeNull();
    expect(await f.repository.status(job.id)).toMatchObject({ cleanupPending: 1 }); // Physical GC is still owed.
  });

  it("settles committed database acknowledgements by immutable receipts and exact fenced readbacks", async () => {
    const f = fixture(), base = d1FileJobDatabase(new SqliteD1Database(f.sql) as unknown as D1Database);
    const uncertain = { prepare: base.prepare, primary() { return uncertain; },
      async batch(statements: Parameters<typeof base.batch>[0]) { await base.batch(statements); throw new Error("lost database acknowledgement"); } };
    const repository = new SqlFileJobRepository(uncertain, () => new Date(), () => crypto.randomUUID());
    const job = await repository.accept(f.input, "admin@example.test");
    expect(await runFileJobStep({ ...f.capabilities, repository })).toMatchObject({ outcome: "moved" });
    expect(await repository.status(job.id)).toMatchObject({ moved: 1, remaining: 0 });
    expect(f.requests.filter(request => request === "PUT:target")).toHaveLength(1);
  });

  it("retries a positively settled corrupt attempt under a new registered candidate key", async () => {
    const f = fixture(); f.corrupt(true);
    const job = await f.repository.accept(f.input, "admin@example.test");
    await runFileJobStep(f.capabilities);
    expect(await f.repository.status(job.id)).toMatchObject({ failed: 1, cleanupPending: 1 });
    const original = String(f.sql.prepare("SELECT object_key FROM file_migration_attempts").get()!.object_key);
    f.corrupt(false); await f.repository.control(job.id, "retry");
    expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "moved" });
    const keys = f.sql.prepare("SELECT object_key FROM file_migration_attempts").all().map(row => row.object_key);
    expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(2); expect(keys).toContain(original);
  });

  it("revoked acceptance and restored disabled execution never start provider work", async () => {
    const f = fixture(); let checks = 0;
    await expect(f.repository.accept(f.input, "admin@example.test", () => ++checks === 1)).rejects.toThrow("authorization");
    expect(f.sql.prepare("SELECT count(*) n FROM file_migration_jobs").get()!.n).toBe(0);
    const job = await f.repository.accept(f.input, "admin@example.test");
    f.sql.exec("UPDATE file_job_runtime_guard SET enabled=0,incarnation=NULL,last_heartbeat_at=NULL");
    expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "idle" });
    expect(f.requests).toEqual([]); expect(await f.repository.status(job.id)).toMatchObject({ state: "queued", remaining: 1 });
    expect(await f.repository.executorStatus()).toMatchObject({ enabled: false, stale: true });
  });

  it("cancels safely and explicitly reconciles an unknown completed candidate before GC admission", async () => {
    const f = fixture(); f.lostPutAck(true);
    const job = await f.repository.accept(f.input, "admin@example.test"); await runFileJobStep(f.capabilities);
    await f.repository.control(job.id, "cancel");
    await f.repository.control(job.id, "retry");
    expect(await f.repository.status(job.id)).toMatchObject({ state: 'cancelled' });
    expect(f.sql.prepare("SELECT state FROM file_migration_items WHERE job_id=?").get(job.id)!.state).toBe('copying');
    await f.repository.requestCleanup(job.id, "cleanup-admin@example.test");
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(2);
    f.sql.prepare("UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), job.id);
    expect(await runFileJobCleanupStep(f.capabilities)).toEqual({ outcome: "artifact_released_to_gc" });
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT active_location_id FROM file_publications").get()!.active_location_id).toBe("source-0");
    expect(f.requests.filter(request => request === "PUT:target")).toHaveLength(1);
  });

  it("cancelling a settled failed PUT retains its artifacts until separately accepted cleanup", async () => {
    const f = fixture(); f.corrupt(true);
    const job = await f.repository.accept(f.input, 'admin@example.test');
    await runFileJobStep(f.capabilities);
    expect(f.sql.prepare("SELECT state,io_settled_at FROM file_migration_attempts").get()).toMatchObject({ state: 'failed' });
    await f.repository.control(job.id, 'cancel');
    expect(await runFileJobCleanupStep(f.capabilities)).toEqual({ outcome: 'idle' });
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL AND hold_kind IN('transition_source','transition_destination')").get()!.n).toBe(2);
    expect(await f.repository.status(job.id)).toMatchObject({ state: 'cancelled', cleanupPending: 1 });
    await f.repository.requestCleanup(job.id, 'cleanup-admin@example.test');
    f.sql.prepare("UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), job.id);
    expect(await runFileJobCleanupStep(f.capabilities)).toEqual({ outcome: 'artifact_released_to_gc' });
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL AND hold_kind IN('transition_source','transition_destination')").get()!.n).toBe(0);
    expect(await f.repository.status(job.id)).toMatchObject({ cleanupPending: 1 });
  });

  it("explicitly retries an unknown attempt with a fresh key while preserving the old holds", async () => {
    const f = fixture(); f.lostPutAck(true);
    const job = await f.repository.accept(f.input, "admin@example.test"); await runFileJobStep(f.capabilities);
    const original = String(f.sql.prepare("SELECT object_key FROM file_migration_attempts").get()!.object_key);
    f.lostPutAck(false); await f.repository.control(job.id, "retry");
    expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "moved" });
    const attempts = f.sql.prepare("SELECT object_key,state FROM file_migration_attempts ORDER BY created_at").all();
    expect(attempts).toHaveLength(2); expect(attempts[0]).toMatchObject({ object_key: original, state: "unknown" });
    expect(attempts[1].object_key).not.toBe(original); expect(attempts[1].state).toBe("published");
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(2);
  });

  it("bounds unknown retry candidates and reports an actionable exhausted limit", async () => {
    const f = fixture(); f.lostPutAck(true);
    const job = await f.repository.accept(f.input, "admin@example.test");
    for (let index = 0; index < 5; index++) {
      if (index) await f.repository.control(job.id, "retry");
      expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "paused" });
    }
    expect(await f.repository.control(job.id, "retry")).toMatchObject({ state: "paused", reason: "retry_limit_exhausted" });
    expect(await runFileJobStep(f.capabilities)).toMatchObject({ outcome: "idle" });
    expect(f.requests.filter(request => request === "PUT:target")).toHaveLength(5);
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(6);
    expect((await f.repository.items(job.id)).items[0]).toMatchObject({ attemptCount: 5, maxAttempts: 5 });
  });

  it("orders same-millisecond retry attempts by generation and settles each stage by its exact registered ID", async () => {
    const f=fixture(),at=new Date(),ids:string[]=[];
    const repository=new SqlFileJobRepository(d1FileJobDatabase(new SqliteD1Database(f.sql) as unknown as D1Database),()=>at,()=>ids.shift()??crypto.randomUUID());
    const job=await repository.accept(f.input,"admin@example.test");
    const first=(await repository.claim("fixture-jobs","first-owner",()=>true))!,item=(await repository.nextItem(first))!;
    ids.push("z-attempt","z-location","z-hold");
    const old=await repository.stage(first,item);
    await repository.pause(first,"never_started");await repository.control(job.id,"retry");
    const second=(await repository.claim("fixture-jobs","second-owner",()=>true))!;
    expect(second.generation).toBeGreaterThan(first.generation);
    ids.push("a-attempt","a-location","a-hold");
    const current=await repository.stage(second,item);
    expect(current.id).toBe("a-attempt");expect(old.id).toBe("z-attempt");
    expect((await repository.attempt(item))!.id).toBe(current.id);
    expect(f.sql.prepare("SELECT DISTINCT created_at FROM file_migration_attempts WHERE job_id=?").all(job.id)).toHaveLength(1);
    expect(f.sql.prepare("SELECT count(*) n FROM file_migration_attempts WHERE job_id=?").get(job.id)!.n).toBe(2);
    expect(f.requests).toEqual([]);
  });

  it("admits only one concurrent owner and exposes missed dispatcher heartbeats", async () => {
    const f = fixture(), job = await f.repository.accept(f.input, "admin@example.test");
    expect(await f.repository.executorStatus()).toMatchObject({ enabled: true, stale: true });
    const claims = await Promise.all([f.repository.claim("fixture-jobs", "owner-one", () => true),
      f.repository.claim("fixture-jobs", "owner-two", () => true)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await f.repository.heartbeat("fixture-jobs");
    expect(await f.repository.executorStatus()).toMatchObject({ stale: false });
    const owner = claims.find(Boolean)!; await f.repository.pause(owner, "test_restart");
    expect(await f.repository.status(job.id)).toMatchObject({ state: "paused", remaining: 1 });
    expect(f.requests).toEqual([]);
  });

  it("actual File GC collects settled terminal candidates while protecting unknown writes and source holds", async () => {
    const f = fixture(["embedded_content", "research_source"]); f.lostPutAck(true);
    const unknownJob = await f.repository.accept({ ...f.input, fileIds: ["file-0"] }, "admin@example.test");
    await runFileJobStep(f.capabilities);
    const unknown = f.sql.prepare("SELECT location_id,object_key FROM file_migration_attempts WHERE job_id=?").get(unknownJob.id)!;
    f.lostPutAck(false); f.corrupt(true);
    const terminalJob = await f.repository.accept({ ...f.input, requestId: crypto.randomUUID(), fileIds: ["file-1"] }, "admin@example.test");
    await runFileJobStep(f.capabilities);
    const terminal = f.sql.prepare("SELECT location_id,object_key FROM file_migration_attempts WHERE job_id=?").get(terminalJob.id)!;
    await f.repository.requestCleanup(terminalJob.id, "cleanup-admin@example.test");
    f.sql.prepare("UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), terminalJob.id);
    expect(await runFileJobCleanupStep(f.capabilities)).toEqual({ outcome: "artifact_released_to_gc" });
    expect(await f.repository.status(terminalJob.id)).toMatchObject({ cleanupPending: 1 });
    expect((await f.repository.items(terminalJob.id)).items[0]).toMatchObject({ artifactCleanupPending: 1, sourceCleanupPending: false,
      cleanupState: 'released_to_gc', cleanup: { deleted: false } });
    // Independently retain source-1 so this fixture exercises only the target
    // candidate's real native deletion boundary, with all production guards on.
    const at = new Date();
    f.sql.prepare("INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at) VALUES(?,'source-1','operator',?,'Retained source fixture',?)")
      .run(crypto.randomUUID(), crypto.randomUUID(), at.toISOString());
    const deleted: string[] = [];
    const namespace = String(f.sql.prepare("SELECT namespace_identity FROM storage_profiles WHERE id='target'").get()!.namespace_identity);
    const env = { DB: new SqliteD1Database(f.sql) as unknown as D1Database, R2_BOOTSTRAP_NAMESPACE: namespace,
      ASSETS: { async delete(key: string) { deleted.push(key); f.objects.delete(key); }, async head() { return null; } } as unknown as R2Bucket } as Env;
    const registered = new Date(at.getTime() + BLOB_REGISTRATION_GRACE_MS + 1000);
    await runFileGarbageCollection(env, registered);
    expect(f.sql.prepare("SELECT state FROM file_location_gc_ledger WHERE location_id=?").get(terminal.location_id)!.state).toBe("orphaned");
    expect(f.sql.prepare("SELECT state FROM file_location_gc_ledger WHERE location_id=?").get(unknown.location_id)).toBeUndefined();
    await runFileGarbageCollection(env, new Date(registered.getTime() + BLOB_ORPHAN_GRACE_MS + 1000));
    expect(deleted).toEqual([terminal.object_key]);
    expect(f.objects.has(String(unknown.object_key))).toBe(true);
    expect(f.sql.prepare("SELECT state FROM file_location_gc_ledger WHERE location_id=?").get(terminal.location_id)!.state).toBe("deleted");
    expect(await f.repository.status(terminalJob.id)).toMatchObject({ cleanupPending: 0 });
    expect((await f.repository.items(terminalJob.id)).items[0]).toMatchObject({ artifactCleanupPending: 0, sourceCleanupPending: false,
      cleanupState: 'complete', cleanup: { deleted: false } });
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE location_id=? AND released_at IS NULL").get(unknown.location_id)!.n).toBe(1);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
