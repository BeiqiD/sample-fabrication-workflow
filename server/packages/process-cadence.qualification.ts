import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect } from "vitest";
import { verifyNodeDistribution } from "../../scripts/lib/node-distribution-v28-manifest.mjs";
import { checkedResearchJobStatus, checkedResearchRequestReceipt, type ResearchJobStatus } from "../../shared/contracts/research-package-api";
import { validateResearchPackage } from "../../shared/contracts/research-package";
import { sourceFromBlob, validateStoreArchive } from "../../shared/domain/research-archive";
import { assertNodeRuntimeConfiguration } from "../node-runtime-config";
import { closeCanonicalFileClient, consumeCanonicalFileClient, fetchCanonicalFileClient,
  withCanonicalFileDatabase, type CanonicalFileFixtureOwner } from "../collaboration/current-v28-canonical-comment-file.qualification-support";
import { actor, fixture, it } from "../files/jobs/local-runtime.qualification-support";
import { NODE_LOCAL_FILE_JOB_CADENCE_MS } from "../files/jobs/local-runtime";

// This separate finite native stage observes the original elapsed cadence.
// No manual dispatcher, fake clock, alternate server entry or cadence override
// participates. The existing all15 synchronous qualification remains intact.
const PASSWORD = "actual local File Execution policy offline operator password";
const prefix = "/api/packages";
const payload = new TextEncoder().encode("Original independently scheduled one-File Sample observation 🧪");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MAX_SLOTS = 8;
const CASE_MS = MAX_SLOTS * NODE_LOCAL_FILE_JOB_CADENCE_MS + 40_000;
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Session = Readonly<{ cookie: string; csrf: string }>;
interface ClosedChild { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface MainOwner {
  child?: ChildProcess; constructionFailure?: unknown; originalClose?: Promise<ClosedChild>;
  ready?: Promise<void>; closing?: Promise<ClosedChild>; ended: boolean; stopSent: boolean;
  clients: CanonicalFileFixtureOwner; started: number;
}
const mainOwners = new Set<MainOwner>();
afterEach(() => {
  if (mainOwners.size) throw new AggregateError([...mainOwners].map(owner => owner.closing ?? owner.originalClose ?? owner.constructionFailure),
    "Original scheduled Package compiled-main ownership remains unproven");
});
function ensure(value: unknown): asserts value { if (!value) throw new Error("Original independent Package process qualification unavailable"); }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
function launch(distribution: string, configuration: string, rootUid: number): MainOwner {
  const owner: MainOwner = { ended: false, stopSent: false, clients: { clients: new Set(), quarantined: false }, started: performance.now() };
  mainOwners.add(owner);
  try {
    owner.child = spawn(process.execPath, [join(distribution, "server/main.mjs"), "--config", configuration,
      "--filesystem-root-owner-uid", String(rootUid)], { stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  } catch (error) { owner.constructionFailure = error; throw error; }
  const child = owner.child;
  let ready!: () => void, rejectReady!: (error: unknown) => void;
  owner.ready = new Promise<void>((yes, no) => { ready = yes; rejectReady = no; });
  void owner.ready.catch(() => undefined);
  owner.originalClose = new Promise<ClosedChild>((done, fail) => {
    let stdout = "", stderr = "", outputBytes = 0, outputFailure: Error | undefined, spawnError: unknown;
    child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
    const capture = (value: string, standardOutput: boolean) => {
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > 16 * 1024) { outputFailure ??= new Error("Independent Package process diagnostic budget exceeded"); rejectReady(outputFailure); return; }
      if (standardOutput) { stdout += value; if (stdout.includes("Restricted local development runtime started.\n")) ready(); }
      else stderr += value;
    };
    child.stdout!.on("data", (value: string) => capture(value, true));
    child.stderr!.on("data", (value: string) => capture(value, false));
    child.once("error", error => { spawnError = error; rejectReady(error); });
    // The original close event owns wait and pipe EOF. Sending SIGTERM or an
    // exit-looking flag is never a substitute for its first acknowledgement.
    child.once("close", (code, signal) => {
      owner.ended = true; rejectReady(new Error("Independent Package main closed before startup admission"));
      if (spawnError || outputFailure) fail(spawnError ?? outputFailure);
      else done({ code, signal, stdout, stderr });
    });
  });
  void owner.originalClose.catch(() => undefined); return owner;
}
function closeMain(owner: MainOwner): Promise<ClosedChild> {
  if (owner.closing) return owner.closing;
  owner.closing = (async () => {
    const clients = await Promise.allSettled([...owner.clients.clients].map(client => closeCanonicalFileClient(owner.clients, client)));
    const failures = clients.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    if (failures.length) throw new AggregateError(failures, "Original independent Package client body cleanup failed");
    ensure(owner.child && owner.originalClose);
    let stopFailed = false, stopFailure: unknown;
    if (!owner.ended) {
      try { owner.stopSent = true; ensure(owner.child.kill("SIGTERM")); }
      catch (error) { stopFailed = true; stopFailure = error; }
    }
    const result = await owner.originalClose;
    if (stopFailed) throw stopFailure;
    ensure(owner.stopSent); expect(result.code).toBe(0); expect(result.signal).toBeNull(); expect(result.stderr).toBe("");
    mainOwners.delete(owner); return result;
  })();
  void owner.closing.catch(() => undefined); return owner.closing;
}
async function request(owner: MainOwner, origin: string, path: string, method = "GET", input?: unknown,
  session?: Session, extra: Record<string, string> = {}) {
  const delivery = await fetchCanonicalFileClient(owner.clients, origin + path, { method,
    headers: { ...(session ? { cookie: session.cookie } : {}), ...(method === "GET" ? {} : {
      origin, "content-type": "application/json", ...(session ? { "x-sfw-csrf": session.csrf } : {}),
    }), connection: "close", ...extra },
    ...(input === undefined ? {} : { body: input instanceof Uint8Array ? input.slice().buffer as ArrayBuffer : JSON.stringify(input) }),
    signal: AbortSignal.timeout(5000), redirect: "manual" });
  const zipped = delivery.response.headers.get("content-type")?.split(";", 1)[0] === "application/zip";
  const consumed = await consumeCanonicalFileClient(delivery.client, zipped ? "arrayBuffer" : "text");
  ensure(zipped ? consumed instanceof ArrayBuffer : typeof consumed === "string");
  const value: unknown = zipped ? new Uint8Array(consumed as ArrayBuffer) : consumed ? JSON.parse(consumed as string) : null;
  await closeCanonicalFileClient(owner.clients, delivery.client);
  return { status: delivery.response.status, headers: delivery.response.headers, value };
}
async function login(owner: MainOwner, origin: string): Promise<Session> {
  const answer = await request(owner, origin, "/api/auth/login", "POST", { username: "execution.operator", password: PASSWORD });
  expect(answer.status).toBe(200);
  const cookie = answer.headers.get("set-cookie")?.split(";", 1)[0], csrf = object(answer.value).csrf;
  ensure(typeof cookie === "string" && cookie.startsWith("sfw_dev_session=") && typeof csrf === "string"); return { cookie, csrf };
}
async function status(owner: MainOwner, f: Fixture, id: string, session: Session): Promise<ResearchJobStatus> {
  const answer = await request(owner, f.origin, `${prefix}/jobs/${id}`, "GET", undefined, session);
  expect(answer.status).toBe(200); return checkedResearchJobStatus(answer.value);
}
async function waitFor(owner: MainOwner, f: Fixture, id: string, expected: "completed" | "cancelled", session: Session,
  deadline: number): Promise<ResearchJobStatus> {
  while (performance.now() < deadline) {
    ensure(!owner.ended);
    const current = await status(owner, f, id, session);
    expect(current.state).not.toBe("paused");
    if (current.state === expected) return current;
    await delay(Math.min(2000, Math.max(1, deadline - performance.now())));
  }
  throw new Error("Original automatic Package process exceeded its fixed eight-slot qualification budget");
}

describe("independent compiled Node Package process at the original elapsed cadence", () => {
  it("persists a one-File queued export across graceful process restart, runs only automatic120s slots and releases cancelled source holds after execution", async () => {
    expect(NODE_LOCAL_FILE_JOB_CADENCE_MS).toBe(120_000);
    const distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? "";
    ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution);
    const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
    expect(manifest.installationCheckpoint).toEqual({ id: "portable-runtime/v26", migrationCount: 24 });
    const f = await fixture({ administrator: true, enableLocalJobs: true });
    const config = assertNodeRuntimeConfiguration(f.configuration), rootUid = config.filesystemRootOwnerUid;
    const configPath = join(f.root, "runtime.json"), configurationStat = await lstat(configPath);
    ensure(configurationStat.isFile() && !configurationStat.isSymbolicLink() && configurationStat.nlink === 1);
    let current: MainOwner | undefined, exportId = "", cancelledId = "", fileId = "", assetId = "";
    const records: Array<{ event: string; elapsedMs?: number; pid?: number; code?: number | null; signal?: NodeJS.Signals | null }> = [];
    try {
      // The original fixture's native and writer parents close before a child
      // acquires that installation. Its seeded business fixture stays unselected;
      // this package contains only the following HTTP-created Sample/File.
      await f.stopAndDrainApplication(); expect(f.native.isOpen).toBe(false);
      current = launch(distribution, configPath, rootUid); await current.ready;
      const first = current, firstSession = await login(first, f.origin);
      ensure(first.child?.pid && first.child.pid !== process.pid);
      const uploaded = await request(first, f.origin, "/api/assets", "POST", payload, firstSession,
        { "content-type": "image/png", "x-filename": "independent-package.png", "x-upload-request-id": randomUUID() });
      expect(uploaded.status).toBe(201); ensure(typeof object(uploaded.value).id === "string"); assetId = String(object(uploaded.value).id);
      const createdSample = await request(first, f.origin, "/api/samples", "POST", { code: `NODE-CADENCE-${randomUUID()}`, title: "Independent automatic Package source" }, firstSession);
      expect(createdSample.status).toBe(201); ensure(typeof object(createdSample.value).id === "string"); const sampleId = String(object(createdSample.value).id);
      const sample = await request(first, f.origin, `/api/samples/${sampleId}`, "GET", undefined, firstSession);
      expect(sample.status).toBe(200); const source = object(sample.value);
      const observation = await request(first, f.origin, `/api/samples/${sampleId}/records`, "POST", {
        status: source.status, location: source.location ?? "", pinned: Boolean(source.pinned), expectedUpdatedAt: source.updatedAt,
        body: "One original File for elapsed Package qualification", assetId,
      }, firstSession);
      expect(observation.status).toBe(201);
      expect((await request(first, f.origin, "/api/files/migrations/executor", "POST", { enabled: true }, firstSession)).status).toBe(200);
      const selection = { kind: "data_package", roots: [{ kind: "sample", id: sampleId }] };
      const input = { ...selection, requestId: randomUUID() };
      const accepted = await request(first, f.origin, prefix + "/jobs", "POST", input, firstSession);
      expect(accepted.status).toBe(202); exportId = checkedResearchRequestReceipt(accepted.value).job.id;
      const cancelled = await request(first, f.origin, prefix + "/jobs", "POST", { ...selection, requestId: randomUUID() }, firstSession);
      expect(cancelled.status).toBe(202); cancelledId = checkedResearchRequestReceipt(cancelled.value).job.id;
      expect((await request(first, f.origin, `${prefix}/jobs/${cancelledId}/control`, "POST", { action: "cancel" }, firstSession)).status).toBe(200);
      expect((await request(first, f.origin, "/api/files/migrations/executor", "POST", { enabled: false }, firstSession)).status).toBe(200);
      expect((await status(first, f, cancelledId, firstSession)).state).toBe("cancel_requested");
      expect((await status(first, f, exportId, firstSession))).toMatchObject({ state: "paused", reason: "executor_reconfigured" });
      expect((await request(first, f.origin, "/api/files/migrations/executor", "POST", { enabled: true }, firstSession)).status).toBe(200);
      expect((await request(first, f.origin, `${prefix}/jobs/${exportId}/control`, "POST", { action: "resume" }, firstSession)).status).toBe(200);
      expect((await status(first, f, exportId, firstSession))).toMatchObject({ state: "queued", phase: "snapshot" });
      ensure(performance.now() - first.started < NODE_LOCAL_FILE_JOB_CADENCE_MS);
      const firstClose = closeMain(first); expect(closeMain(first)).toBe(firstClose);
      const stoppedFirst = await firstClose; records.push({ event: "first_original_close", pid: first.child.pid, code: stoppedFirst.code, signal: stoppedFirst.signal });
      await writeFile(join(f.root, "first-original-main.stdout.log"), stoppedFirst.stdout, { flag: "wx", mode: 0o600 });
      await writeFile(join(f.root, "first-original-main.stderr.log"), stoppedFirst.stderr, { flag: "wx", mode: 0o600 });
      current = undefined;
      const persisted = await withCanonicalFileDatabase(f.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE kind='scheduled'").get()?.n).toBe(0);
        const upload = native.prepare("SELECT file_id,sha256,byte_size FROM assets WHERE id=?").get(assetId)!;
        expect(upload).toMatchObject({ sha256: digest(payload), byte_size: payload.byteLength }); ensure(typeof upload.file_id === "string"); fileId = upload.file_id;
        const jobs = native.prepare("SELECT * FROM research_package_jobs WHERE id IN(?,?) ORDER BY id").all(exportId, cancelledId);
        expect(jobs).toHaveLength(2); expect(jobs.find(job => job.id === exportId)).toMatchObject({ state: "queued", phase: "snapshot", actor });
        expect(jobs.find(job => job.id === cancelledId)).toMatchObject({ state: "cancel_requested", actor });
        const files = native.prepare("SELECT * FROM research_package_files WHERE job_id IN(?,?) ORDER BY job_id,logical_file_id").all(exportId, cancelledId);
        expect(files.filter(file => file.job_id === exportId && file.entry_kind === "source")).toHaveLength(1);
        expect(files.filter(file => file.job_id === cancelledId && file.entry_kind === "source")).toHaveLength(1);
        const holds = native.prepare(`SELECT h.* FROM file_location_holds h JOIN research_package_files f ON f.hold_operation_id=h.operation_id
          WHERE f.job_id IN(?,?) AND f.entry_kind='source' ORDER BY h.id`).all(exportId, cancelledId);
        expect(holds).toHaveLength(2); expect(holds.every(hold => hold.released_at === null)).toBe(true);
        expect(native.prepare("SELECT count(*) n FROM research_package_attempts").get()?.n).toBe(0);
        return { jobs, files, holds };
      }));
      current = launch(distribution, configPath, rootUid); await current.ready;
      const second = current, secondSession = await login(second, f.origin), deadline = second.started + MAX_SLOTS * NODE_LOCAL_FILE_JOB_CADENCE_MS + 10_000;
      ensure(second.child?.pid && second.child.pid !== process.pid && second.child.pid !== first.child.pid);
      const replay = await request(second, f.origin, prefix + "/jobs", "POST", input, secondSession);
      expect(replay.status).toBe(202); expect(checkedResearchRequestReceipt(replay.value).job.id).toBe(exportId);
      const queued = await status(second, f, exportId, secondSession); expect(queued).toMatchObject({ state: "queued", phase: "snapshot" });
      // Repeated ordinary GETs are incapable of claiming work. The true first
      // timer cannot fire before120s from the earlier child launch reservation.
      while (performance.now() - second.started < NODE_LOCAL_FILE_JOB_CADENCE_MS - 2000) {
        expect(await status(second, f, exportId, secondSession)).toEqual(queued);
        expect((await status(second, f, cancelledId, secondSession)).state).toBe("cancel_requested");
        await delay(2000);
      }
      records.push({ event: "status_only_before_first_slot", elapsedMs: Math.trunc(performance.now() - second.started) });
      await waitFor(second, f, cancelledId, "cancelled", secondSession, deadline);
      const completed = await waitFor(second, f, exportId, "completed", secondSession, deadline);
      expect(completed.output?.available).toBe(true); expect(completed.result?.roots).toEqual(selection.roots);
      expect(performance.now() - second.started).toBeGreaterThanOrEqual(3 * NODE_LOCAL_FILE_JOB_CADENCE_MS);
      records.push({ event: "automatic_cancel_and_export_completed", elapsedMs: Math.trunc(performance.now() - second.started) });
      const downloaded = await request(second, f.origin, `${prefix}/jobs/${exportId}/download`, "GET", undefined, secondSession);
      expect(downloaded.status).toBe(200); ensure(downloaded.value instanceof Uint8Array && completed.output);
      const bytes = downloaded.value; expect(bytes.byteLength).toBe(completed.output.byteSize); expect(digest(bytes)).toBe(completed.output.sha256);
      const validated = await validateStoreArchive(sourceFromBlob(new Blob([bytes.slice().buffer as ArrayBuffer])), { expectedSha256: completed.output.sha256 });
      const pkg = await validateResearchPackage(JSON.parse(new TextDecoder().decode(validated.metadata.get("manifest.json")!)),
        JSON.parse(new TextDecoder().decode(validated.metadata.get("records.json")!)));
      expect(pkg.files).toHaveLength(1); expect(pkg.files[0]).toMatchObject({ byteSize: payload.byteLength, sha256: digest(payload), purpose: "embedded_content" });
      const entry = validated.entries.find(value => value.path === pkg.files[0].path)!; ensure(entry);
      const actual = bytes.slice(entry.dataOffset, entry.dataOffset + entry.byteSize); expect(actual).toEqual(payload); expect(digest(actual)).toBe(digest(payload));
      expect(validated.entries.map(value => value.path).sort()).toEqual(["manifest.json", "records.json", "report/index.html", "report/report.md", pkg.files[0].path].sort());
      const secondClose = closeMain(second); expect(closeMain(second)).toBe(secondClose);
      const stoppedSecond = await secondClose; records.push({ event: "second_original_close", pid: second.child.pid, code: stoppedSecond.code, signal: stoppedSecond.signal }); current = undefined;
      await writeFile(join(f.root, "second-original-main.stdout.log"), stoppedSecond.stdout, { flag: "wx", mode: 0o600 });
      await writeFile(join(f.root, "second-original-main.stderr.log"), stoppedSecond.stderr, { flag: "wx", mode: 0o600 });
      await withCanonicalFileDatabase(f.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
        const sources = native.prepare("SELECT owner,kind,created_at,released_at FROM system_recovery_write_leases WHERE kind='scheduled' ORDER BY created_at,id").all();
        expect(sources.length).toBeGreaterThanOrEqual(3); expect(sources.length).toBeLessThanOrEqual(MAX_SLOTS);
        for (const [index, source] of sources.entries()) {
          expect(source.owner).toMatch(/^node-file-job:/); expect(typeof source.released_at).toBe("string");
          if (index) expect(Date.parse(String(source.created_at)) - Date.parse(String(sources[index - 1].created_at))).toBeGreaterThanOrEqual(NODE_LOCAL_FILE_JOB_CADENCE_MS);
        }
        expect(native.prepare("SELECT state FROM research_package_jobs WHERE id=?").get(exportId)?.state).toBe("completed");
        expect(native.prepare("SELECT state FROM research_package_jobs WHERE id=?").get(cancelledId)?.state).toBe("cancelled");
        expect(native.prepare("SELECT count(*) n FROM research_package_attempts WHERE job_id=?").get(cancelledId)?.n).toBe(0);
        const cancelledHold = persisted.files.find(file => file.job_id === cancelledId && file.entry_kind === "source")!;
        expect(typeof native.prepare("SELECT released_at FROM file_location_holds WHERE operation_id=?").get(cancelledHold.hold_operation_id)?.released_at).toBe("string");
        expect(native.prepare("SELECT file_id FROM file_usable_publications WHERE file_id=?").get(fileId)?.file_id).toBe(fileId);
        expect(native.prepare("SELECT count(*) n FROM file_holds WHERE operation_id=? AND released_at IS NULL").get(`fp4-output:${exportId}`)?.n).toBe(1);
        expect(native.prepare("SELECT count(*) n FROM research_package_requests WHERE job_id=?").get(exportId)?.n).toBe(1);
      }));
      await writeFile(join(f.root, "independent-package-process-receipt.json"), JSON.stringify({ schema: "genuine-compiled-node-package-original-cadence/1",
        distributionManifestSha256: manifest.manifestSha256, productionCadenceMs: NODE_LOCAL_FILE_JOB_CADENCE_MS, maximumSlots: MAX_SLOTS,
        ordinaryPayloadBytes: payload.byteLength, ordinaryPayloadSha256: digest(payload), events: records,
        allSelectedBusinessRowsCreatedThroughHttp: true, originalFirstClosesAcknowledged: true, writerReacquiredAfterEachOriginalChildClose: true,
        noManualDispatch: true, noFakeClock: true, noCadenceOverride: true, unknownWriteFaultsQualified: false,
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } finally {
      if (current) await closeMain(current);
      await f.close();
    }
  }, CASE_MS);
});
