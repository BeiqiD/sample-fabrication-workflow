import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AcceptFileMigrationInput, FileJobStatus, FileMigrationPlan } from "../../../shared/contracts/file-jobs";
import { SqlFileJobRepository } from "../../../worker/files/jobs/sql-repository";
import { asJobSqlDatabase } from "../../sqlite";
import { createNodeFileJobHttpRoutes } from "./request-http";
import { CONTENT, DIGEST, JOB_TABLES, actor, principalId, prepareTemplate, fixture,
  drainFixtures, originalOperation } from "./request-http.qualification-support";

// These cases are source-only. Real sockets/password sessions/native BEGIN
// controls qualify this unmounted component, not a provider or running host.
beforeAll(() => originalOperation(prepareTemplate));
afterEach(drainFixtures); afterAll(drainFixtures);
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Delivery = Awaited<ReturnType<Fixture["login"]>>;
const ROOT = "/api/files/migrations";
const selection = (): AcceptFileMigrationInput => ({ requestId: randomUUID(), fileIds: ["file"],
  target: { profileId: "target", configurationRevision: 1 } });
const headers = (f: Fixture, login: Delivery) => ({ origin: f.origin, cookie: login.cookie,
  "x-sfw-csrf": login.csrf, "content-type": "application/json" });
const call = (f: Fixture, login: Delivery, suffix: string, value: unknown = {}) =>
  f.request(ROOT + suffix, { method: "POST", headers: headers(f, login), body: JSON.stringify(value) });
function rows(native: DatabaseSync, tables: readonly string[] = JOB_TABLES) {
  return tables.map(table => { const q = native.prepare(`SELECT * FROM "${table}" ORDER BY 1`); q.setReadBigInts(true); return [table, q.all()]; });
}
async function accepted(f: Fixture, login: Delivery) {
  const input = selection(), response = await call(f, login, "", input); expect(response.status).toBe(202);
  return { input, job: await response.json() as FileJobStatus };
}
describe("unmounted original Node File job HTTP component with actual installed administrator Request", () => {
  it("reads original job history without opening a provider", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), preserved = rows(f.native, ["file_publications", "file_location_publications"]);
    const list = await f.request(ROOT, { headers: { cookie: login.cookie } }); expect(list.status).toBe(200); expect(await list.json()).toEqual({ jobs: [] });
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(rows(f.native, ["file_publications", "file_location_publications"])).toEqual(preserved);
    expect(f.native.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()?.n).toBe(0);
  }));
  it("reads original bounded File inventory without opening a provider", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), preserved = rows(f.native, ["file_publications", "file_location_publications"]);
    const inventory = await f.request(ROOT + "/files?limit=1", { headers: { cookie: login.cookie } }); expect(inventory.status).toBe(200);
    expect(await inventory.json()).toMatchObject({ items: [{ fileId: "file", byteSize: CONTENT.length, sha256: DIGEST }], nextCursor: null });
    expect(inventory.headers.get("cache-control")).toBe("private, no-store");
    expect(rows(f.native, ["file_publications", "file_location_publications"])).toEqual(preserved);
    expect(f.native.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()?.n).toBe(0);
  }));
  it("reads original bounded executor metadata without opening a provider", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), preserved = rows(f.native, ["file_publications", "file_location_publications"]);
    const executor = await f.request(ROOT + "/executor", { headers: { cookie: login.cookie } }); expect(executor.status).toBe(200);
    expect(await executor.json()).toEqual({ enabled: true, lastHeartbeatAt: null, stale: true, cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60000 });
    expect(executor.headers.get("cache-control")).toBe("private, no-store");
    expect(rows(f.native, ["file_publications", "file_location_publications"])).toEqual(preserved);
    expect(f.native.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()?.n).toBe(0);
  }));
  it("reconciles the original accepted request while execution is disabled and rejects foreign receipts or revoked administrators", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), { input, job } = await accepted(f, login);
    const foreignInput = selection();
    const repository = new SqlFileJobRepository(asJobSqlDatabase(f.core), () => new Date(), randomUUID);
    await f.lease.withWriter(() => repository.accept(foreignInput, "local-account:another-operator"));
    f.native.prepare("UPDATE file_job_runtime_guard SET enabled=0,incarnation=NULL WHERE singleton=1").run();
    const preserved = rows(f.native, [...JOB_TABLES, "file_job_runtime_guard", "file_publications", "file_location_publications"]);
    const leases = f.native.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()?.n;
    const read = (requestId: string) => f.request(`${ROOT}/requests/${encodeURIComponent(requestId)}`, { headers: { cookie: login.cookie } });
    const receipt = await read(input.requestId);
    expect(receipt.status).toBe(200); expect(receipt.headers.get("cache-control")).toBe("private, no-store");
    expect(await receipt.json()).toEqual({ requestId: input.requestId, input, job });
    const absentRequestId = randomUUID(), absent = await read(absentRequestId);
    expect(absent.status).toBe(404); expect(absent.headers.get("cache-control")).toBe("private, no-store");
    expect(await absent.json()).toEqual({ schema: "file-migration-request-absent/1", requestId: absentRequestId });
    const foreign = await read(foreignInput.requestId); expect(foreign.status).toBe(409);
    expect(await foreign.text()).toBe("File migration request conflicts with its accepted identity");
    f.native.prepare("DELETE FROM local_admin_grants WHERE principal_id=?").run(principalId);
    const denied = await read(input.requestId); expect(denied.status).toBe(403); await denied.text();
    expect(rows(f.native, [...JOB_TABLES, "file_job_runtime_guard", "file_publications", "file_location_publications"])).toEqual(preserved);
    expect(f.native.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()?.n).toBe(leases);
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_attempts").get()?.n).toBe(0);
  }));
  it("retains original plan cost, accepted identity, exact retry and items without byte verification", () => originalOperation(async () => {
    const startedAt = performance.now();
    const phases: { phase: string; elapsedMs: number }[] = [];
    const mark = (phase: string) => phases.push({ phase, elapsedMs: performance.now() - startedAt });
    let originalFailure: unknown;
    mark("case.started");
    try {
    const f = await fixture(); mark("fixture.ready");
    const login = await f.login(); mark("login.ready");
    const input = selection();
    const preview = await call(f, login, "/plans", input); mark("preview.response"); expect(preview.status).toBe(200);
    const plan = await preview.json() as FileMigrationPlan; mark("preview.body");
    expect(plan).toMatchObject({ bytes: CONTENT.length, retainedSourceBytes: CONTENT.length, stagingBytes: CONTENT.length * 5,
      transferAndVerificationBytes: CONTENT.length * 3, maxTransferAndVerificationBytes: CONTENT.length * 15, maxAttemptsPerFile: 5, bytesVerified: false });
    expect(plan.items).toMatchObject([{ fileId: "file", sha256: DIGEST, status: "eligible" }]);
    const first = await call(f, login, "", input); mark("accept.response"); expect(first.status).toBe(202); const job = await first.json() as FileJobStatus; mark("accept.body");
    expect(job).toMatchObject({ actor, state: "queued", remaining: 1, moved: 0, failed: 0 });
    const before = rows(f.native), retry = await call(f, login, "", input); mark("retry.response"); expect(retry.status).toBe(202); expect(await retry.json()).toEqual(job); mark("retry.body");
    expect(rows(f.native)).toEqual(before);
    const status = await f.request(`${ROOT}/${job.id}`, { headers: { cookie: login.cookie } }); mark("status.response"); expect(status.status).toBe(200); expect(await status.json()).toEqual(job); mark("status.body");
    const items = await f.request(`${ROOT}/${job.id}/items`, { headers: { cookie: login.cookie } }); mark("items.response"); expect(items.status).toBe(200);
    expect(await items.json()).toMatchObject({ items: [{ fileId: "file", state: "pending", attempt: null, attemptCount: 0 }], hasMore: false }); mark("items.body");
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_attempts").get()?.n).toBe(0);
    mark("assertions.finished");
    } catch (error) { originalFailure = error; mark("original.rejected"); throw error; }
    finally {
      mark("original.settled");
      // Only fixed phase names and monotonic numeric timings leave this QA scope.
      // The original rejection is retained and rethrown unchanged above.
      try { console.info("Job original plan phase timing:", JSON.stringify({ phases,
        originalRejected: originalFailure !== undefined })); } catch { /* Diagnostic output cannot replace the original result. */ }
    }
  }));
  it("preserves original pause, resume, retry, cancel and separately accepted cleanup metadata", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), { job } = await accepted(f, login);
    for (const [action, state] of [["pause", "paused"], ["resume", "queued"], ["retry", "queued"], ["cancel", "cancelled"]] as const) {
      const response = await call(f, login, `/${job.id}/${action}`); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ id: job.id, state });
    }
    const cleanup = await call(f, login, `/${job.id}/cleanup`); expect(cleanup.status).toBe(202);
    expect(f.native.prepare("SELECT cleanup_actor,cleanup_requested_at,cleanup_released_at FROM file_migration_items WHERE job_id=?").get(job.id))
      .toMatchObject({ cleanup_actor: actor, cleanup_requested_at: expect.any(String), cleanup_released_at: null });
    expect(f.native.prepare("SELECT actor,runtime_incarnation FROM file_job_cleanup_grants WHERE job_id=?").get(job.id))
      .toEqual({ actor, runtime_incarnation: "historical-http-jobs" });
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_attempts").get()?.n).toBe(0);
  }));
  it("explicitly reconfigures metadata and pauses queued history without starting any scheduler", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), { job } = await accepted(f, login);
    const before = f.native.prepare("SELECT generation FROM file_migration_jobs WHERE id=?").get(job.id)?.generation;
    const disabled = await call(f, login, "/executor", { enabled: false }); expect(disabled.status).toBe(200); expect(await disabled.json()).toMatchObject({ enabled: false });
    expect(f.native.prepare("SELECT enabled,incarnation,last_heartbeat_at FROM file_job_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null, last_heartbeat_at: null });
    expect(f.native.prepare("SELECT state,reason,generation,owner_token,lease_expires_at FROM file_migration_jobs WHERE id=?").get(job.id))
      .toEqual({ state: "paused", reason: "executor_reconfigured", generation: Number(before) + 1, owner_token: null, lease_expires_at: null });
    const enabled = await call(f, login, "/executor", { enabled: true }); expect(enabled.status).toBe(200); expect(await enabled.json()).toMatchObject({ enabled: true, stale: true });
    expect(f.native.prepare("SELECT state,reason FROM file_migration_jobs WHERE id=?").get(job.id)).toEqual({ state: "paused", reason: "executor_reconfigured" });
    expect(f.native.prepare("SELECT incarnation FROM file_job_runtime_guard").get()?.incarnation).not.toBe("historical-http-jobs");
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_attempts").get()?.n).toBe(0);
  }));
  it("keeps original input bounds and unavailable destination control without partial acceptance", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), before = rows(f.native);
    const invalidLimit = await f.request(ROOT + "/files?limit=101", { headers: { cookie: login.cookie } }); expect(invalidLimit.status).toBe(400);
    const invalidCursor = await f.request(ROOT + "/files?cursor=%20", { headers: { cookie: login.cookie } }); expect(invalidCursor.status).toBe(400);
    const tooLarge = await f.request(ROOT + "/plans", { method: "POST", headers: headers(f, login), body: "x".repeat(32 * 1024 + 1) }); expect(tooLarge.status).toBe(413);
    const input = selection(); input.target.configurationRevision = 2;
    const unavailable = await call(f, login, "/plans", input); expect(unavailable.status).toBe(409);
    expect(rows(f.native)).toEqual(before);
    expect(f.native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
  }));
  it("rejects copied owners, unadmitted Request and currently removed administrator grant", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), before = rows(f.native);
    expect(() => createNodeFileJobHttpRoutes({ authority: { ...f.authority }, authentication: f.auth, admission: f.admission, writerLease: f.lease })).toThrow("authority");
    expect(() => createNodeFileJobHttpRoutes({ authority: f.authority, authentication: { ...f.auth }, admission: f.admission, writerLease: f.lease })).toThrow("owner");
    const clone = await f.lease.withWriter(() => f.app.fetch(new Request(f.origin + ROOT, { headers: { cookie: login.cookie } })));
    f.retainResponse(clone); // The exact direct app Response is also a client body owner.
    expect(clone.status).toBe(403);
    f.native.prepare("DELETE FROM local_admin_grants WHERE principal_id=?").run(principalId);
    const denied = await call(f, login, "", selection()); expect(denied.status).toBe(403); expect(rows(f.native)).toEqual(before);
    expect(f.native.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()?.n).toBe(0);
  }));
  it("rechecks a real persisted session immediately before native BEGIN and rejects every write", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), before = rows(f.native), second = f.secondary();
    const original = f.native.exec.bind(f.native), prepare = f.native.prepare.bind(f.native);
    let refreshes = 0, armed = false, observed = false;
    f.native.prepare = ((sql: string) => {
      if (sql.startsWith("UPDATE local_sessions SET last_seen_at=? WHERE token_hash=?")) refreshes++;
      return prepare(sql);
    }) as typeof f.native.prepare;
    f.native.exec = sql => {
      if (armed && sql === "BEGIN IMMEDIATE") { armed = false; observed = true;
        second.prepare("UPDATE local_sessions SET revoked_at=MAX(created_at,?) WHERE token_hash=?").run(Date.now(), login.tokenHash); }
      const result = original(sql);
      // Observe both original identity refreshes (middleware and Job owner),
      // then revoke before the first genuine admitted Job BEGIN, not in auth.
      if (sql === "COMMIT" && refreshes === 2 && !observed) armed = true;
      return result;
    };
    try { expect((await call(f, login, "/executor", { enabled: false })).status).toBe(401); }
    finally { f.native.exec = original; f.native.prepare = prepare; }
    expect(refreshes).toBe(2); expect(observed).toBe(true); expect(rows(f.native)).toEqual(before);
    expect(f.native.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard").get()).toEqual({ enabled: 1, incarnation: "historical-http-jobs" });
    expect(f.native.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()?.n).toBe(0);
  }));
  it("keeps committed acceptance after late session revocation and reconciles the exact retry once", () => originalOperation(async () => {
    const f = await fixture(), login = await f.login(), second = f.secondary(), input = selection();
    const prepare = f.native.prepare.bind(f.native), execute = f.native.exec.bind(f.native); let write = false, revoked = false;
    f.native.prepare = ((sql: string) => { if (sql.includes("INSERT INTO file_migration_jobs(id,request_id")) write = true; return prepare(sql); }) as typeof f.native.prepare;
    f.native.exec = sql => { const result = execute(sql); if (sql === "COMMIT" && write && !revoked) {
      revoked = true; second.prepare("UPDATE local_sessions SET revoked_at=MAX(created_at,?) WHERE token_hash=?").run(Date.now(), login.tokenHash);
    } return result; };
    try { expect((await call(f, login, "", input)).status).toBe(401); }
    finally { f.native.prepare = prepare; f.native.exec = execute; }
    expect(revoked).toBe(true);
    const committed = f.native.prepare("SELECT id,actor,state FROM file_migration_jobs WHERE request_id=?").get(input.requestId);
    expect(committed).toMatchObject({ actor, state: "queued" }); expect(f.native.prepare("SELECT count(*) n FROM file_migration_items").get()?.n).toBe(1);
    expect(f.native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
    const again = await f.login(), before = rows(f.native), replay = await call(f, again, "", input); expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ id: committed?.id, actor, state: "queued" }); expect(rows(f.native)).toEqual(before);
  }));
  it("retains the original held request through maintenance continuation and host drain before native close", () => originalOperation(async () => {
    const startedAt = performance.now();
    const heldPhase = (phase: "case.started" | "fixture.ready" | "login.ready" | "request.started" | "request.prefix-written"
      | "lease.commit-observed" | "lease.acquired" | "executor.denied" | "close.begun" | "close.fulfilled"
      | "request.remainder-ended" | "response.complete" | "close.complete" | "assertions.finished" | "finally.started"
      | "finally.remainder-ended" | "finally.response-settled" | "finally.close-settled" | "finally.finished") => {
      try { console.info("Job original held phase timing:", JSON.stringify({ phase, elapsedMs: performance.now() - startedAt })); }
      catch { /* A passive fixed-label diagnostic cannot replace the original operation. */ }
    };
    heldPhase("case.started");
    const f = await fixture(); heldPhase("fixture.ready");
    const login = await f.login(); heldPhase("login.ready");
    const input = selection(), body = JSON.stringify(input), execute = f.native.exec.bind(f.native);
    const prepare = f.native.prepare.bind(f.native); let actualReleases = 0, observedRelease: unknown;
    f.native.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith("UPDATE system_recovery_write_leases SET released_at=?")) {
        const run = statement.run.bind(statement);
        statement.run = ((...bindings: Parameters<typeof run>) => {
          const result = run(...bindings); actualReleases++;
          observedRelease = prepare("SELECT released_at FROM system_recovery_write_leases WHERE released_at IS NOT NULL").get()?.released_at;
          return result;
        }) as typeof statement.run;
      }
      return statement;
    }) as typeof f.native.prepare;
    let acquired!: () => void; const held = new Promise<void>(resolve => { acquired = resolve; });
    let firstCommitObserved = false;
    f.native.exec = sql => { const result = execute(sql); if (sql === "COMMIT"
      && f.native.prepare("SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL").get()) {
        if (!firstCommitObserved) { firstCommitObserved = true; heldPhase("lease.commit-observed"); }
        acquired();
      } return result; };
    let originalRequest: ReturnType<typeof httpRequest> | undefined, response: Promise<number> | undefined;
    let close: Promise<void> | undefined, completed = false;
    try {
      response = new Promise<number>((resolve, reject) => {
        originalRequest = httpRequest(f.origin + ROOT, { method: "POST", headers: headers(f, login) }, incoming => {
          incoming.resume(); incoming.once("end", () => resolve(incoming.statusCode!)); incoming.once("error", reject);
        }); originalRequest.once("error", reject); heldPhase("request.started"); originalRequest.write(body.slice(0, 5)); heldPhase("request.prefix-written");
      });
      await held; heldPhase("lease.acquired");
      const lease = f.native.prepare("SELECT id,generation,owner,released_at FROM system_recovery_write_leases WHERE released_at IS NULL").get();
      expect(lease).toMatchObject({ owner: actor, released_at: null });
      if (typeof lease?.id !== "string" || !originalRequest) throw new Error("Actual retained request/lease is unavailable");
      f.native.prepare("UPDATE system_recovery_maintenance SET state='draining',generation=generation+1 WHERE singleton=1").run();
      expect((await call(f, login, "/executor", { enabled: false })).status).toBe(503); heldPhase("executor.denied");
      close = f.close(); heldPhase("close.begun"); void close.then(() => { completed = true; heldPhase("close.fulfilled"); }, () => undefined);
      await Promise.resolve(); expect(completed).toBe(false); expect(f.native.isOpen).toBe(true);
      expect(f.native.prepare("SELECT released_at FROM system_recovery_write_leases WHERE id=?").get(lease.id)?.released_at).toBeNull();
      originalRequest.end(body.slice(5)); heldPhase("request.remainder-ended"); expect(await response).toBe(202); heldPhase("response.complete");
      await close; heldPhase("close.complete"); expect(f.native.isOpen).toBe(false); expect(completed).toBe(true);
      expect(actualReleases).toBe(1); expect(observedRelease).toEqual(expect.any(String)); heldPhase("assertions.finished");
    } finally {
      heldPhase("finally.started");
      f.native.exec = execute; f.native.prepare = prepare;
      if (originalRequest && !originalRequest.writableEnded) { originalRequest.end(body.slice(5)); heldPhase("finally.remainder-ended"); }
      if (response) { await response; heldPhase("finally.response-settled"); } if (close) { await close; heldPhase("finally.close-settled"); }
      heldPhase("finally.finished");
    }
  }));
});
