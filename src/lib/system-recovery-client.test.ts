import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES, type SystemRecoveryBackupPreview, type SystemRecoveryCapabilities,
  type SystemRecoveryImportInput, type SystemRecoveryJobStatus, type SystemRecoveryMaintenanceStatus,
  type SystemRecoveryPreview, type SystemRecoverySourceResumeInput, type SystemRecoverySourceResumeReceipt,
} from "../../shared/contracts/system-recovery";
import { systemRecoveryClient, systemRecoveryErrorMessage, SystemRecoveryRequestError, SystemRecoveryRequestMissingError } from "./system-recovery-client";

const base = "/api/system-recovery", at = "2026-10-06T12:00:00.000Z", digest = "a".repeat(64);
const backup = { requestId: "backup-request", kind: "backup" as const, mode: "historical" as const };
const upload = { requestId: "upload-request", byteSize: 32, sha256: digest };
const recovery: SystemRecoveryImportInput = { requestId: "recovery-request", uploadJobId: "upload:1", expectedTargetId: "isolated:1",
  mapping: [{ sourceProfileId: "source:r2", destinationProfileId: "target:s3", configurationRevision: 3 }],
  mode: "historical", acknowledgeLaterChanges: true, acknowledgePartial: false };
const cutover = { requestId: "cutover-request", expectedTargetId: recovery.expectedTargetId, expectedCheckpoint: digest };
const sourceResume: SystemRecoverySourceResumeInput = { requestId: "source_resume", releaseRequestId: "source_release", backupJobId: "backup_job", expectedGeneration: 2 };
const sourceResumed: SystemRecoverySourceResumeReceipt = { schema: "node-original-source-resume/1", ...sourceResume,
  sourceInstallationId: "original_installation", incarnation: "original_incarnation", sourceCheckpoint: digest, resumedAt: at,
  enabled: true, shadowEnabled: false, jobsEnabled: false, noBindingCutover: true, noJobReplay: true };
function job(kind: SystemRecoveryJobStatus["kind"] = "backup", requestId = backup.requestId): SystemRecoveryJobStatus {
  return { id: "job:1", requestId, kind, state: "queued", phase: "snapshot", acceptedAt: at, updatedAt: at, reason: null,
    progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: 32 }, output: null, result: null };
}
const receipt = (requestId: string, kind: SystemRecoveryJobStatus["kind"] = "backup") => ({ requestId, job: job(kind, requestId), reused: false });
const capability: SystemRecoveryCapabilities = { supported: true, canManage: true, enabled: false, stale: true, lastHeartbeatAt: null,
  cadenceSeconds: 120, maxStepMs: 60000, reason: "executor_disabled", target: { configured: true, id: "isolated:1", mode: "fresh" },
  maintenance: { state: "open", checkpoint: null }, policy: { recoveryMapping: "explicit-profile", backupMaintenance: "planned-only",
    maintenanceWithoutTarget: false, recoveryCleanup: true, sourceResume: false } };
const maintenance: SystemRecoveryMaintenanceStatus = { state: "open", generation: 0, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 };
const backupPreview: SystemRecoveryBackupPreview = { schema: "system-backup-preview/1", available: true, reasons: [],
  bounds: { archiveBytes: 104857600, payloadBytes: 100663296, metadataBytes: 4194304, files: 100, maxStepMs: 60000 },
  includesProtectedSettings: true, credentialsRequireKeyring: true, maintenance: { state: "open", checkpoint: null } };
function preview(): SystemRecoveryPreview {
  return { schema: "system-recovery-preview/1", archive: { schema: "system-backup/1", byteSize: 32, sha256: digest, complete: true, legacy: false, recoveryPoint: at },
    counts: { tables: 103, rows: 400, files: 1, bytes: 16, availableFiles: 1, unavailableFiles: 0 },
    files: [{ id: "file:1", purpose: "research_source", byteSize: 16, status: "packaged", reason: null, sourceProfileId: "source:r2" }],
    profiles: [{ id: "source:r2", adapterType: "r2", namespaceIdentity: "namespace-sha256" }],
    protectedSettings: { included: true, credentialRecovery: "quarantined", warnings: ["credential_quarantined"] },
    oldJobs: { paused: 3, automaticReplay: false }, target: { id: "isolated:1", available: true, reason: null },
    source: { maintenanceRequired: true, checkpoint: null, mode: "historical" }, canRecover: true, canCutover: false, reasons: [] };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const network = vi.fn<typeof fetch>();
const mock = () => { vi.stubGlobal("fetch", network); return network; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); network.mockReset(); });

describe("privileged system backup and recovery client", () => {
  it("uses exact checked acceptance inputs and distinct backup, upload, restore and cutover endpoints", async () => {
    mock().mockResolvedValueOnce(json(receipt(backup.requestId), 202)).mockResolvedValueOnce(json(receipt(upload.requestId, "upload"), 202))
      .mockResolvedValueOnce(json(receipt(recovery.requestId, "recovery"), 202)).mockResolvedValueOnce(json(receipt(cutover.requestId, "recovery"), 202));
    const signal = new AbortController().signal;
    await systemRecoveryClient.backup(backup, signal); await systemRecoveryClient.acceptUpload(upload, signal);
    await systemRecoveryClient.restore(recovery, signal); await systemRecoveryClient.cutover("job:1", cutover, signal);
    expect(network.mock.calls.map(([path]) => path)).toEqual([`${base}/jobs`, `${base}/uploads`, `${base}/recoveries`, `${base}/jobs/job%3A1/cutover`]);
    for (const [index, input] of [backup, upload, recovery, cutover].entries()) {
      expect(network.mock.calls[index][1]).toEqual({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
        headers: { "content-type": "application/json" }, body: expect.any(String) });
      expect(JSON.parse(String(network.mock.calls[index][1]?.body))).toEqual(input);
    }
  });
  it("reads capabilities, previews, upload intents, receipts and progress without executing work", async () => {
    mock().mockResolvedValueOnce(json(capability)).mockResolvedValueOnce(json(backupPreview)).mockResolvedValueOnce(json(maintenance))
      .mockResolvedValueOnce(json({ jobs: [job()] })).mockResolvedValueOnce(json(job())).mockResolvedValueOnce(json(receipt(backup.requestId)))
      .mockResolvedValueOnce(json(upload)).mockResolvedValueOnce(json(preview()));
    await systemRecoveryClient.capabilities(); await systemRecoveryClient.backupPreview(); await systemRecoveryClient.maintenance();
    await systemRecoveryClient.list(); await systemRecoveryClient.status("job:1"); await systemRecoveryClient.readRequest(backup.requestId);
    await systemRecoveryClient.uploadIntent("upload:1"); expect(await systemRecoveryClient.preview("upload:1")).toEqual(preview());
    expect(network.mock.calls.map(([path]) => path)).toEqual([`${base}/capabilities`, `${base}/backup-preview`, `${base}/maintenance`, `${base}/jobs`,
      `${base}/jobs/job%3A1`, `${base}/requests/backup-request`, `${base}/jobs/upload%3A1/upload-intent`, `${base}/jobs/upload%3A1/preview`]);
    expect(network.mock.calls.every(([, options]) => options?.method === "GET" && options.body === undefined)).toBe(true);
    expect(systemRecoveryClient.downloadUrl("job:1")).toBe(`${base}/jobs/job%3A1/download`);
    expect(systemRecoveryClient.reportDownloadUrl("job:1")).toBe(`${base}/jobs/job%3A1/report`);
  });
  it("uploads the original Blob without full-file buffering or hashing inside the transport client", async () => {
    const file = new File(["x".repeat(32)], "恢复.zip", { type: "application/zip" });
    const buffering = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Whole-file buffering is forbidden"));
    const streaming = vi.spyOn(file, "stream");
    mock().mockResolvedValue(json({ ...job("upload"), phase: "validate" }));
    await systemRecoveryClient.upload("job:1", file);
    expect(network.mock.calls[0]).toEqual([`${base}/jobs/job%3A1/upload`, expect.objectContaining({ method: "PUT", body: file, headers: { "content-type": "application/zip" } })]);
    expect(network.mock.calls[0][1]?.body).toBe(file); expect(buffering).not.toHaveBeenCalled(); expect(streaming).not.toHaveBeenCalled();
  });
  it("reconciles lost ACKs by exact receipts and never automatically retries mutations", async () => {
    mock().mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_URL_AND_KEY")).mockResolvedValueOnce(json(receipt(backup.requestId)));
    await expect(systemRecoveryClient.backup(backup)).rejects.toMatchObject({ status: null });
    expect(network).toHaveBeenCalledOnce(); await systemRecoveryClient.readRequest(backup.requestId);
    expect(network.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
    expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toEqual(backup);
  });
  it("correlates exact maintenance receipts and separates source fencing from executor configuration", async () => {
    const input = { requestId: "maintenance:1", action: "enter" as const, expectedGeneration: 0 };
    const accepted = { ...input, status: { ...maintenance, state: "draining", token: input.requestId, generation: 1 } };
    mock().mockResolvedValueOnce(json(accepted)).mockResolvedValueOnce(json(accepted)).mockResolvedValueOnce(json({ ...capability, enabled: true }))
      .mockResolvedValueOnce(json({ ...accepted, expectedGeneration: 3 }));
    expect(await systemRecoveryClient.changeMaintenance(input)).toEqual(accepted);
    expect(await systemRecoveryClient.readMaintenanceRequest(input.requestId)).toEqual(accepted);
    await systemRecoveryClient.configureExecutor(true);
    expect(network.mock.calls.map(([path]) => path)).toEqual([`${base}/maintenance`, `${base}/maintenance/requests/maintenance%3A1`, `${base}/executor`]);
    expect(network.mock.calls[1][1]?.method).toBe("GET");
    expect(JSON.parse(String(network.mock.calls[2][1]?.body))).toEqual({ enabled: true });
    await expect(systemRecoveryClient.changeMaintenance(input)).rejects.toThrow("Invalid system recovery response.");
  });
  it("submits source resume separately and reads only its exact original receipt", async () => {
    mock().mockResolvedValueOnce(json(sourceResumed)).mockResolvedValueOnce(json(sourceResumed));
    const signal = new AbortController().signal;
    expect(await systemRecoveryClient.resumeSource(sourceResume, signal)).toEqual(sourceResumed);
    expect(await systemRecoveryClient.readSourceResumeRequest(sourceResume.requestId, signal)).toEqual(sourceResumed);
    expect(network.mock.calls).toEqual([
      [`${base}/source-resume`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify(sourceResume) }],
      [`${base}/source-resume/requests/source_resume`, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
        headers: undefined, body: undefined }],
    ]);
  });
  it("retains one source resume mutation after an unknown ACK and reconciles without an automatic retry", async () => {
    mock().mockRejectedValueOnce(new Error("PRIVATE_SOURCE_RESUME_ACK")).mockResolvedValueOnce(json(sourceResumed));
    await expect(systemRecoveryClient.resumeSource(sourceResume)).rejects.toMatchObject({ status: null });
    expect(network).toHaveBeenCalledOnce(); expect(await systemRecoveryClient.readSourceResumeRequest(sourceResume.requestId)).toEqual(sourceResumed);
    expect(network.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
    expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toEqual(sourceResume);
  });
  it.each(["requestId", "releaseRequestId", "backupJobId", "expectedGeneration"] as const)("rejects a source resume acceptance with a different %s", async field => {
    const response = { ...sourceResumed, [field]: field === "expectedGeneration" ? 3 : "different_identity" };
    mock().mockResolvedValue(json(response));
    await expect(systemRecoveryClient.resumeSource(sourceResume)).rejects.toThrow("Invalid system recovery response.");
    expect(network).toHaveBeenCalledOnce();
  });
  it("rejects a different source resume request receipt and private successor fields", async () => {
    mock().mockResolvedValueOnce(json({ ...sourceResumed, requestId: "another_request" }))
      .mockResolvedValueOnce(json({ ...sourceResumed, privateCredential: "PRIVATE_SECRET" }));
    await expect(systemRecoveryClient.readSourceResumeRequest(sourceResume.requestId)).rejects.toThrow("Invalid system recovery response.");
    await expect(systemRecoveryClient.readSourceResumeRequest(sourceResume.requestId)).rejects.toThrow("Invalid system recovery input or response.");
  });
  it("rejects invalid source resume generations and identifiers before any request", async () => {
    mock();
    for (const input of [{ ...sourceResume, expectedGeneration: 1 }, { ...sourceResume, requestId: "source:resume" },
      { ...sourceResume, releaseRequestId: "release/other" }, { ...sourceResume, backupJobId: "backup with spaces" }]) {
      await expect(systemRecoveryClient.resumeSource(input)).rejects.toThrow();
    }
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["recoveryMapping", "backupMaintenance", "maintenanceWithoutTarget", "recoveryCleanup", "sourceResume"] as const)("rejects unsupported capability policy %s before exposing controls", async field => {
    mock().mockResolvedValue(json({ ...capability, policy: { ...capability.policy, [field]: "unsupported" } }));
    await expect(systemRecoveryClient.capabilities()).rejects.toThrow("Invalid system recovery input or response.");
  });
  it("rejects mismatched operation identities, unknown secret fields, impossible counts and duplicate jobs", async () => {
    mock().mockResolvedValueOnce(json(receipt("other-request"))).mockResolvedValueOnce(json({ ...job(), id: "other-job" }))
      .mockResolvedValueOnce(json({ ...capability, credentials: "PRIVATE_SECRET" })).mockResolvedValueOnce(json({ ...preview(), counts: { ...preview().counts, availableFiles: 2 } }))
      .mockResolvedValueOnce(json({ jobs: [job(), job()] }));
    await expect(systemRecoveryClient.backup(backup)).rejects.toThrow(); await expect(systemRecoveryClient.status("job:1")).rejects.toThrow();
    await expect(systemRecoveryClient.capabilities()).rejects.toThrow(); await expect(systemRecoveryClient.preview("job:1")).rejects.toThrow();
    await expect(systemRecoveryClient.list()).rejects.toThrow();
  });
  it("rejects unsafe path identities and unsupported inputs before issuing a request", async () => {
    mock();
    for (const id of [".", "..", "job/private", "job\\private", "job with space"]) {
      await expect(systemRecoveryClient.status(id)).rejects.toThrow();
      await expect(systemRecoveryClient.readMaintenanceRequest(id)).rejects.toThrow();
      expect(() => systemRecoveryClient.downloadUrl(id)).toThrow();
      expect(() => systemRecoveryClient.reportDownloadUrl(id)).toThrow();
    }
    await expect(systemRecoveryClient.acceptUpload({ ...upload, byteSize: SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES + 1 })).rejects.toThrow();
    await expect(systemRecoveryClient.restore({ ...recovery, acknowledgeLaterChanges: false })).rejects.toThrow();
    await expect(systemRecoveryClient.configureExecutor("true" as unknown as boolean)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 409, 410, 413, 422, 503, 500])("keeps private error bodies out of public messages for HTTP %s", async status => {
    const response = json({ error: "PRIVATE_PROVIDER_URL_WITH_SECRET", credentials: "PRIVATE_ROOT_KEY" }, status), read = vi.spyOn(response, "json");
    mock().mockResolvedValue(response);
    let failure: unknown; try { await systemRecoveryClient.capabilities(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SystemRecoveryRequestError); expect(systemRecoveryErrorMessage(failure)).not.toMatch(/PRIVATE/); expect(read).not.toHaveBeenCalled();
  });
  it("bounds successful JSON metadata and cancels an oversized response before parsing", async () => {
    const cancel = vi.fn(); let sent = false;
    mock().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(1024 * 1024 + 1)); } }, cancel,
    }), { headers: { "content-type": "application/json" } }));
    await expect(systemRecoveryClient.capabilities()).rejects.toThrow("Invalid system recovery response."); expect(cancel).toHaveBeenCalledOnce();
  });
  it("recognizes only the exact checked absent request envelope and keeps lookup GET-only", async () => {
    mock().mockResolvedValue(json({ schema: "system-recovery-request-absent/1", requestId: backup.requestId }, 404));
    await expect(systemRecoveryClient.readRequest(backup.requestId)).rejects.toBeInstanceOf(SystemRecoveryRequestMissingError);
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]).toEqual([`${base}/requests/backup-request`, expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error" })]);
  });
  it.each([
    ["generic JSON", () => json({}, 404)],
    ["wrong request", () => json({ schema: "system-recovery-request-absent/1", requestId: "other-request" }, 404)],
    ["unknown fields", () => json({ schema: "system-recovery-request-absent/1", requestId: backup.requestId, private: true }, 404)],
    ["wrong schema", () => json({ schema: "other/1", requestId: backup.requestId }, 404)],
    ["HTML fallback", () => new Response("PRIVATE_HTML", { status: 404, headers: { "content-type": "text/html" } })],
    ["malformed JSON", () => new Response("{", { status: 404, headers: { "content-type": "application/json" } })],
    ["typed body on 409", () => json({ schema: "system-recovery-request-absent/1", requestId: backup.requestId }, 409)],
    ["typed body on 403", () => json({ schema: "system-recovery-request-absent/1", requestId: backup.requestId }, 403)],
  ] as const)("does not treat %s as authoritative absence", async (_label, response) => {
    mock().mockResolvedValue(response());
    await expect(systemRecoveryClient.readRequest(backup.requestId)).rejects.not.toBeInstanceOf(SystemRecoveryRequestMissingError);
    expect(network).toHaveBeenCalledOnce();
  });
  it("does not reinterpret maintenance or source resume 404s as a job request absence", async () => {
    mock().mockResolvedValue(json({ schema: "system-recovery-request-absent/1", requestId: "request" }, 404));
    await expect(systemRecoveryClient.readMaintenanceRequest("request")).rejects.not.toBeInstanceOf(SystemRecoveryRequestMissingError);
    await expect(systemRecoveryClient.readSourceResumeRequest("request")).rejects.not.toBeInstanceOf(SystemRecoveryRequestMissingError);
  });

});
