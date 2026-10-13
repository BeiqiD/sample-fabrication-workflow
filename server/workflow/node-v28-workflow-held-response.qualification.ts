import { beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { verifyNodeDistribution } from "../../scripts/lib/node-distribution-v28-manifest.mjs";
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from "../../scripts/lib/system-backup-node-io.ts";
import { validateV28SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission.ts";
import { checkedSystemRecoveryCapabilities, checkedSystemRecoveryJobStatus, checkedSystemRecoveryReceipt,
  checkedSystemRecoveryMaintenanceStatus, checkedSystemRecoveryMaintenanceReceipt } from "../../shared/contracts/system-recovery.ts";
import { createPasswordHasher } from "../auth/passwords.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { admitInstallationRecoverySource } from "../migrations.ts";
import { NODE_V28_JOB_CADENCE_MS } from "../jobs/node-v28-job-scheduler.ts";
import { executeCollaborationV28OperatorCandidate } from "../operations/collaboration-v28-operator-candidate.ts";
import { acquireLinuxWriterLease, WriterLeaseError, writerLeaseProcessState } from "../operations/writer-lease.ts";
import { CANONICAL_FILE_PASSWORD, CANONICAL_FILE_IDENTITY_POLICY, assertCanonicalFileOwnersReleased,
  canonicalFilePrivateOrigin, listenCanonicalFileApplication, retainedCanonicalFileCase, withCanonicalFileDatabase,
  fetchCanonicalFileClient, consumeCanonicalFileClient, closeCanonicalFileClient } from "../collaboration/current-v28-canonical-comment-file.qualification-support.ts";
import { createNodeSystemRecoveryV28Application } from "../recovery/node-system-recovery-v28-application.ts";
import { prepareCurrentV28OnlineRecoverySource, assertCurrentV28OnlineRecoverySourceFenced,
  currentV28RecoveryTypedRows, CURRENT_V28_RECOVERY_PHYSICAL_TABLES,
  type CurrentV28OnlineRecoverySource } from "../recovery/current-v28-online-recovery.qualification-support.ts";
import { launchCurrentRecoveryCli, closeCurrentRecoveryCli, loginCurrentRecoveryCli, recoveryCliJson, recoveryCliBytes,
  type CurrentRecoveryCliOwner } from "../recovery/current-v28-recovery-cli.qualification-support.ts";
import { loginWorkflowCli, workflowCliJson, workflowCliBytes } from "./node-v28-workflow-cli.qualification-support.ts";
import { actualRecoveryArchiveData, launchHeldWorkflowCli, rejectedWorkflowHttpAfterStop,
  type HeldWorkflowCli } from "./node-v28-workflow-held-response.qualification-support.ts";

// Independent finite qualification, never an alternate production host. The
// body cases stop before the first real slot; the scheduled case waits for one
// actual120s slot. Neither shared60s nor any existing case budget changes.
const BODY_CASE_MS = 120_000, SCHEDULED_CASE_MS = 2 * NODE_V28_JOB_CADENCE_MS + 60_000;
let distribution: string, receiptPrefix: string, manifestSha256: string;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function ensure(value: unknown): asserts value { if (!value) throw new Error("Actual held Recovery response qualification is unavailable"); }
function object(value: unknown): Record<string, unknown> { ensure(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? "";
  receiptPrefix = process.env.CURRENT_V28_WORKFLOW_HELD_RESPONSE_RECEIPT ?? "";
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(receiptPrefix) && resolve(receiptPrefix) === receiptPrefix);
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true }); manifestSha256 = manifest.manifestSha256;
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe("portable-runtime/v28");
  expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe("v5"); expect(NODE_V28_JOB_CADENCE_MS).toBe(120_000);
  const inputs = object(JSON.parse(await readFile(join(distribution, "source-inputs.json"), "utf8"))).inputs; ensure(Array.isArray(inputs));
  for (const relative of ["server/main.ts", "server/http.ts", "server/node-runtime-profile.ts", "server/node-runtime-config.ts",
    "server/workflow/node-v28-workflow-runtime.ts", "server/workflow/node-v28-workflow-application.ts", "server/workflow/node-v28-file-job-child.ts",
    "server/jobs/node-v28-job-scheduler.ts", "server/jobs/node-v28-job-cursor.ts", "server/recovery/node-v28-source-barrier.ts",
    "server/recovery/node-system-recovery-v28-application.ts", "server/recovery/node-v28-archive-stages.ts",
    "server/recovery/node-private-artifacts.ts", "server/recovery/node-v28-original-source-resume.ts",
    "server/storage/local-byte-storage.ts", "server/operations/writer-lease.ts", "worker/recovery/kernel.ts",
    "server/packages/job-child-v28-candidate.ts", "server/packages/request-http-v28-candidate.ts"]) {
    const current = await readFile(new URL("../../" + relative, import.meta.url));
    const entry = inputs.map(object).find(item => item.path === relative); ensure(entry);
    expect(entry.bytes).toBe(current.byteLength); expect(entry.sha256).toBe(hash(current));
  }
}, 20_000);

interface PreparedArchive {
  readonly source: CurrentV28OnlineRecoverySource; readonly origin: string; readonly backupId: string;
  readonly bytes: Uint8Array<ArrayBuffer>; readonly sha256: string; readonly dataPath: string; readonly configurationPath: string;
  readonly window: Readonly<{ generation: number; token: string }>;
  readonly incarnation: string;
  readonly release: ReturnType<typeof checkedSystemRecoveryMaintenanceReceipt>;
  readonly resumeInput: Readonly<{ requestId: string; releaseRequestId: string; backupJobId: string; expectedGeneration: number }>;
  readonly resume: Readonly<Record<string, unknown>>;
}
async function withRecoveryCli<T>(source: CurrentV28OnlineRecoverySource, origin: string,
  work: (owner: CurrentRecoveryCliOwner) => Promise<T>): Promise<T> {
  const configurationPath = await source.writeRecoveryConfiguration(origin), owner = launchCurrentRecoveryCli(distribution, configurationPath, source.baseline.rootOwnerUid);
  let failed = false, failure: unknown, value!: T;
  try { await owner.ready; value = await work(owner); } catch (error) { failed = true; failure = error; }
  try { await closeCurrentRecoveryCli(owner); }
  catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], "Original Recovery preparation and first close failed") : cleanup; }
  if (failed) throw failure; return value;
}

/** Existing genuine fixture/CLI/kernel setup, fully closed BEFORE the compiled
 * combined main. The one-shot fixture stages do not qualify elapsed cadence. */
async function prepareCompletedArchive(): Promise<PreparedArchive> {
  const source = await prepareCurrentV28OnlineRecoverySource(), baseline = source.baseline;
  const originalSource = await withCanonicalFileDatabase(baseline.path, async (owner, _lease, native) => {
    const runtime = native.prepare(`SELECT a.mode,g.enabled,g.incarnation FROM file_authority_control a
      JOIN file_authority_runtime_guard g ON g.singleton=a.singleton WHERE a.singleton=1`).get();
    expect(runtime).toMatchObject({ mode: "active", enabled: 1 }); ensure(typeof runtime?.incarnation === "string" && runtime.incarnation);
    return { origin: await canonicalFilePrivateOrigin(owner), incarnation: runtime.incarnation };
  });
  const { origin, incarnation } = originalSource;
  const base = { databasePath: baseline.path, filesystemRootOwnerUid: baseline.rootOwnerUid };
  const member = await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: baseline.principalId,
    displayName: "Genuine held-response member", workspaceRole: "membershipAdministrator", canCreateSamples: true, expectedControlRevision: 1 }); ensure(member.memberId);
  await executeCollaborationV28OperatorCandidate({ ...base, kind: "set-enforcement", enforcement: "enabled", expectedControlRevision: 1 });
  const accepted = await withRecoveryCli(source, origin, async owner => {
    const session = await loginCurrentRecoveryCli(owner, origin, "operator", CANONICAL_FILE_PASSWORD);
    expect(session.actor).toBe(baseline.operatorActor); expect(session.systemAdministrator).toBe(true);
    const enabled = await recoveryCliJson(owner, origin, "/api/system-recovery/executor", "POST", { enabled: true }, session);
    expect(enabled.status).toBe(200); expect(checkedSystemRecoveryCapabilities(enabled.value).enabled).toBe(true);
    const initial = checkedSystemRecoveryMaintenanceStatus((await recoveryCliJson(owner, origin, "/api/system-recovery/maintenance", "GET", undefined, session)).value);
    expect(initial).toMatchObject({ state: "open", activeWriters: 0 });
    const enterInput = { requestId: randomUUID(), action: "enter", expectedGeneration: initial.generation } as const;
    const enter = await recoveryCliJson(owner, origin, "/api/system-recovery/maintenance", "POST", enterInput, session); expect(enter.status).toBe(200);
    const entered = checkedSystemRecoveryMaintenanceReceipt(enter.value); expect(entered.status.state).toBe("draining");
    const finalize = await recoveryCliJson(owner, origin, "/api/system-recovery/maintenance", "POST",
      { requestId: randomUUID(), action: "finalize", expectedGeneration: entered.status.generation }, session); expect(finalize.status).toBe(200);
    const fenced = checkedSystemRecoveryMaintenanceReceipt(finalize.value).status;
    expect(fenced).toMatchObject({ state: "fenced", activeWriters: 0, token: enterInput.requestId }); ensure(fenced.token);
    const backup = await recoveryCliJson(owner, origin, "/api/system-recovery/jobs", "POST", { requestId: randomUUID(), kind: "backup", mode: "planned" }, session);
    expect(backup.status).toBe(202); const receipt = checkedSystemRecoveryReceipt(backup.value);
    expect(receipt.job).toMatchObject({ kind: "backup", state: "queued", phase: "snapshot" });
    return { backupId: receipt.job.id, window: Object.freeze({ generation: fenced.generation, token: fenced.token }) };
  });
  assertCanonicalFileOwnersReleased();
  await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
    expect(assertCurrentV28OnlineRecoverySourceFenced(native)).toEqual(accepted.window);
    const publicOrigin = await canonicalFilePrivateOrigin(owner), configuration = await source.loadRecoveryConfiguration(publicOrigin);
    owner.applicationAttempted = true;
    const original = Promise.resolve().then(() => createNodeSystemRecoveryV28Application({ configuration,
      database: core, nativeDatabase: native, writerLease: lease, admission: admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE),
      hasher: createPasswordHasher(), identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, publicOrigin }));
    owner.originalApplication = original;
    const app = await original; owner.application = app; await listenCanonicalFileApplication(owner, publicOrigin);
    for (const outcome of ["snapshot", "source_measured", "measured", "completed"])
      expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: accepted.backupId, outcome });
    expect(native.prepare("SELECT state,phase FROM system_recovery_jobs WHERE id=?").get(accepted.backupId)).toEqual({ state: "completed", phase: "done" });
  });
  assertCanonicalFileOwnersReleased();
  const archivePath = join(baseline.root, "original-public-completed-one-file-v5.zip");
  const downloaded = await withRecoveryCli(source, origin, async owner => {
    const session = await loginCurrentRecoveryCli(owner, origin, "operator", CANONICAL_FILE_PASSWORD);
    const status = checkedSystemRecoveryJobStatus((await recoveryCliJson(owner, origin, "/api/system-recovery/jobs/" + accepted.backupId, "GET", undefined, session)).value);
    expect(status).toMatchObject({ state: "completed", phase: "done", output: { available: true }, progress: { totalFiles: 1, completedFiles: 1 } }); ensure(status.output);
    const answer = await recoveryCliBytes(owner, origin, "/api/system-recovery/jobs/" + accepted.backupId + "/download", "GET", undefined, session);
    expect(answer.status).toBe(200); expect(answer.headers.get("content-type")).toBe("application/zip");
    expect(answer.bytes.byteLength).toBe(status.output.byteSize); expect(hash(answer.bytes)).toBe(status.output.sha256);
    const originalBytes = Uint8Array.from(answer.bytes);
    await writeFile(archivePath, originalBytes, { flag: "wx", mode: 0o600 });
    const strict = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archivePath), { ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: status.output.sha256 });
    expect(strict.manifest.completeness).toBe("complete"); expect(strict.manifest.counts).toMatchObject({ sources: 1, packagedFiles: 1, unavailableFiles: 0, bytes: source.payloadBytes });
    expect(strict.records.origin.capturePolicy).toBe("quiesced-writers-and-bytes/1");
    expect(strict.manifest.files[0]).toMatchObject({ outcome: "packaged", fileIds: [source.sourceFileId], byteSize: source.payloadBytes, sha256: source.payloadSha256 });
    // The complete original backup and public body/provider EOF precede
    // explicit release/resume. The archive retains its immutable fenced origin;
    // only the original source's later local operational state changes.
    const fenced = checkedSystemRecoveryMaintenanceStatus((await recoveryCliJson(owner, origin,
      "/api/system-recovery/maintenance", "GET", undefined, session)).value);
    expect(fenced).toMatchObject({ state: "fenced", generation: accepted.window.generation,
      token: accepted.window.token, checkpoint: strict.manifest.sourceCheckpoint, backupJobId: accepted.backupId, activeWriters: 0 });
    // Resume is an explicit original-source operation with all executors
    // stopped. It never implicitly enables Recovery, shadow or Jobs.
    const disabled = await recoveryCliJson(owner, origin, "/api/system-recovery/executor", "POST", { enabled: false }, session);
    expect(disabled.status).toBe(200); expect(checkedSystemRecoveryCapabilities(disabled.value).enabled).toBe(false);
    const releaseRequestId = randomUUID();
    const released = await recoveryCliJson(owner, origin, "/api/system-recovery/maintenance", "POST",
      { requestId: releaseRequestId, action: "release", expectedGeneration: fenced.generation }, session);
    expect(released.status).toBe(200); const release = checkedSystemRecoveryMaintenanceReceipt(released.value);
    expect(release).toMatchObject({ requestId: releaseRequestId, action: "release", expectedGeneration: fenced.generation,
      status: { state: "open", generation: fenced.generation + 1, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 } });
    const resumeInput = Object.freeze({ requestId: randomUUID(), releaseRequestId, backupJobId: accepted.backupId,
      expectedGeneration: release.status.generation });
    const resumed = await recoveryCliJson(owner, origin, "/api/system-recovery/source-resume", "POST", resumeInput, session);
    expect(resumed.status).toBe(200); const resume = object(resumed.value);
    expect(resume).toMatchObject({ ...resumeInput, schema: "node-original-source-resume/1", sourceInstallationId: baseline.installationId,
      incarnation, sourceCheckpoint: strict.manifest.sourceCheckpoint,
      enabled: true, shadowEnabled: false, jobsEnabled: false, noBindingCutover: true, noJobReplay: true });
    expect(Object.keys(resume).sort()).toEqual(["backupJobId", "enabled", "expectedGeneration", "incarnation", "jobsEnabled",
      "noBindingCutover", "noJobReplay", "releaseRequestId", "requestId", "resumedAt", "schema", "shadowEnabled", "sourceCheckpoint", "sourceInstallationId"]);
    ensure(typeof resume.resumedAt === "string" && new Date(resume.resumedAt).toISOString() === resume.resumedAt);
    const reconciled = await recoveryCliJson(owner, origin, "/api/system-recovery/source-resume/requests/" + resumeInput.requestId,
      "GET", undefined, session);
    expect(reconciled.status).toBe(200); expect(reconciled.value).toEqual(resume);
    return { bytes: originalBytes, sha256: status.output.sha256, release, resumeInput, resume: Object.freeze({ ...resume }) };
  });
  const dataPath = await actualRecoveryArchiveData(source.recoveryArtifacts.root, accepted.backupId, { byteSize: downloaded.bytes.byteLength, sha256: downloaded.sha256 });
  const configurationPath = join(baseline.root, "actual-held-workflow-runtime.json");
  await writeFile(configurationPath, JSON.stringify({ format: "node-loopback-development-v1", dataDirectory: baseline.dataDirectory,
    expectedInstallationId: baseline.installationId, publicOrigin: origin, clientDirectory: baseline.clientDirectory, localVolumes: baseline.descriptors,
    enableLocalFile: true, enableLocalJobs: true, enableLocalRecovery: true, recoveryArtifacts: source.recoveryArtifacts }), { flag: "wx", mode: 0o600 });
  assertCanonicalFileOwnersReleased(); return { source, origin, incarnation, ...accepted, ...downloaded, dataPath, configurationPath };
}

async function assertActualWriterBusy(prepared: PreparedArchive): Promise<void> {
  let lease: Awaited<ReturnType<typeof acquireLinuxWriterLease>> | undefined;
  try { lease = await acquireLinuxWriterLease({ databasePath: prepared.source.baseline.path, filesystemRootOwnerUid: prepared.source.baseline.rootOwnerUid }); }
  catch (error) {
    expect(error).toBeInstanceOf(WriterLeaseError); expect((error as WriterLeaseError).code).toBe("busy");
    expect(writerLeaseProcessState()).toEqual({ pendingAcquisitions: 0, quarantinedAcquisitions: 0, failedCleanups: 0 }); return;
  }
  ensure(lease); await lease.release(); throw new Error("Original held Workflow parent released its physical writer prematurely");
}
async function cursor(prepared: PreparedArchive): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(join(prepared.source.baseline.dataDirectory, ".node-v28-workflow-job-cursor.json"), "utf8")));
}
async function assertSourceAfterOriginalClose(prepared: PreparedArchive, rejectedRequestId: string, uploadId?: string): Promise<void> {
  const { source, backupId, window } = prepared;
  await withCanonicalFileDatabase(source.baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
    expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(native.prepare("SELECT state,generation,token,checkpoint_sha256 AS checkpoint,backup_job_id AS backupJobId FROM system_recovery_maintenance WHERE singleton=1").get())
      .toEqual({ state: "open", generation: prepared.release.status.generation, token: null, checkpoint: null, backupJobId: null });
    expect(prepared.release.status.generation).toBe(window.generation + 1);
    const release = native.prepare("SELECT actor,action,expected_generation,result_json FROM system_recovery_maintenance_requests WHERE request_id=?")
      .get(prepared.release.requestId);
    expect(release).toMatchObject({ actor: source.baseline.operatorActor, action: "release", expected_generation: window.generation });
    ensure(typeof release?.result_json === "string"); expect(JSON.parse(release.result_json)).toEqual(prepared.release.status);
    const acceptedResume = native.prepare("SELECT actor,job_id,input_sha256,accepted_at FROM system_recovery_requests WHERE request_id=?")
      .get("node_source_resume:" + prepared.resumeInput.requestId);
    expect(acceptedResume).toMatchObject({ actor: source.baseline.operatorActor, job_id: backupId, accepted_at: prepared.resume.resumedAt });
    ensure(typeof acceptedResume?.input_sha256 === "string");
    const documents = native.prepare("SELECT ordinal,chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND name=? ORDER BY ordinal")
      .all(backupId, "node-source-resume/" + prepared.resumeInput.requestId);
    expect(documents).toHaveLength(1); expect(documents[0]?.ordinal).toBe(0); ensure(typeof documents[0]?.chunk === "string");
    expect(JSON.parse(documents[0].chunk)).toEqual({ schema: "node-source-resume-receipt/1", input: prepared.resumeInput, result: prepared.resume });
    expect(hash(Buffer.from(documents[0].chunk, "utf8"))).toBe(acceptedResume.input_sha256);
    expect(native.prepare("SELECT source_checkpoint FROM system_recovery_jobs WHERE id=?").get(backupId)?.source_checkpoint)
      .toBe(prepared.resume.sourceCheckpoint);
    expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
    expect(native.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").get()?.mode).toBe("active");
    expect(native.prepare("SELECT enabled,enabled_by,incarnation FROM file_authority_runtime_guard WHERE singleton=1").get())
      .toEqual({ enabled: 1, enabled_by: source.baseline.operatorActor, incarnation: prepared.incarnation });
    expect(native.prepare("SELECT enabled FROM file_shadow_runtime_guard WHERE singleton=1").get()?.enabled).toBe(0);
    expect(currentV28RecoveryTypedRows(native)).toEqual(source.expectedTypedSource);
    expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(source.expectedTypedPhysicalBindings);
    expect(native.prepare("SELECT state,phase FROM system_recovery_jobs WHERE id=?").get(backupId)).toEqual({ state: "completed", phase: "done" });
    expect(native.prepare("SELECT state FROM system_recovery_attempts WHERE job_id=?").all(backupId)).toEqual([{ state: "verified" }]);
    expect(native.prepare("SELECT count(*) n FROM system_recovery_jobs WHERE request_id=?").get(rejectedRequestId)?.n).toBe(0);
    expect(native.prepare("SELECT enabled FROM file_job_runtime_guard WHERE singleton=1").get()?.enabled).toBe(0);
    expect(native.prepare("SELECT enabled FROM system_recovery_runtime WHERE singleton=1").get()?.enabled).toBe(1);
    if (uploadId) {
      expect(native.prepare("SELECT state,phase FROM system_recovery_jobs WHERE id=?").get(uploadId)).toEqual({ state: "preview", phase: "done" });
      expect(native.prepare("SELECT state FROM system_recovery_attempts WHERE job_id=?").all(uploadId)).toEqual([{ state: "verified" }]);
    }
  }));
  expect(hash(await readFile(prepared.dataPath))).toBe(prepared.sha256);
  assertCanonicalFileOwnersReleased();
}
async function firstFinish(held: HeldWorkflowCli): Promise<Awaited<ReturnType<HeldWorkflowCli["finish"]>>> {
  const original = held.finish(); expect(held.finish()).toBe(original); return original;
}
async function withHeld<T>(prepared: PreparedArchive, work: (held: HeldWorkflowCli) => Promise<T>): Promise<T> {
  const held = await launchHeldWorkflowCli({ distribution, configurationPath: prepared.configurationPath,
    rootUid: prepared.source.baseline.rootOwnerUid, root: prepared.source.baseline.root, origin: prepared.origin });
  let failed = false, failure: unknown, value!: T;
  try { value = await work(held); } catch (error) { failed = true; failure = error; }
  try { await firstFinish(held); }
  catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], "Original held Workflow operation and first close failed") : cleanup; }
  if (failed) throw failure; return value;
}

describe("actual compiled V28 workflow Recovery original body and slot SIGTERM", () => {
  for (const ending of ["eof", "cancel"] as const) {
    it("retains an already delivered archive Response through SIGTERM and original provider ACK before " + ending,
      () => retainedCanonicalFileCase(async () => {
        const prepared = await prepareCompletedArchive(), { source, origin } = prepared;
        const proof = await withHeld(prepared, async held => {
          const session = await loginWorkflowCli(held.workflow, origin, "operator", CANONICAL_FILE_PASSWORD);
          expect(session.actor).toBe(source.baseline.operatorActor); expect(session.systemAdministrator).toBe(true);
          // The later independent upload probe must be admissible on a live
          // main; disabled-executor503 is not evidence of listener shutdown.
          const enabled = await workflowCliJson(held.workflow, origin, "/api/system-recovery/executor", "POST", { enabled: true }, session);
          expect(enabled.status).toBe(200); expect(checkedSystemRecoveryCapabilities(enabled.value).enabled).toBe(true);
          await held.arm(prepared.dataPath, 2);
          const delivery = await fetchCanonicalFileClient(held.workflow.clients, origin + "/api/system-recovery/jobs/" + prepared.backupId + "/download",
            { method: "GET", headers: { cookie: session.cookie }, signal: AbortSignal.timeout(60_000), redirect: "manual" });
          expect(delivery.response.status).toBe(200); expect(delivery.response.headers.get("content-type")).toBe("application/zip");
          let consumption: Promise<unknown> | undefined, consumed = false;
          if (ending === "eof") { consumption = consumeCanonicalFileClient(delivery.client, "arrayBuffer"); void consumption.then(() => { consumed = true; }, () => undefined); }
          const reached = await held.reached(); expect(reached).toMatchObject({ dataPath: prepared.dataPath, ordinal: 2, originalReadSettled: true });
          expect(consumed).toBe(false); ensure(performance.now() - held.workflow.launchedAt < NODE_V28_JOB_CADENCE_MS);
          const before = await cursor(prepared); expect(before).toMatchObject({ consumedSlots: 0, reservation: null });
          const stopped = await held.stopAndObserve(); expect(await held.hasNativeClosed()).toBe(false); expect(held.workflow.ended).toBe(false);
          await assertActualWriterBusy(prepared);
          const denied = await rejectedWorkflowHttpAfterStop(origin, session); ensure(typeof denied.requestId === "string");
          let cancelled: Promise<void> | undefined;
          if (ending === "cancel") { cancelled = closeCanonicalFileClient(held.workflow.clients, delivery.client); expect(closeCanonicalFileClient(held.workflow.clients, delivery.client)).toBe(cancelled); void cancelled.catch(() => undefined); }
          expect(await held.hasNativeClosed()).toBe(false);
          const released = await held.release();
          if (consumption) { const body = await consumption; ensure(body instanceof ArrayBuffer); expect(body.byteLength).toBe(prepared.bytes.byteLength); expect(hash(new Uint8Array(body))).toBe(prepared.sha256); }
          if (cancelled) await cancelled; else await closeCanonicalFileClient(held.workflow.clients, delivery.client);
          const closed = await firstFinish(held), native = await held.nativeCloseProof(), provider = await held.providerCloseProof();
          expect(provider).toMatchObject({ dataPath: prepared.dataPath, originalProviderCloseAcknowledged: true, providerCloseCalls: 1 });
          expect(native).toMatchObject({ actualNativeCloseAcknowledged: true, isOpenAfter: false });
          ensure(typeof stopped.observedAt === "number" && typeof released.observedAt === "number" && typeof native.observedAt === "number");
          expect(released.observedAt).toBeGreaterThanOrEqual(stopped.observedAt); expect(native.observedAt).toBeGreaterThanOrEqual(released.observedAt);
          expect(await cursor(prepared)).toEqual(before);
          return { reached, stopped, released, native, provider, denied, closed };
        });
        await assertSourceAfterOriginalClose(prepared, String(proof.denied.requestId));
        await writeFile(receiptPrefix + "." + ending + ".json", JSON.stringify({ kind: "actual-v28-workflow-held-delivered-recovery-response/1", ending,
          sourceInstallationId: source.baseline.installationId, sourceFileId: source.sourceFileId, archiveSha256: prepared.sha256,
          backupJobId: prepared.backupId, manifestSha256, preparation: { archivedSourceWindow: prepared.window, release: prepared.release, resumeInput: prepared.resumeInput, resume: prepared.resume },
          proof, actualCompiledMain: true, actualSIGTERM: true,
          originalProviderReadAcknowledged: true, originalBodyFirstCloseAcknowledged: true, originalNativeAndPhysicalCloseAcknowledged: true,
          newPublicHttpDenied: true, noNewScheduledClaim: true, internalDispatchRpcExposed: false, elapsedRecoveryCadenceQualified: false,
          fullThreeFamilyFairnessQualified: false, automaticActivation: false, originalKernelDeadlineMs: 60_000 }) + "\n", { flag: "wx", mode: 0o600 });
      }), BODY_CASE_MS);
  }

  it("drains an actually admitted Recovery-upload validation slot after real120s cadence and SIGTERM without dropping its original ACK",
    () => retainedCanonicalFileCase(async () => {
      const prepared = await prepareCompletedArchive(), { source, origin } = prepared;
      const proof = await withHeld(prepared, async held => {
        const session = await loginWorkflowCli(held.workflow, origin, "operator", CANONICAL_FILE_PASSWORD);
        const enabled = await workflowCliJson(held.workflow, origin, "/api/system-recovery/executor", "POST", { enabled: true }, session);
        expect(enabled.status).toBe(200); expect(checkedSystemRecoveryCapabilities(enabled.value).enabled).toBe(true);
        const accepted = await workflowCliJson(held.workflow, origin, "/api/system-recovery/uploads", "POST",
          { requestId: randomUUID(), byteSize: prepared.bytes.byteLength, sha256: prepared.sha256 }, session); expect(accepted.status).toBe(202);
        const uploadId = checkedSystemRecoveryReceipt(accepted.value).job.id;
        const uploaded = await workflowCliBytes(held.workflow, origin, "/api/system-recovery/jobs/" + uploadId + "/upload", "PUT", prepared.bytes, session);
        expect(uploaded.status).toBe(200); expect(checkedSystemRecoveryJobStatus(JSON.parse(new TextDecoder().decode(uploaded.bytes))))
          .toMatchObject({ state: "queued", phase: "validate" });
        const uploadData = await actualRecoveryArchiveData(source.recoveryArtifacts.root, uploadId, { byteSize: prepared.bytes.byteLength, sha256: prepared.sha256 });
        ensure(performance.now() - held.workflow.launchedAt < NODE_V28_JOB_CADENCE_MS);
        await held.arm(uploadData, 1);
        const reached = await held.reached(), elapsedMs = performance.now() - held.workflow.launchedAt;
        expect(reached).toMatchObject({ dataPath: uploadData, ordinal: 1, originalReadSettled: true }); expect(elapsedMs).toBeGreaterThanOrEqual(NODE_V28_JOB_CADENCE_MS);
        const reserved = await cursor(prepared); expect(reserved).toMatchObject({ consumedSlots: 0, reservation: { family: "recovery" } });
        const stopped = await held.stopAndObserve(); expect(await held.hasNativeClosed()).toBe(false); expect(held.workflow.ended).toBe(false);
        await assertActualWriterBusy(prepared);
        const denied = await rejectedWorkflowHttpAfterStop(origin, session); ensure(typeof denied.requestId === "string");
        const released = await held.release(), closed = await firstFinish(held), native = await held.nativeCloseProof(), provider = await held.providerCloseProof();
        expect(provider).toMatchObject({ dataPath: uploadData, originalProviderCloseAcknowledged: true, providerCloseCalls: 1 });
        expect(native).toMatchObject({ actualNativeCloseAcknowledged: true, isOpenAfter: false });
        ensure(typeof released.observedAt === "number" && typeof native.observedAt === "number"); expect(native.observedAt).toBeGreaterThanOrEqual(released.observedAt);
        const completed = await cursor(prepared); expect(completed).toMatchObject({ consumedSlots: 1, nextFamily: "file", reservation: null });
        ensure(typeof reserved.sequence === "number"); expect(completed.sequence).toBe(reserved.sequence + 1);
        return { uploadId, reached, elapsedMs, reserved, stopped, denied, released, native, provider, completed, closed };
      });
      await assertSourceAfterOriginalClose(prepared, String(proof.denied.requestId), proof.uploadId);
      await writeFile(receiptPrefix + ".scheduled.json", JSON.stringify({ kind: "actual-v28-workflow-admitted-recovery-slot-sigterm/1",
        sourceInstallationId: source.baseline.installationId, sourceFileId: source.sourceFileId, archiveSha256: prepared.sha256,
        backupJobId: prepared.backupId, manifestSha256, preparation: { archivedSourceWindow: prepared.window, release: prepared.release, resumeInput: prepared.resumeInput, resume: prepared.resume },
        proof, actualCompiledMain: true, actualSIGTERM: true,
        actualCadenceMs: NODE_V28_JOB_CADENCE_MS, actualRecoveryScheduledSlot: true, manualDispatchInsideMain: false,
        originalKernelDeadlineMs: 60_000, firstCursorCompletionAfterOriginalAck: true, originalNativeAndPhysicalCloseAcknowledged: true,
        newPublicHttpDenied: true, internalDispatchRpcExposed: false, fullThreeFamilyFairnessQualified: false,
        sourceExecutorsAutomaticallyEnabled: false, automaticReplay: false }) + "\n", { flag: "wx", mode: 0o600 });
    }), SCHEDULED_CASE_MS);
});
