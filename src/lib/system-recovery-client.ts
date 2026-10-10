import {
  checkedSystemRecoveryBackupInput, checkedSystemRecoveryBackupPreview, checkedSystemRecoveryCapabilities,
  checkedSystemRecoveryCutoverInput, checkedSystemRecoveryImportInput, checkedSystemRecoveryJobControl,
  checkedSystemRecoveryJobStatus, checkedSystemRecoveryPreview, checkedSystemRecoveryReceipt,
  checkedSystemRecoveryMaintenanceInput, checkedSystemRecoveryMaintenanceReceipt, checkedSystemRecoveryMaintenanceStatus,
  checkedSystemRecoveryUploadInput, SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES,
  type SystemRecoveryBackupInput, type SystemRecoveryCutoverInput, type SystemRecoveryImportInput,
  type SystemRecoveryJobControl, type SystemRecoveryJobKind, type SystemRecoveryUploadInput,
  type SystemRecoveryMaintenanceInput,
} from "../../shared/contracts/system-recovery";

const base = "/api/system-recovery", maximumResponseBytes = 1024 * 1024;
export class SystemRecoveryRequestError extends Error {
  constructor(readonly status: number | null) {
    super(status === 401 || status === 403 ? "System administrator access is required for backup and recovery."
      : status === 409 ? "Saved work or the recovery target changed. Check the original request and refresh the recovery report."
        : status === 413 ? "This archive exceeds the supported recovery limits."
          : status === 410 ? "This output has expired. Start a new backup to download it again."
            : status === 400 || status === 422 ? "This archive, mapping or request is unsupported. Review its validation report."
              : status === 503 ? "System recovery is unavailable. Review storage, executor and isolated target configuration."
                : "The recovery response is unavailable. Check the original request before retrying.");
    this.name = "SystemRecoveryRequestError";
  }
}
export function systemRecoveryErrorMessage(error: unknown): string {
  return error instanceof SystemRecoveryRequestError ? error.message
    : "The system recovery response could not be validated. Refresh its report before continuing.";
}
function ensure(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid system recovery response."); }
function identity(value: string): string {
  ensure(typeof value === "string" && value.length > 0 && value.length <= 128 && value !== "." && value !== ".."
    && !/\s|[\x00-\x1f\x7f/\\]/.test(value));
  return encodeURIComponent(value);
}
async function readJson(response: Response): Promise<unknown> {
  ensure(/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") && response.body);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumResponseBytes) { await reader.cancel(); throw new Error("Invalid system recovery response."); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { reader.releaseLock(); }
}
async function request(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  const raw = body instanceof Blob;
  try {
    response = await fetch(`${base}${path}`, { method, credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      ...(method === "GET" ? {} : { headers: { "content-type": raw ? "application/zip" : "application/json" },
        body: raw ? body : JSON.stringify(body) }) });
  } catch { throw new SystemRecoveryRequestError(null); }
  // Provider errors, encrypted settings and archive-provided text never select
  // a public error label. Successful metadata must satisfy the exact DTO.
  if (!response.ok) throw new SystemRecoveryRequestError(response.status);
  return readJson(response);
}
function receipt(value: unknown, requestId: string, kind?: SystemRecoveryJobKind) {
  const checked = checkedSystemRecoveryReceipt(value);
  ensure(checked.requestId === requestId && (!kind || checked.job.kind === kind));
  return checked;
}
export const systemRecoveryClient = {
  async capabilities(signal?: AbortSignal) {
    return checkedSystemRecoveryCapabilities(await request("/capabilities", "GET", undefined, signal));
  },
  async backupPreview(signal?: AbortSignal) {
    return checkedSystemRecoveryBackupPreview(await request("/backup-preview", "GET", undefined, signal));
  },
  async maintenance(signal?: AbortSignal) {
    return checkedSystemRecoveryMaintenanceStatus(await request("/maintenance", "GET", undefined, signal));
  },
  async changeMaintenance(input: SystemRecoveryMaintenanceInput, signal?: AbortSignal) {
    const checked = checkedSystemRecoveryMaintenanceInput(input);
    const value = checkedSystemRecoveryMaintenanceReceipt(await request("/maintenance", "POST", checked, signal));
    ensure(value.requestId === checked.requestId && value.action === checked.action && value.expectedGeneration === checked.expectedGeneration);
    return value;
  },
  async readMaintenanceRequest(requestId: string, signal?: AbortSignal) {
    const value = checkedSystemRecoveryMaintenanceReceipt(await request(`/maintenance/requests/${identity(requestId)}`, "GET", undefined, signal));
    ensure(value.requestId === requestId); return value;
  },
  async configureExecutor(enabled: boolean, signal?: AbortSignal) {
    ensure(typeof enabled === "boolean");
    return checkedSystemRecoveryCapabilities(await request("/executor", "POST", { enabled }, signal));
  },
  async backup(input: SystemRecoveryBackupInput, signal?: AbortSignal) {
    const checked = checkedSystemRecoveryBackupInput(input);
    return receipt(await request("/jobs", "POST", checked, signal), checked.requestId, "backup");
  },
  async acceptUpload(input: SystemRecoveryUploadInput, signal?: AbortSignal) {
    const checked = checkedSystemRecoveryUploadInput(input);
    return receipt(await request("/uploads", "POST", checked, signal), checked.requestId, "upload");
  },
  async upload(jobId: string, archive: Blob, signal?: AbortSignal) {
    ensure(archive instanceof Blob && archive.size >= 22 && archive.size <= SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES);
    const job = checkedSystemRecoveryJobStatus(await request(`/jobs/${identity(jobId)}/upload`, "PUT", archive, signal));
    ensure(job.id === jobId && job.kind === "upload"); return job;
  },
  async uploadIntent(jobId: string, signal?: AbortSignal) {
    return checkedSystemRecoveryUploadInput(await request(`/jobs/${identity(jobId)}/upload-intent`, "GET", undefined, signal));
  },
  async preview(jobId: string, signal?: AbortSignal) {
    return checkedSystemRecoveryPreview(await request(`/jobs/${identity(jobId)}/preview`, "GET", undefined, signal));
  },
  async restore(input: SystemRecoveryImportInput, signal?: AbortSignal) {
    const checked = checkedSystemRecoveryImportInput(input);
    return receipt(await request("/recoveries", "POST", checked, signal), checked.requestId, "recovery");
  },
  async readRequest(requestId: string, signal?: AbortSignal) {
    return receipt(await request(`/requests/${identity(requestId)}`, "GET", undefined, signal), requestId);
  },
  async status(jobId: string, signal?: AbortSignal) {
    const job = checkedSystemRecoveryJobStatus(await request(`/jobs/${identity(jobId)}`, "GET", undefined, signal));
    ensure(job.id === jobId); return job;
  },
  async list(signal?: AbortSignal) {
    const value = await request("/jobs", "GET", undefined, signal);
    ensure(value && typeof value === "object" && !Array.isArray(value));
    const row = value as Record<string, unknown>;
    ensure(Object.keys(row).length === 1 && Array.isArray(row.jobs) && row.jobs.length <= 100);
    const jobs = row.jobs.map(checkedSystemRecoveryJobStatus);
    ensure(new Set(jobs.map(job => job.id)).size === jobs.length); return jobs;
  },
  async control(jobId: string, action: SystemRecoveryJobControl, signal?: AbortSignal) {
    const checked = checkedSystemRecoveryJobControl({ action });
    const job = checkedSystemRecoveryJobStatus(await request(`/jobs/${identity(jobId)}/control`, "POST", { action: checked }, signal));
    ensure(job.id === jobId); return job;
  },
  async cutover(jobId: string, input: SystemRecoveryCutoverInput, signal?: AbortSignal) {
    const checked = checkedSystemRecoveryCutoverInput(input);
    const value = receipt(await request(`/jobs/${identity(jobId)}/cutover`, "POST", checked, signal), checked.requestId, "recovery");
    ensure(value.job.id === jobId); return value;
  },
  downloadUrl(jobId: string) { return `${base}/jobs/${identity(jobId)}/download`; },
  reportDownloadUrl(jobId: string) { return `${base}/jobs/${identity(jobId)}/report`; },
};
