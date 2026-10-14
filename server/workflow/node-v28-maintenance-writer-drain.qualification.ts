import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { verifyNodeDistribution } from "../../scripts/lib/node-distribution-v28-manifest.mjs";
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from "../../scripts/lib/system-backup-node-io.ts";
import { stableJson } from "../../shared/domain/content-addressing.ts";
import { validateV28SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission.ts";
import { PORTABLE_RUNTIME_RECOVERY_TABLES } from "../../shared/contracts/portable-runtime-v28-recovery-catalog.ts";
import { checkedSystemRecoveryCapabilities, checkedSystemRecoveryReceipt, checkedSystemRecoveryJobStatus,
  checkedSystemRecoveryPreview, checkedSystemRecoveryMaintenanceStatus, checkedSystemRecoveryMaintenanceReceipt } from "../../shared/contracts/system-recovery.ts";
import { CANONICAL_FILE_IDENTITY_POLICY, assertCanonicalFileOwnersReleased, canonicalFileClient, canonicalFilePrivateOrigin,
  consumeCanonicalFileClient, listenCanonicalFileApplication, retainedCanonicalFileCase,
  withCanonicalFileDatabase } from "../collaboration/current-v28-canonical-comment-file.qualification-support.ts";
import { createPasswordHasher } from "../auth/passwords.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { admitInstallationRecoverySource } from "../migrations.ts";
import { loadNodeRuntimeConfiguration } from "../node-runtime-config.ts";
import { executeCollaborationV28OperatorCandidate } from "../operations/collaboration-v28-operator-candidate.ts";
import { executeDomainRootV28OperatorCandidate } from "../operations/collaboration-domain-roots-v28-candidate.ts";
import { prepareCurrentRecoveryTarget } from "../recovery/current-v28-recovery-target.qualification-support.ts";
import { prepareCurrentV28WorkflowSharedFileSource, currentV28RecoveryImageRows, currentV28RecoveryTypedRows,
  CURRENT_V28_RECOVERY_PHYSICAL_TABLES } from "../recovery/current-v28-online-recovery.qualification-support.ts";
import { disabledProtectedAccountTable } from "../recovery/restore-v28-candidate.ts";
import { NODE_V28_JOB_CADENCE_MS } from "../jobs/node-v28-job-scheduler.ts";
import { createNodeV28WorkflowApplication } from "./node-v28-workflow-application.ts";
import { holdActualWorkflowFileMigrationBody } from "./node-v28-maintenance-writer-drain.qualification-support.ts";

// Finite original same-parent qualification. The production factory owns all
// three families, Native/core/lease/HTTP and the private source barrier. Its
// actual one-shot method is used; this case makes no elapsed cadence claim.
const CASE_MS = 240_000;
let distribution: string, output: string, consumerHead: string, manifestSha256: string;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function ensure(value: unknown): asserts value { if (!value) throw new Error("Original same-parent maintenance qualification is unavailable"); }
function object(value: unknown): Record<string, unknown> { ensure(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }

interface ExtraNativeOwner {
  readonly path: string; readonly readOnly: boolean; constructorAttempted: true;
  native?: DatabaseSync; originalCloser?: () => void; firstClose?: Promise<void>;
  failed: boolean; failure?: unknown;
}
const extraNativeOwners = new Set<ExtraNativeOwner>();
afterEach(() => {
  if (extraNativeOwners.size) throw new AggregateError([...extraNativeOwners].map(owner => owner.firstClose
    ?? (owner.failed ? owner.failure : new Error("Original extra Native constructor or first close remains unproven"))),
  "Original qualification-owned Native handles remain retained");
});
/** Reserve before the actual constructor. The exact returned handle alone
 * supplies the cached first close; failure never opens a substitute handle. */
function openExtraNative(path: string, readOnly: boolean) {
  const owner: ExtraNativeOwner = { path, readOnly, constructorAttempted: true, failed: false };
  extraNativeOwners.add(owner);
  try { owner.native = new DatabaseSync(path, { readOnly, allowExtension: false, enableForeignKeyConstraints: true });
    owner.originalCloser = owner.native.close.bind(owner.native);
  } catch (error) { owner.failed = true; owner.failure = error; throw error; }
  const native = owner.native; ensure(native && owner.originalCloser);
  return Object.freeze({ native, close(): Promise<void> {
    if (owner.firstClose) return owner.firstClose;
    owner.firstClose = Promise.resolve().then(() => { ensure(owner.originalCloser); owner.originalCloser();
      ensure(!native.isOpen); extraNativeOwners.delete(owner);
    }).catch(error => { owner.failed = true; owner.failure = error; throw error; });
    void owner.firstClose.catch(() => undefined); return owner.firstClose;
  } });
}

beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? "";
  output = process.env.CURRENT_V28_MAINTENANCE_WRITER_DRAIN_RECEIPT ?? "";
  consumerHead = process.env.CURRENT_V28_P7_CONSUMER_HEAD ?? "";
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && /^[a-f0-9]{40}$/.test(consumerHead));
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
  manifestSha256 = manifest.manifestSha256; ensure(typeof manifestSha256 === "string" && /^[a-f0-9]{64}$/.test(manifestSha256));
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe("portable-runtime/v28");
  expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe("v5"); expect(NODE_V28_JOB_CADENCE_MS).toBe(120_000);
  const inputs = object(JSON.parse(await readFile(join(distribution, "source-inputs.json"), "utf8"))).inputs; ensure(Array.isArray(inputs));
  for (const relative of ["server/main.ts", "server/http.ts", "server/node-runtime-config.ts", "server/sqlite.ts",
    "server/auth/installed-identity-execution-owner-v28-candidate.ts", "server/workflow/node-v28-workflow-runtime.ts",
    "server/workflow/node-v28-workflow-application.ts", "server/workflow/node-v28-file-job-child.ts", "server/jobs/node-v28-job-scheduler.ts",
    "server/recovery/node-v28-source-barrier.ts", "server/recovery/node-system-recovery-v28-application.ts",
    "server/recovery/node-v28-target-stages.ts", "server/recovery/node-v28-recovery-target.ts",
    "server/files/jobs/request-http.ts", "server/packages/job-child-v28-candidate.ts", "worker/recovery/kernel.ts"]) {
    const raw = await readFile(new URL("../../" + relative, import.meta.url));
    const entry = inputs.map(object).find(value => value.path === relative); ensure(entry);
    expect(entry.bytes).toBe(raw.byteLength); expect(entry.sha256).toBe(hash(raw));
  }
}, 20_000);

describe("genuine same-parent V28 source maintenance and planned inert handoff", () => {
  it("drains an admitted original File body before final fencing, refuses a changed final source checkpoint and records a positive planned inert handoff",
    () => retainedCanonicalFileCase(async () => {
      const source = await prepareCurrentV28WorkflowSharedFileSource(), baseline = source.baseline;
      const target = await prepareCurrentRecoveryTarget(source);
      const base = { databasePath: baseline.path, filesystemRootOwnerUid: baseline.rootOwnerUid };
      const member = await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: baseline.principalId,
        displayName: "Genuine maintenance writer member", workspaceRole: "membershipAdministrator", canCreateSamples: true, expectedControlRevision: 1 });
      ensure(member.memberId);
      const flags = await executeDomainRootV28OperatorCandidate({ ...base, kind: "set-creation-flags", principalId: baseline.principalId,
        expectedMemberRevision: 1, expectedControlRevision: 1, canCreateSamples: true, canCreateProjects: false, canCreateTemplates: false });
      await executeDomainRootV28OperatorCandidate({ ...base, kind: "allocate-existing-root", rootKind: "sample", rootId: source.workflowSampleId,
        visibility: "restricted", principalId: baseline.principalId, expectedMemberRevision: flags.memberRevision, expectedControlRevision: 1 });
      await executeCollaborationV28OperatorCandidate({ ...base, kind: "set-enforcement", enforcement: "enabled", expectedControlRevision: 1 });
      assertCanonicalFileOwnersReleased();
      const result = await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
        const origin = await canonicalFilePrivateOrigin(owner), configurationPath = join(baseline.root, "same-parent-maintenance-runtime.json");
        await writeFile(configurationPath, JSON.stringify({ format: "node-loopback-development-v1", dataDirectory: baseline.dataDirectory,
          expectedInstallationId: baseline.installationId, publicOrigin: origin, clientDirectory: baseline.clientDirectory, localVolumes: baseline.descriptors,
          enableLocalFile: true, enableLocalJobs: true, enableLocalRecovery: true, recoveryArtifacts: source.recoveryArtifacts,
          recoveryTarget: target.descriptor }), { flag: "wx", mode: 0o600 });
        const configuration = loadNodeRuntimeConfiguration(configurationPath, { filesystemRootOwnerUid: baseline.rootOwnerUid, runtimeProfile: "v28-workflow" });
        owner.applicationAttempted = true;
        const original = owner.originalApplication = Promise.resolve().then(() => createNodeV28WorkflowApplication({ configuration,
          database: core, nativeDatabase: native, writerLease: lease, admission: admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE),
          hasher: createPasswordHasher(), identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, publicOrigin: origin,
          httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 } }));
        const app = await original; owner.application = app; await listenCanonicalFileApplication(owner, origin);
        const client = canonicalFileClient(owner, origin), session = await client.login("operator");
        expect(app.capabilities.jobFamilies).toEqual(["file", "package", "recovery"]);
        expect(app.capabilities.jobCadenceMs).toBe(120_000);
        expect((await client.request("/api/system-recovery/executor", "POST", { enabled: true }, session)).status).toBe(200);
        const capabilities = await client.request("/api/system-recovery/capabilities", "GET", undefined, session);
        expect(checkedSystemRecoveryCapabilities(capabilities.value)).toMatchObject({ enabled: true, target: { configured: true, id: target.descriptor.targetId } });
        const initial = checkedSystemRecoveryMaintenanceStatus((await client.request("/api/system-recovery/maintenance", "GET", undefined, session)).value);
        expect(initial).toMatchObject({ state: "open", activeWriters: 0 });
        const heldInput = { requestId: randomUUID(), fileIds: [source.sourceFileId], target: { profileId: baseline.originalsProfileId, configurationRevision: 1 } };
        const held = await holdActualWorkflowFileMigrationBody({ native, origin, actor: baseline.operatorActor, cookie: session.cookie, csrf: session.csrf, input: heldInput });
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(1);
        const enterInput = { requestId: randomUUID(), action: "enter", expectedGeneration: initial.generation } as const;
        let enterSettled = false, finalizeSettled = false;
        const enter = client.request("/api/system-recovery/maintenance", "POST", enterInput, session);
        void enter.then(() => { enterSettled = true; }, () => { enterSettled = true; });
        let finalize: ReturnType<typeof client.request> | undefined;
        let heldFailed = false, heldFailure: unknown;
        let drainProof!: Readonly<Record<string, unknown>>;
        try {
          // Poll only the actual already-owned Native state. The observer
          // neither commits a window nor stands in for the HTTP request.
          const deadline = performance.now() + 4000;
          while (native.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state !== "draining") {
            ensure(performance.now() < deadline); await new Promise<void>(done => setTimeout(done, 5));
          }
          const draining = native.prepare("SELECT state,generation,token FROM system_recovery_maintenance WHERE singleton=1").get();
          expect(draining).toEqual({ state: "draining", generation: initial.generation + 1, token: enterInput.requestId });
          expect(enterSettled).toBe(false);
          expect(native.prepare("SELECT released_at FROM system_recovery_write_leases WHERE id=?").get(held.leaseId)?.released_at).toBeNull();
          const finalizeInput = { requestId: randomUUID(), action: "finalize", expectedGeneration: initial.generation + 1 } as const;
          finalize = client.request("/api/system-recovery/maintenance", "POST", finalizeInput, session);
          void finalize.then(() => { finalizeSettled = true; }, () => { finalizeSettled = true; });
          const deniedInput = { ...heldInput, requestId: randomUUID() };
          const denied = await client.request("/api/files/migrations", "POST", deniedInput, session);
          expect(denied.status).toBe(503);
          expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(1);
          expect(native.prepare("SELECT count(*) n FROM file_migration_jobs WHERE request_id IN (?,?)").get(heldInput.requestId, deniedInput.requestId)?.n).toBe(0);
          expect(native.prepare("SELECT count(*) n FROM system_recovery_maintenance_requests WHERE request_id=?").get(finalizeInput.requestId)?.n).toBe(0);
          expect(enterSettled).toBe(false); expect(finalizeSettled).toBe(false);
          // This sends the remainder to the same original socket/body. An
          // early transport failure is never used as its handler/drain ACK.
          held.endRemainder();
          const entered = await enter; expect(entered.status).toBe(200);
          expect(checkedSystemRecoveryMaintenanceReceipt(entered.value).status).toMatchObject({ state: "draining", activeWriters: 1 });
          const fenced = await finalize; expect(fenced.status).toBe(200);
          expect(checkedSystemRecoveryMaintenanceReceipt(fenced.value).status).toMatchObject({ state: "fenced", activeWriters: 0, generation: initial.generation + 1, token: enterInput.requestId });
          await held.finishAfterOriginalDrain(enter);
          drainProof = held.releaseProof();
          expect(drainProof).toMatchObject({ actualReleaseCalls: 1, actualOriginalReadSettled: true,
            originalReadResultReturnedUnchanged: true, gatePositiveAckCount: 1 });
          expect(native.prepare("SELECT count(*) n FROM file_migration_jobs WHERE request_id=?").get(heldInput.requestId)?.n).toBe(0);
          expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
        } catch (error) { heldFailed = true; heldFailure = error; throw error; }
        finally {
          try { await held.finishAfterOriginalDrain(enter); if (finalize) await finalize; }
          catch (cleanup) { throw heldFailed ? new AggregateError([heldFailure, cleanup], "Original held source request and first drain failed") : cleanup; }
        }
        for (const name of ["file_shadow_runtime_guard", "file_authority_runtime_guard", "file_job_runtime_guard"])
          expect(native.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
        const backup = await client.request("/api/system-recovery/jobs", "POST", { requestId: randomUUID(), kind: "backup", mode: "planned" }, session);
        expect(backup.status).toBe(202); const backupId = checkedSystemRecoveryReceipt(backup.value).job.id;
        for (const outcome of ["snapshot", "source_measured", "measured", "completed"])
          expect(await app.dispatchJobsOnce()).toEqual({ jobId: backupId, outcome });
        const backupState = checkedSystemRecoveryJobStatus((await client.request(`/api/system-recovery/jobs/${backupId}`, "GET", undefined, session)).value);
        ensure(backupState.output?.available);
        const download = await client.raw(`/api/system-recovery/jobs/${backupId}/download`, "GET", session);
        expect(download.response.status).toBe(200); const raw = await consumeCanonicalFileClient(download.client, "arrayBuffer"); ensure(raw instanceof ArrayBuffer);
        const archiveBytes = new Uint8Array(raw); expect(hash(archiveBytes)).toBe(backupState.output.sha256);
        const archivePath = join(baseline.root, "same-parent-final-source-v5.zip"); await writeFile(archivePath, archiveBytes, { flag: "wx", mode: 0o600 });
        const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archivePath), { ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: backupState.output.sha256 });
        expect(admitted.manifest.completeness).toBe("complete"); expect(admitted.manifest.files).toHaveLength(1);
        expect(admitted.manifest.files[0]).toMatchObject({ outcome: "packaged", byteSize: source.payloadBytes, sha256: source.payloadSha256,
          source: { provider: "local", fileId: source.sourceFileId } });
        const finalWindow = checkedSystemRecoveryMaintenanceStatus((await client.request("/api/system-recovery/maintenance", "GET", undefined, session)).value);
        expect(finalWindow).toMatchObject({ state: "fenced", generation: initial.generation + 1, token: enterInput.requestId,
          backupJobId: backupId, checkpoint: admitted.manifest.sourceCheckpoint, activeWriters: 0 });
        const acceptedUpload = await client.request("/api/system-recovery/uploads", "POST", { requestId: randomUUID(), byteSize: archiveBytes.byteLength, sha256: backupState.output.sha256 }, session);
        expect(acceptedUpload.status).toBe(202); const uploadId = checkedSystemRecoveryReceipt(acceptedUpload.value).job.id;
        const put = await client.raw(`/api/system-recovery/jobs/${uploadId}/upload`, "PUT", session, archiveBytes, { "content-type": "application/zip", "content-length": String(archiveBytes.byteLength) });
        expect(put.response.status).toBe(200); await consumeCanonicalFileClient(put.client, "json");
        expect(await app.dispatchJobsOnce()).toEqual({ jobId: uploadId, outcome: "preview" });
        const preview = checkedSystemRecoveryPreview((await client.request(`/api/system-recovery/jobs/${uploadId}/preview`, "GET", undefined, session)).value);
        expect(preview).toMatchObject({ canRecover: true, archive: { complete: true, schema: "system-backup/5" } });
        const recoveryInput = { requestId: randomUUID(), uploadJobId: uploadId, expectedTargetId: target.descriptor.targetId, mapping: [], mode: "planned", acknowledgeLaterChanges: false, acknowledgePartial: false } as const;
        const recovery = await client.request("/api/system-recovery/recoveries", "POST", recoveryInput, session);
        expect(recovery.status).toBe(202); const recoveryId = checkedSystemRecoveryReceipt(recovery.value).job.id;
        const planned = object(JSON.parse(String(native.prepare("SELECT checkpoint_json FROM system_recovery_jobs WHERE id=?").get(recoveryId)?.checkpoint_json)));
        expect(planned.plannedSourceWindow).toEqual({ generation: finalWindow.generation, token: finalWindow.token, backupJobId: backupId, checkpoint: finalWindow.checkpoint });
        for (let count = 0; ; count++) {
          ensure(count < 64); const step = await app.dispatchJobsOnce(); expect(step.jobId).toBe(recoveryId); expect(step.outcome).not.toBe("paused");
          if (step.outcome === "target_ready") break;
        }
        const refreshed = await client.login("operator");
        const ready = checkedSystemRecoveryJobStatus((await client.request(`/api/system-recovery/jobs/${recoveryId}`, "GET", undefined, refreshed)).value);
        expect(ready).toMatchObject({ state: "completed", phase: "ready", result: { ready: true, cutover: false, targetId: target.descriptor.targetId } });
        ensure(ready.result?.checkpoint);
        const reportReply = await client.request(`/api/system-recovery/jobs/${recoveryId}/report`, "GET", undefined, refreshed);
        expect(reportReply.status).toBe(200); const report = object(reportReply.value);
        expect(report).toMatchObject({ mode: "planned", historicalLaterChangesLost: false, targetCheckpoint: ready.result.checkpoint,
          execution: { authority: false, shadow: false, fileJobs: false, recoveryJobs: false, cleanup: false, oldJobReplay: false },
          handoff: { automaticBindingChange: false, operatorRequired: true, sourceRetainedReadOnly: true } });
        const handoffInput = { requestId: randomUUID(), expectedTargetId: target.descriptor.targetId, expectedCheckpoint: ready.result.checkpoint };
        // A test-owned second Native changes one existing genuine business
        // cell only. No permissions, ledger, schema or window is fabricated.
        const family = native.prepare("SELECT id,name FROM recipe_families ORDER BY id LIMIT 1").get();
        ensure(family && typeof family.id === "string" && typeof family.name === "string");
        // The fixed admitted catalog has no recipe_families trigger; the live
        // exact schema guard remains active and this observation grants nothing.
        expect(native.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND tbl_name='recipe_families'").get()?.n).toBe(0);
        const familyId = family.id, familyName = family.name, faultName = familyName + " bounded final-source fault " + randomUUID();
        const faultOwner = openExtraNative(baseline.path, false), fault = faultOwner.native;
        let faultFailed = false, faultFailure: unknown, changed = false;
        try {
          expect(fault.prepare("UPDATE recipe_families SET name=? WHERE id=? AND name=?").run(faultName, familyId, familyName).changes).toBe(1); changed = true;
          const refused = await client.request(`/api/system-recovery/jobs/${recoveryId}/cutover`, "POST", handoffInput, refreshed);
          expect(refused.status).toBe(409);
          expect(refused.value).toEqual({ error: "Final source checkpoint changed; recapture before handoff" });
          expect(native.prepare("SELECT count(*) n FROM system_recovery_requests WHERE request_id=?").get(handoffInput.requestId)?.n).toBe(0);
          expect(JSON.parse(String(native.prepare("SELECT result_json FROM system_recovery_jobs WHERE id=?").get(recoveryId)?.result_json)).cutover).toBe(false);
          expect(checkedSystemRecoveryMaintenanceStatus((await client.request("/api/system-recovery/maintenance", "GET", undefined, refreshed)).value)).toEqual(finalWindow);
        } catch (error) { faultFailed = true; faultFailure = error; throw error; }
        finally {
          const cleanup: unknown[] = [];
          try { if (changed) expect(fault.prepare("UPDATE recipe_families SET name=? WHERE id=? AND name=?").run(familyName, familyId, faultName).changes).toBe(1); }
          catch (error) { cleanup.push(error); }
          // An unsuccessful restoration never skips the original first close.
          try { const first = faultOwner.close(); expect(faultOwner.close()).toBe(first); await first; }
          catch (error) { cleanup.push(error); }
          if (cleanup.length) throw new AggregateError([...(faultFailed ? [faultFailure] : []), ...cleanup], "Original final-source fault restoration or first Native close failed");
        }
        const handoff = await client.request(`/api/system-recovery/jobs/${recoveryId}/cutover`, "POST", handoffInput, refreshed);
        expect(handoff.status).toBe(200); const receipt = checkedSystemRecoveryReceipt(handoff.value);
        expect(receipt.job.result).toMatchObject({ ready: true, cutover: true, checkpoint: ready.result.checkpoint });
        expect((await client.request(`/api/system-recovery/jobs/${recoveryId}/cutover`, "POST", handoffInput, refreshed)).value).toEqual({ ...receipt, reused: true });
        expect((await client.request(`/api/system-recovery/jobs/${recoveryId}/control`, "POST", { action: "cleanup" }, refreshed)).status).toBe(409);
        expect((await client.request("/api/system-recovery/executor", "POST", { enabled: false }, refreshed)).status).toBe(200);
        expect(currentV28RecoveryTypedRows(native)).toEqual(source.expectedTypedSource);
        expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(source.expectedTypedPhysicalBindings);
        expect(native.prepare("SELECT name FROM recipe_families WHERE id=?").get(familyId)?.name).toBe(familyName);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
        return { admitted, backupId, uploadId, recoveryId, finalWindow, report, receipt, drainProof };
      });
      assertCanonicalFileOwnersReleased();
      const sourceBefore = await lstat(baseline.path, { bigint: true }), sourceHash = hash(await readFile(baseline.path));
      const destinationInstallationId = await withCanonicalFileDatabase(join(target.destination, "database.sqlite"), async (_owner, lease, native) => lease.withWriter(async () => {
        const installation = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE).receipt;
        expect(installation.installationId).not.toBe(baseline.installationId);
        for (const spec of PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => !table.local)) {
          const expected = result.admitted.records.image.tables[spec.name]!;
          expect(currentV28RecoveryTypedRows(native, [spec.name])[spec.name]).toEqual(currentV28RecoveryImageRows(spec.name === "local_accounts" ? disabledProtectedAccountTable(expected) : expected));
        }
        for (const name of ["file_shadow_runtime_guard", "file_authority_runtime_guard", "file_job_runtime_guard", "system_recovery_runtime"])
          expect(native.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
        for (const name of ["local_sessions", "local_admin_grants", "system_storage_native_bindings", "local_storage_profile_bindings", "file_job_cleanup_grants",
          "system_recovery_jobs", "system_recovery_target_claim", "system_recovery_target_files", "collaboration_members", "collaboration_identities", "collaboration_resources", "collaboration_grants"])
          expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0);
        expect(native.prepare("SELECT count(*) n FROM local_accounts WHERE enabled<>0").get()?.n).toBe(0);
        expect(native.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state).toBe("fenced");
        expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(native.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
        return installation.installationId;
      }));
      for (const file of result.admitted.manifest.files) {
        ensure(file.path && file.sha256 !== null && file.byteSize !== null);
        const path = join(target.destination, file.path), stat = await lstat(path);
        expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600).toBe(true);
        const bytes = await readFile(path); expect(bytes.byteLength).toBe(file.byteSize); expect(hash(bytes)).toBe(file.sha256); expect(new Uint8Array(bytes)).toEqual(source.bytes);
      }
      // Observe the retained source through an actual read-only Native handle.
      // No new source writer or synthetic lock file is introduced here.
      const retainedOwner = openExtraNative(baseline.path, true), retained = retainedOwner.native;
      let retainedFailed = false, retainedFailure: unknown;
      try {
        expect(currentV28RecoveryTypedRows(retained)).toEqual(source.expectedTypedSource);
        expect(currentV28RecoveryTypedRows(retained, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(source.expectedTypedPhysicalBindings);
        expect(retained.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state).toBe("fenced");
        for (const name of ["file_shadow_runtime_guard", "file_authority_runtime_guard", "file_job_runtime_guard", "system_recovery_runtime"])
          expect(retained.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
        expect(retained.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } catch (error) { retainedFailed = true; retainedFailure = error; throw error; }
      finally {
        try { const first = retainedOwner.close(); expect(retainedOwner.close()).toBe(first); await first; }
        catch (cleanup) { throw retainedFailed ? new AggregateError([retainedFailure, cleanup], "Original retained-source read-only observation and first Native close failed") : cleanup; }
      }
      const sourceAfter = await lstat(baseline.path, { bigint: true }); expect(hash(await readFile(baseline.path))).toBe(sourceHash);
      expect([sourceAfter.dev, sourceAfter.ino, sourceAfter.size, sourceAfter.mtimeNs]).toEqual([sourceBefore.dev, sourceBefore.ino, sourceBefore.size, sourceBefore.mtimeNs]);
      assertCanonicalFileOwnersReleased();
      await writeFile(output, stableJson({ schema: "genuine-node-v28-same-parent-maintenance-planned-handoff/1", consumerHead, manifestSha256,
        sourceInstallationId: baseline.installationId, destinationInstallationId, backupId: result.backupId, uploadId: result.uploadId, recoveryId: result.recoveryId,
        actualWorkflowFactory: true, actualSameNativeCoreLeaseParent: true, originalHttpHeldBodyAndSourceLease: result.drainProof,
        newSourceWriterDenied: true, maintenanceUnfencedBeforeOriginalAck: true, finalWindow: result.finalWindow,
        plannedFinalSourceBusinessCellFaultRefused: true, originalFaultRestorationAndCloseAcknowledged: true,
        positivePlannedHandoff: result.receipt, sourceReadOnlyObserverClosed: true, retainedSourceMainHashAndInodeUnchanged: true,
        exactTypedRowsAndRowids: true, exactPayloadBytes: source.payloadBytes, targetDefaultOffAndProtectedAuthorityAbsent: true,
        originalSameParentOneShotDispatch: true, elapsed120SecondCadenceQualified: false, actualCompiledMainInvoked: false,
        originalKernelDeadlineMs: 60_000, httpDeadlineMs: 5000, automaticActivation: false }), { flag: "wx", mode: 0o600 });
    }), CASE_MS);
});
