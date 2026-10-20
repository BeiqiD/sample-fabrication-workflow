import type { DatabaseSync } from "node:sqlite";
import { checkedResearchPackagePreview } from "../../shared/contracts/research-package-api";
import { RESEARCH_PACKAGE_CATALOG } from "../../shared/contracts/research-package-catalog";
import type { ResearchPackageV1 } from "../../shared/contracts/research-package";
import type { FrozenImportDomainPlan } from "../../worker/packages/import-domain-types";

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
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

// This new case owns the F3 verified-copy boundary. The original303 process
// qualification and its child/client first-close implementation stay unchanged.
type Row = Record<string, unknown>;
type Binding = string | number | null;
function binding(value: unknown): Binding {
  ensure(value === null || typeof value === "string" || typeof value === "number"); return value;
}
function consistent(native: DatabaseSync) {
  expect(native.prepare("PRAGMA integrity_check").all().map(row => Object.values(row)[0])).toEqual(["ok"]);
  expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(native.prepare("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
  expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
}
function slots(native: DatabaseSync, minimum: number, maximum: number) {
  const rows = native.prepare("SELECT owner,kind,created_at,released_at FROM system_recovery_write_leases WHERE kind='scheduled' ORDER BY created_at,id").all();
  expect(rows.length).toBeGreaterThanOrEqual(minimum); expect(rows.length).toBeLessThanOrEqual(maximum);
  for (const [index, row] of rows.entries()) {
    expect(row.owner).toMatch(/^node-file-job:/); expect(typeof row.released_at).toBe("string");
    if (index) expect(Date.parse(String(row.created_at)) - Date.parse(String(rows[index - 1].created_at))).toBeGreaterThanOrEqual(NODE_LOCAL_FILE_JOB_CADENCE_MS);
  }
  return rows;
}
function domainRows(native: DatabaseSync, frozen: FrozenImportDomainPlan, published: boolean) {
  for (const row of frozen.rows) {
    const definition = RESEARCH_PACKAGE_CATALOG[row.kind];
    expect(row.table).toBe(definition.table);
    const found = native.prepare(`SELECT * FROM ${definition.table} WHERE ${definition.id.map(field => `${field}=?`).join(" AND ")}`)
      .all(...definition.id.map(field => binding(row.data[field])));
    if (published) { expect(found, `${row.kind}:${row.sourceId}`).toHaveLength(1); expect(found[0]).toMatchObject(row.data); }
    else expect(found, `${row.kind}:${row.sourceId}`).toEqual([]);
  }
}
async function queuedBeforeFirstSlot(owner: MainOwner, f: Fixture, id: string, session: Session) {
  ensure(performance.now() - owner.started < NODE_LOCAL_FILE_JOB_CADENCE_MS - 2000);
  const queued = await status(owner, f, id, session); expect(queued.state).toBe("queued");
  while (performance.now() - owner.started < NODE_LOCAL_FILE_JOB_CADENCE_MS - 2000) {
    expect(await status(owner, f, id, session)).toEqual(queued); await delay(2000);
  }
  return queued;
}
async function waitPreview(owner: MainOwner, f: Fixture, id: string, session: Session, deadline: number) {
  while (performance.now() < deadline) {
    ensure(!owner.ended); const current = await status(owner, f, id, session);
    expect(["queued", "running", "preview"]).toContain(current.state);
    if (current.state === "preview") return current;
    await delay(Math.min(2000, Math.max(1, deadline - performance.now())));
  }
  throw new Error("Original automatic upload validation exceeded its fixed first-slot window");
}
async function waitVerifiedCopy(owner: MainOwner, f: Fixture, id: string, session: Session, deadline: number) {
  while (performance.now() < deadline) {
    ensure(!owner.ended); const current = await status(owner, f, id, session);
    // A completed graph is a missed boundary, never an acceptable substitute.
    expect(["queued", "running"]).toContain(current.state); expect(current.phase).toBe("copy"); expect(current.result).toBeNull();
    if (current.state === "queued" && current.progress.completedFiles === 1) {
      expect(current.progress).toMatchObject({ completedFiles: 1, totalFiles: 1, bytesDone: payload.byteLength, bytesTotal: payload.byteLength });
      return current;
    }
    await delay(Math.min(2000, Math.max(1, deadline - performance.now())));
  }
  throw new Error("Original automatic import did not expose verified copy before its next graph slot");
}
async function archive(owner: MainOwner, f: Fixture, id: string, session: Session, completed: ResearchJobStatus) {
  const answer = await request(owner, f.origin, `${prefix}/jobs/${id}/download`, "GET", undefined, session);
  expect(answer.status).toBe(200); ensure(answer.value instanceof Uint8Array && completed.output?.available);
  const bytes = answer.value;
  expect(bytes.byteLength).toBe(completed.output.byteSize); expect(digest(bytes)).toBe(completed.output.sha256);
  const checked = await validateStoreArchive(sourceFromBlob(new Blob([bytes.slice().buffer as ArrayBuffer])), { expectedSha256: completed.output.sha256 });
  const pkg = await validateResearchPackage(JSON.parse(new TextDecoder().decode(checked.metadata.get("manifest.json")!)),
    JSON.parse(new TextDecoder().decode(checked.metadata.get("records.json")!)));
  expect(pkg.files).toHaveLength(1); expect(pkg.roots).toHaveLength(1);
  expect(pkg.files[0]).toMatchObject({ purpose: "embedded_content", byteSize: payload.byteLength, sha256: digest(payload) });
  const entry = checked.entries.find(value => value.path === pkg.files[0].path); ensure(entry);
  expect(bytes.slice(entry.dataOffset, entry.dataOffset + entry.byteSize)).toEqual(payload);
  expect(checked.entries.map(value => value.path).sort()).toEqual(["manifest.json", "records.json", "report/index.html", "report/report.md", pkg.files[0].path].sort());
  return { bytes, pkg };
}
async function acknowledge(owner: MainOwner, f: Fixture, name: string) {
  const original = closeMain(owner); expect(closeMain(owner)).toBe(original);
  const closed = await original;
  await writeFile(join(f.root, `${name}.stdout.log`), closed.stdout, { flag: "wx", mode: 0o600 });
  await writeFile(join(f.root, `${name}.stderr.log`), closed.stderr, { flag: "wx", mode: 0o600 });
  return { name, pid: owner.child!.pid!, code: closed.code, signal: closed.signal,
    elapsedMs: Math.trunc(performance.now() - owner.started), originalCloseAcknowledged: true };
}
function copiedFile(native: DatabaseSync, jobId: string, expected: ResearchPackageV1) {
  const files = native.prepare("SELECT * FROM research_package_files WHERE job_id=? AND entry_kind='payload' ORDER BY logical_file_id").all(jobId);
  const attempts = native.prepare("SELECT * FROM research_package_attempts WHERE job_id=? ORDER BY id").all(jobId);
  expect(files).toHaveLength(1); expect(attempts).toHaveLength(1);
  const file = files[0], attempt = attempts[0];
  expect(file).toMatchObject({ logical_file_id: expected.files[0].packageFileId, purpose: "embedded_content", byte_size: payload.byteLength,
    sha256: digest(payload), reuse_file_id: null, reuse_location_id: null, reuse_asset_id: null });
  ensure(typeof file.result_file_id === "string" && typeof file.result_location_id === "string" && typeof file.candidate_asset_id === "string");
  expect(file.candidate_file_id).toBe(file.result_file_id);
  expect(attempt).toMatchObject({ logical_file_id: file.logical_file_id, file_id: file.result_file_id, location_id: file.result_location_id,
    state: "published", verified_sha256: digest(payload), verified_byte_size: payload.byteLength });
  ensure(typeof attempt.io_settled_at === "string" && typeof attempt.verified_at === "string" && typeof attempt.object_key === "string");
  expect(native.prepare("SELECT * FROM file_location_publications WHERE location_id=?").all(file.result_location_id)).toHaveLength(1);
  const location = native.prepare("SELECT * FROM file_location_publications WHERE location_id=?").get(file.result_location_id)!;
  expect(location).toMatchObject({ file_id: file.result_file_id, storage_profile_id: file.target_profile_id, object_key: attempt.object_key,
    verified_byte_size: payload.byteLength, verified_sha256: digest(payload), verification_method: "full_read_sha256", verification_operation_id: attempt.id });
  const publication = native.prepare("SELECT * FROM file_usable_publications WHERE file_id=?").get(file.result_file_id)!;
  expect(publication).toMatchObject({ file_id: file.result_file_id, active_location_id: file.result_location_id, purpose: "embedded_content",
    state: "ready", verified_byte_size: payload.byteLength, verified_sha256: digest(payload) });
  return { file, attempt, location, publication };
}

describe("verified one-File import survives original compiled-main close before graph publication", () => {
  it("stops after automatic verified copy, restarts on the original120s cadence and publishes the same File and typed graph exactly once", async () => {
    expect(NODE_LOCAL_FILE_JOB_CADENCE_MS).toBe(120_000);
    const distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? "";
    ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution);
    const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
    expect(manifest.installationCheckpoint).toEqual({ id: "portable-runtime/v26", migrationCount: 24,
      catalogSourceSha256: digest(await readFile(new URL("../installation-catalog-v26.ts", import.meta.url))),
      operationalSelectorSha256: digest(await readFile(new URL("../operational-installation-catalog.ts", import.meta.url))),
      lastMigrationSourceSha256: digest(await readFile(new URL("../../migrations/0024_rt3_local_volume_profiles.sql", import.meta.url))),
    });
    const caseStarted = performance.now(), caseDeadline = caseStarted + CASE_MS - 20_000;
    const fixtures: Fixture[] = [], children: Array<Awaited<ReturnType<typeof acknowledge>>> = [];
    let current: MainOwner | undefined, failed = false, failure: unknown;
    let result: Row | undefined;
    try {
      const producer = await fixture({ administrator: true, enableLocalJobs: true, seedBusinessRows: false }); fixtures.push(producer);
      const producerConfig = assertNodeRuntimeConfiguration(producer.configuration), producerPath = join(producer.root, "runtime.json");
      const producerStat = await lstat(producerPath); ensure(producerStat.isFile() && !producerStat.isSymbolicLink() && producerStat.nlink === 1);
      await producer.stopAndDrainApplication(); expect(producer.native.isOpen).toBe(false);
      current = launch(distribution, producerPath, producerConfig.filesystemRootOwnerUid); await current.ready;
      const sourceMain = current, sourceSession = await login(sourceMain, producer.origin); ensure(sourceMain.child?.pid && sourceMain.child.pid !== process.pid);
      const uploaded = await request(sourceMain, producer.origin, "/api/assets", "POST", payload, sourceSession,
        { "content-type": "image/png", "x-filename": "verified-copy-restart.png", "x-upload-request-id": randomUUID() });
      expect(uploaded.status).toBe(201); ensure(typeof object(uploaded.value).id === "string"); const assetId = String(object(uploaded.value).id);
      const sample = await request(sourceMain, producer.origin, "/api/samples", "POST", { code: `F3-RESTART-${randomUUID()}`, title: "Original verified-copy restart source" }, sourceSession);
      expect(sample.status).toBe(201); ensure(typeof object(sample.value).id === "string"); const sampleId = String(object(sample.value).id);
      const readSample = await request(sourceMain, producer.origin, `/api/samples/${sampleId}`, "GET", undefined, sourceSession); expect(readSample.status).toBe(200);
      const source = object(readSample.value);
      expect((await request(sourceMain, producer.origin, `/api/samples/${sampleId}/records`, "POST", { status: source.status,
        location: source.location ?? "", pinned: Boolean(source.pinned), expectedUpdatedAt: source.updatedAt,
        body: "Verified before graph publication; literal provenance stays unchanged", assetId }, sourceSession)).status).toBe(201);
      expect((await request(sourceMain, producer.origin, "/api/files/migrations/executor", "POST", { enabled: true }, sourceSession)).status).toBe(200);
      const selection = { kind: "data_package", roots: [{ kind: "sample", id: sampleId }] }, exportInput = { ...selection, requestId: randomUUID() };
      const acceptedExport = await request(sourceMain, producer.origin, `${prefix}/jobs`, "POST", exportInput, sourceSession); expect(acceptedExport.status).toBe(202);
      const exportId = checkedResearchRequestReceipt(acceptedExport.value).job.id;
      await queuedBeforeFirstSlot(sourceMain, producer, exportId, sourceSession);
      const exported = await waitFor(sourceMain, producer, exportId, "completed", sourceSession, Math.min(caseDeadline, sourceMain.started + 3 * NODE_LOCAL_FILE_JOB_CADENCE_MS - 10_000));
      expect(performance.now() - sourceMain.started).toBeGreaterThanOrEqual(2 * NODE_LOCAL_FILE_JOB_CADENCE_MS); expect(exported.result?.roots).toEqual(selection.roots);
      const original = await archive(sourceMain, producer, exportId, sourceSession, exported);
      children.push(await acknowledge(sourceMain, producer, "producer-original-main")); current = undefined;
      const sourceProof = await withCanonicalFileDatabase(producer.path, async (_owner, lease, native) => lease.withWriter(async () => {
        consistent(native); const scheduled = slots(native, 2, 2);
        const captures = native.prepare("SELECT * FROM research_package_files WHERE job_id=? AND entry_kind='source' ORDER BY logical_file_id").all(exportId);
        expect(captures).toHaveLength(1); expect(captures[0]).toMatchObject({ source_alias_id: `asset:${assetId}`, sha256: digest(payload), byte_size: payload.byteLength });
        expect(native.prepare("SELECT file_id FROM assets WHERE id=?").get(assetId)?.file_id).toBe(captures[0].source_file_id);
        expect(native.prepare("SELECT count(*) n FROM samples").get()?.n).toBe(1);
        return { scheduled, captures };
      }));
      const consumer = await fixture({ administrator: true, enableLocalJobs: true, seedBusinessRows: false }); fixtures.push(consumer);
      expect(consumer.path).not.toBe(producer.path);
      const consumerConfig = assertNodeRuntimeConfiguration(consumer.configuration), consumerPath = join(consumer.root, "runtime.json");
      const configStat = await lstat(consumerPath), configSha256 = digest(await readFile(consumerPath));
      ensure(configStat.isFile() && !configStat.isSymbolicLink() && configStat.nlink === 1);
      await consumer.stopAndDrainApplication(); expect(consumer.native.isOpen).toBe(false);
      current = launch(distribution, consumerPath, consumerConfig.filesystemRootOwnerUid); await current.ready;
      const copyingMain = current, receiverSession = await login(copyingMain, consumer.origin);
      ensure(copyingMain.child?.pid && copyingMain.child.pid !== sourceMain.child.pid && copyingMain.child.pid !== process.pid);
      expect((await request(copyingMain, consumer.origin, "/api/files/migrations/executor", "POST", { enabled: true }, receiverSession)).status).toBe(200);
      const acceptedUpload = await request(copyingMain, consumer.origin, `${prefix}/uploads`, "POST",
        { requestId: randomUUID(), byteSize: original.bytes.byteLength, sha256: digest(original.bytes) }, receiverSession); expect(acceptedUpload.status).toBe(202);
      const uploadReceipt = checkedResearchRequestReceipt(acceptedUpload.value); expect(uploadReceipt.job.state).toBe("awaiting_upload");
      const uploadId = uploadReceipt.job.id;
      expect((await request(copyingMain, consumer.origin, `${prefix}/jobs/${uploadId}/upload`, "PUT", original.bytes, receiverSession,
        { "content-type": "application/zip", "content-length": String(original.bytes.byteLength) })).status).toBe(200);
      await queuedBeforeFirstSlot(copyingMain, consumer, uploadId, receiverSession);
      await waitPreview(copyingMain, consumer, uploadId, receiverSession, Math.min(caseDeadline, copyingMain.started + 2 * NODE_LOCAL_FILE_JOB_CADENCE_MS - 10_000));
      const previewAnswer = await request(copyingMain, consumer.origin, `${prefix}/jobs/${uploadId}/preview`, "GET", undefined, receiverSession); expect(previewAnswer.status).toBe(200);
      const preview = checkedResearchPackagePreview(previewAnswer.value);
      expect(preview).toMatchObject({ complete: true, counts: { files: 1 }, capabilities: { dataPackage: { available: true } },
        source: { installationId: original.pkg.sourceInstallationId, packageId: original.pkg.packageId, payloadSha256: digest(original.bytes) } });
      ensure(preview.rolePolicyRevision !== null);
      const importInput = { requestId: randomUUID(), uploadJobId: uploadId, anotherCopy: false, expectedRolePolicyRevision: preview.rolePolicyRevision };
      const acceptedImport = await request(copyingMain, consumer.origin, `${prefix}/imports`, "POST", importInput, receiverSession); expect(acceptedImport.status).toBe(202);
      const importReceipt = checkedResearchRequestReceipt(acceptedImport.value); expect(importReceipt.job).toMatchObject({ state: "queued", phase: "copy", result: null });
      const importId = importReceipt.job.id;
      const verified = await waitVerifiedCopy(copyingMain, consumer, importId, receiverSession, Math.min(caseDeadline, copyingMain.started + 3 * NODE_LOCAL_FILE_JOB_CADENCE_MS - 10_000));
      expect(performance.now() - copyingMain.started).toBeGreaterThanOrEqual(2 * NODE_LOCAL_FILE_JOB_CADENCE_MS);
      ensure(performance.now() - copyingMain.started < 3 * NODE_LOCAL_FILE_JOB_CADENCE_MS - 10_000);
      children.push(await acknowledge(copyingMain, consumer, "verified-copy-original-main")); current = undefined;
      const checkpoint = await withCanonicalFileDatabase(consumer.path, async (_owner, lease, native) => lease.withWriter(async () => {
        consistent(native); const scheduled = slots(native, 2, 2);
        const job = native.prepare("SELECT * FROM research_package_jobs WHERE id=?").get(importId)!;
        expect(job).toMatchObject({ actor, state: "queued", phase: "copy", owner_token: null, lease_expires_at: null, result_json: null,
          package_id: original.pkg.packageId, source_installation_id: original.pkg.sourceInstallationId, source_upload_job_id: uploadId });
        ensure(typeof job.domain_plan_json === "string"); const frozen = JSON.parse(job.domain_plan_json) as FrozenImportDomainPlan;
        expect(frozen.files).toHaveLength(1); expect(frozen.roots).toHaveLength(1);
        const copied = copiedFile(native, importId, original.pkg); expect(copied.file.state).toBe("verified");
        expect(native.prepare("SELECT count(*) n FROM file_usable_publications").get()?.n).toBe(2);
        expect(native.prepare("SELECT count(*) n FROM file_location_publications").get()?.n).toBe(2);
        expect(frozen.files[0]).toMatchObject({ packageFileId: copied.file.logical_file_id, destinationFileId: copied.file.result_file_id,
          assetId: copied.file.candidate_asset_id, profileId: copied.file.target_profile_id, sha256: digest(payload), byteSize: payload.byteLength });
        domainRows(native, frozen, false);
        for (const table of ["samples", "events", "assets"]) expect(native.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
        const identities = native.prepare("SELECT entity_kind,source_id,destination_id FROM research_package_identity_maps WHERE job_id=? ORDER BY entity_kind,source_id").all(importId);
        expect(identities.map(row => ({ kind: row.entity_kind, sourceId: row.source_id, destinationId: row.destination_id })))
          .toEqual(expect.arrayContaining(frozen.identities)); expect(identities).toHaveLength(frozen.identities.length);
        const records = native.prepare("SELECT record_json FROM research_package_records WHERE job_id=? ORDER BY ordinal").all(importId);
        expect(records.map(row => JSON.parse(String(row.record_json)))).toEqual(original.pkg.records);
        const sourceHold = native.prepare("SELECT * FROM file_location_holds WHERE operation_id=?").get(`fp4-source:${importId}`)!;
        const attemptHold = native.prepare("SELECT * FROM file_location_holds WHERE operation_id=?").get(binding(copied.attempt.id))!;
        expect(sourceHold).toMatchObject({ released_at: null }); expect(attemptHold).toMatchObject({ released_at: null, location_id: copied.file.result_location_id });
        expect(native.prepare("SELECT count(*) n FROM file_holds WHERE operation_id=? AND released_at IS NULL").get(`fp4-output:${uploadId}`)?.n).toBe(1);
        expect(native.prepare("SELECT count(*) n FROM research_package_requests WHERE job_id=?").get(importId)?.n).toBe(1);
        return { job, frozen, copied, identities, records, sourceHold, attemptHold, scheduled };
      }));
      expect(digest(await readFile(consumerPath))).toBe(configSha256); expect((await lstat(consumerPath)).ino).toBe(configStat.ino);
      current = launch(distribution, consumerPath, consumerConfig.filesystemRootOwnerUid); await current.ready;
      const resumedMain = current, resumedSession = await login(resumedMain, consumer.origin);
      ensure(resumedMain.child?.pid && resumedMain.child.pid !== copyingMain.child.pid && resumedMain.child.pid !== sourceMain.child.pid && resumedMain.child.pid !== process.pid);
      // Starting this genuine process preserves the existing enabled executor;
      // reconfiguration would pause the checkpoint and is deliberately absent.
      expect(await status(resumedMain, consumer, importId, resumedSession)).toEqual(verified);
      const replay = await request(resumedMain, consumer.origin, `${prefix}/imports`, "POST", importInput, resumedSession); expect(replay.status).toBe(202);
      expect(checkedResearchRequestReceipt(replay.value).job.id).toBe(importId);
      const stillVerified = await queuedBeforeFirstSlot(resumedMain, consumer, importId, resumedSession); expect(stillVerified).toEqual(verified);
      const completed = await waitFor(resumedMain, consumer, importId, "completed", resumedSession,
        Math.min(caseDeadline, resumedMain.started + 2 * NODE_LOCAL_FILE_JOB_CADENCE_MS - 10_000));
      expect(performance.now() - resumedMain.started).toBeGreaterThanOrEqual(NODE_LOCAL_FILE_JOB_CADENCE_MS);
      expect(completed.result).toEqual({ roots: checkpoint.frozen.roots, reused: false }); expect(completed.progress).toEqual(verified.progress);
      const completedReplay = await request(resumedMain, consumer.origin, `${prefix}/imports`, "POST", importInput, resumedSession); expect(completedReplay.status).toBe(202);
      expect(checkedResearchRequestReceipt(completedReplay.value).job.id).toBe(importId);
      const reexport = await request(resumedMain, consumer.origin, `${prefix}/jobs`, "POST",
        { kind: "data_package", roots: completed.result!.roots, requestId: randomUUID() }, resumedSession); expect(reexport.status).toBe(202);
      const reexportId = checkedResearchRequestReceipt(reexport.value).job.id;
      const reexported = await waitFor(resumedMain, consumer, reexportId, "completed", resumedSession,
        Math.min(caseDeadline, resumedMain.started + 4 * NODE_LOCAL_FILE_JOB_CADENCE_MS - 10_000));
      expect(performance.now() - resumedMain.started).toBeGreaterThanOrEqual(3 * NODE_LOCAL_FILE_JOB_CADENCE_MS);
      const afterRestart = await archive(resumedMain, consumer, reexportId, resumedSession, reexported);
      expect(afterRestart.pkg.roots).toEqual(checkpoint.frozen.roots);
      children.push(await acknowledge(resumedMain, consumer, "restarted-original-main")); current = undefined;
      const finalProof = await withCanonicalFileDatabase(consumer.path, async (_owner, lease, native) => lease.withWriter(async () => {
        consistent(native); const scheduled = slots(native, 5, 5);
        const job = native.prepare("SELECT * FROM research_package_jobs WHERE id=?").get(importId)!;
        expect(job).toMatchObject({ state: "completed", phase: "done", owner_token: null, lease_expires_at: null, domain_plan_json: checkpoint.job.domain_plan_json });
        expect(JSON.parse(String(job.result_json))).toEqual({ roots: checkpoint.frozen.roots, reused: false });
        const final = copiedFile(native, importId, original.pkg); expect(final.file.state).toBe("published");
        // Only the retained raw archive, original payload and new reexport
        // archive are usable; graph recovery never introduces another File.
        expect(native.prepare("SELECT count(*) n FROM file_usable_publications").get()?.n).toBe(3);
        expect(native.prepare("SELECT count(*) n FROM file_location_publications").get()?.n).toBe(3);
        for (const [field, value] of Object.entries(checkpoint.copied.file)) if (!["state", "updated_at"].includes(field)) expect(final.file[field], field).toEqual(value);
        expect(final.attempt).toEqual(checkpoint.copied.attempt); expect(final.location).toEqual(checkpoint.copied.location); expect(final.publication).toEqual(checkpoint.copied.publication);
        expect(native.prepare("SELECT count(*) n FROM files WHERE id=?").get(binding(final.file.result_file_id))?.n).toBe(1);
        expect(native.prepare("SELECT count(*) n FROM file_locations WHERE id=? AND file_id=?").get(binding(final.file.result_location_id), binding(final.file.result_file_id))?.n).toBe(1);
        expect(native.prepare("SELECT count(*) n FROM file_locations WHERE object_key=?").get(binding(final.attempt.object_key))?.n).toBe(1);
        expect(native.prepare("SELECT entity_kind,source_id,destination_id FROM research_package_identity_maps WHERE job_id=? ORDER BY entity_kind,source_id").all(importId)).toEqual(checkpoint.identities);
        expect(native.prepare("SELECT record_json FROM research_package_records WHERE job_id=? ORDER BY ordinal").all(importId)).toEqual(checkpoint.records);
        domainRows(native, checkpoint.frozen, true);
        const destination = (kind: string, sourceId: string) => {
          const identity = checkpoint.identities.find(row => row.entity_kind === kind && row.source_id === sourceId); ensure(identity);
          return String(identity.destination_id);
        };
        expect(completed.result!.roots).toEqual([{ kind: "sample", id: destination("sample", sampleId) }]);
        // Compare native event cells to the original public package directly,
        // independently of the formatter's own frozen-row expected objects.
        for (const event of original.pkg.records.filter(row => row.kind === "event")) {
          const copied = native.prepare("SELECT * FROM events WHERE id=?").get(destination("event", event.sourceId))!; ensure(copied);
          expect(copied).toMatchObject({ id: destination("event", event.sourceId), sample_id: destination("sample", String(event.data.sample_id)),
            kind: event.data.kind, body: event.data.body, actor_email: event.data.actor_email, created_at: event.data.created_at,
            asset_file_id: event.data.packageFileId === null ? null : final.file.result_file_id,
            thumbnail_file_id: null });
          expect(event.data.thumbnailPackageFileId).toBeNull();
          expect(event.data.packageFileId === null || event.data.packageFileId === original.pkg.files[0].packageFileId).toBe(true);
        }
        for (const [kind, table] of [["sample", "samples"], ["event", "events"]] as const)
          expect(native.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(checkpoint.frozen.rows.filter(row => row.kind === kind).length);
        const aliases = native.prepare("SELECT * FROM assets").all(); expect(aliases).toHaveLength(1);
        const alias = aliases[0], sourceAlias = original.pkg.records.find(row => row.kind === "fileAlias")!; ensure(sourceAlias);
        expect(alias).toMatchObject({ id: final.file.candidate_asset_id, file_id: final.file.result_file_id, object_key: final.attempt.object_key,
          sha256: digest(payload), byte_size: payload.byteLength, original_name: sourceAlias.data.original_name, mime_type: sourceAlias.data.mime_type,
          created_at: sourceAlias.data.created_at, status: "ready" });
        const sourceHold = native.prepare("SELECT * FROM file_location_holds WHERE operation_id=?").get(`fp4-source:${importId}`)!;
        const attemptHold = native.prepare("SELECT * FROM file_location_holds WHERE operation_id=?").get(binding(final.attempt.id))!;
        for (const [before, after] of [[checkpoint.sourceHold, sourceHold], [checkpoint.attemptHold, attemptHold]]) {
          expect(typeof after.released_at).toBe("string");
          for (const [field, value] of Object.entries(before)) if (field !== "released_at") expect(after[field], field).toEqual(value);
        }
        expect(native.prepare("SELECT count(*) n FROM research_package_requests WHERE job_id=?").get(importId)?.n).toBe(1);
        expect(native.prepare("SELECT count(*) n FROM research_package_jobs WHERE kind='import'").get()?.n).toBe(1);
        expect(native.prepare("SELECT count(*) n FROM file_holds WHERE operation_id=? AND released_at IS NULL").get(`fp4-output:${uploadId}`)?.n).toBe(1);
        const captures = native.prepare("SELECT * FROM research_package_files WHERE job_id=? AND entry_kind='source' ORDER BY logical_file_id").all(reexportId);
        expect(captures).toHaveLength(1); expect(captures[0]).toMatchObject({ source_file_id: final.file.result_file_id,
          source_location_id: final.file.result_location_id, source_alias_id: `asset:${String(final.file.candidate_asset_id)}`, sha256: digest(payload), byte_size: payload.byteLength });
        const wireAlias = afterRestart.pkg.records.find(row => row.kind === "fileAlias")!; ensure(wireAlias);
        expect(wireAlias.sourceId).toBe(`asset:${String(final.file.candidate_asset_id)}`); expect(wireAlias.data.packageFileId).toBe(captures[0].logical_file_id);
        expect(afterRestart.pkg.records.map(row => row.kind).sort()).toEqual(original.pkg.records.map(row => row.kind).sort());
        return { job, copied: final, aliases, sourceHold, attemptHold, scheduled, captures };
      }));
      const allSlots = sourceProof.scheduled.length + finalProof.scheduled.length; expect(allSlots).toBe(7); expect(allSlots).toBeLessThanOrEqual(MAX_SLOTS);
      result = { schema: "genuine-compiled-node-package-verified-copy-restart/1", distributionManifestSha256: manifest.manifestSha256,
        productionCadenceMs: NODE_LOCAL_FILE_JOB_CADENCE_MS, maximumSlots: MAX_SLOTS, caseMs: CASE_MS, outerStageSeconds: 1050,
        originalAutomaticSlots: allSlots, ordinaryPayloadBytes: payload.byteLength, ordinaryPayloadSha256: digest(payload),
        originalArchiveBytes: original.bytes.byteLength, originalArchiveSha256: digest(original.bytes), reexportArchiveSha256: digest(afterRestart.bytes),
        exportId, uploadId, importId, reexportId, configurationSha256: configSha256, originalChildren: children,
        verifiedBeforeClose: verified, checkpoint, finalProof, allSelectedBusinessRowsCreatedThroughHttp: true,
        noManualDispatch: true, noFakeClock: true, noCadenceOverride: true, noInjectionHook: true,
        sameRequestSameJob: true, originalAttemptFileLocationKeyUnchanged: true, originalGraphPublishedOnce: true,
        unknownWriteOrLostCommitAckQualified: false, deploymentPerformed: false };
    } catch (error) { failed = true; failure = error; }
    const cleanupFailures: unknown[] = [];
    if (current) try { await closeMain(current); } catch (error) { cleanupFailures.push(error); }
    const originalFixtures = await Promise.allSettled(fixtures.map(f => f.close()));
    for (const closed of originalFixtures) if (closed.status === "rejected") cleanupFailures.push(closed.reason as unknown);
    if (cleanupFailures.length) throw new AggregateError([...(failed ? [failure] : []), ...cleanupFailures], "Original verified-copy restart work or first-close acknowledgement failed");
    if (failed) throw failure; ensure(result && fixtures.length === 2 && mainOwners.size === 0);
    // A passing leaf is emitted only after all three original child close ACKs,
    // both original fixture close ACKs, and the final native observer ACK.
    result.originalFirstClosesAcknowledged = true; result.originalFixtureClosesAcknowledged = true;
    await writeFile(join(fixtures[1].root, "verified-copy-restart-process-receipt.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }, CASE_MS);
});
