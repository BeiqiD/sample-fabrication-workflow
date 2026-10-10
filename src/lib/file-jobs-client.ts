import { checkedAcceptFileMigration, checkedFileJobStatus, checkedFileJobTarget, FILE_JOB_MAX_ATTEMPTS, FILE_JOB_MAX_BYTES, FILE_JOB_MAX_FILES,
  type AcceptFileMigrationInput, type FileJobExecutorStatus, type FileJobStatus, type FileMigrationPlan,
  type FileMigrationItems } from "../../shared/contracts/file-jobs";
import type { FilePurpose } from "../../shared/contracts/files";

export interface MigratableFile { fileId: string; purpose: FilePurpose; byteSize: number; sha256: string; profileId: string; locationId: string }
export interface MigrationInventory { items: MigratableFile[]; nextCursor: string | null }
export class FileMigrationRequestError extends Error {
  constructor(readonly status: number | null) {
    super(status === 403 ? "System administrator access is required to manage File migrations."
      : status === 409 ? "The migration request could not be confirmed. Refresh its plan or retry the original accepted request."
        : "File migration request is unavailable. Try again using the original request.");
  }
}
export function fileMigrationErrorMessage(error: unknown): string {
  return error instanceof FileMigrationRequestError ? error.message : "File migration operation is unavailable. Refresh and try again.";
}
async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/files/migrations${path}`, { method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  } catch { throw new FileMigrationRequestError(null); }
  // Provider and server exception bodies can contain private configuration.
  if (!response.ok) throw new FileMigrationRequestError(response.status);
  try { return await response.json(); } catch { throw new Error("Invalid File migration response."); }
}
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function record(value: unknown, names: string[], message: string): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), message);
  const row = value as Record<string, unknown>;
  ensure(Object.keys(row).length === names.length && names.every(name => Object.hasOwn(row, name)), message);
  return row;
}
const identity = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
const purpose = (value: unknown) => ["research_source", "provenance", "embedded_content", "derived_preview", "job_output"].includes(String(value));
const byteSize = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableTimestamp = (value: unknown) => value === null || timestamp(value);
const reason = (value: unknown) => value === null || typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value);
function job(value: unknown): FileJobStatus {
  const message = "Invalid File job status.", row = record(value,
    ["id", "actor", "state", "target", "acceptedAt", "updatedAt", "reason", "moved", "remaining", "failed", "cleanupPending"], message);
  const checked = checkedFileJobStatus(row);
  ensure(timestamp(checked.acceptedAt) && timestamp(checked.updatedAt) && reason(checked.reason)
    && checked.moved + checked.remaining + checked.failed <= FILE_JOB_MAX_FILES, message);
  return checked;
}
function executor(value: unknown): FileJobExecutorStatus {
  const message = "Invalid executor status.", row = record(value,
    ["enabled", "stale", "cadenceSeconds", "maxFilesPerStep", "maxStepMs", "lastHeartbeatAt"], message);
  ensure(typeof row.enabled === "boolean" && typeof row.stale === "boolean" && row.cadenceSeconds === 120
    && row.maxFilesPerStep === 1 && row.maxStepMs === 60000 && nullableTimestamp(row.lastHeartbeatAt), message);
  return row as unknown as FileJobExecutorStatus;
}
export const fileJobsClient = {
  async items(id: string, signal?: AbortSignal): Promise<FileMigrationItems> {
    ensure(identity(id), "Invalid File job identity.");
    const message = "Invalid File job details.", value = record(await request(`/${encodeURIComponent(id)}/items`, undefined, signal), ["items", "hasMore"], message);
    ensure(Array.isArray(value.items) && value.items.length <= FILE_JOB_MAX_FILES && value.hasMore === false, message);
    const seen = new Set<string>();
    for (const valueItem of value.items) {
      const item = record(valueItem, ["fileId", "purpose", "state", "reason", "sourceLocationId", "sourceProfileId", "destinationLocationId",
        "byteSize", "sha256", "attempt", "attemptState", "attemptCount", "maxAttempts", "artifactCleanupPending", "sourceCleanupPending", "cleanupState", "cleanup"], message);
      ensure(identity(item.fileId) && !seen.has(String(item.fileId)) && purpose(item.purpose) && identity(item.sourceLocationId)
        && identity(item.sourceProfileId) && (item.destinationLocationId === null || identity(item.destinationLocationId))
        && byteSize(item.byteSize) && hash(item.sha256) && reason(item.reason)
        && Number.isSafeInteger(item.attemptCount) && Number(item.attemptCount) >= 0 && Number(item.attemptCount) <= FILE_JOB_MAX_ATTEMPTS
        && item.maxAttempts === FILE_JOB_MAX_ATTEMPTS
        && Number.isSafeInteger(item.artifactCleanupPending) && Number(item.artifactCleanupPending) >= 0
        && Number(item.artifactCleanupPending) <= Number(item.attemptCount) && typeof item.sourceCleanupPending === "boolean"
        && ["pending", "copying", "moved", "stale", "failed", "cancelled"].includes(String(item.state))
        && ["not_requested", "waiting_grace", "pending", "released_to_gc", "deleted", "complete"].includes(String(item.cleanupState)), message);
      seen.add(String(item.fileId));
      if (item.attempt === null) ensure(item.attemptState === null && item.attemptCount === 0, message);
      else {
        const attempt = record(item.attempt, ["id", "state", "settled"], message);
        ensure(identity(attempt.id) && ["staged", "write_started", "unknown", "verified", "published", "failed", "cancelled"].includes(String(attempt.state))
          && typeof attempt.settled === "boolean" && item.attemptState === attempt.state && Number(item.attemptCount) > 0, message);
      }
      const cleanup = record(item.cleanup, ["requestedAt", "notBefore", "releasedToGcAt", "deleted"], message);
      ensure(nullableTimestamp(cleanup.requestedAt) && nullableTimestamp(cleanup.notBefore) && nullableTimestamp(cleanup.releasedToGcAt)
        && typeof cleanup.deleted === "boolean" && (!cleanup.deleted || item.sourceCleanupPending === false)
        && (item.cleanupState !== "deleted" || cleanup.deleted === true && item.artifactCleanupPending === 0)
        && (item.cleanupState !== "complete" || cleanup.requestedAt !== null && item.artifactCleanupPending === 0 && item.sourceCleanupPending === false), message);
    }
    return value as unknown as FileMigrationItems;
  },
  async list(signal?: AbortSignal): Promise<FileJobStatus[]> {
    const message = "Invalid File job list.", value = record(await request("", undefined, signal), ["jobs"], message);
    ensure(Array.isArray(value.jobs) && value.jobs.length <= FILE_JOB_MAX_FILES, message);
    const jobs = value.jobs.map(job);
    ensure(new Set(jobs.map(value => value.id)).size === jobs.length, message);
    return jobs;
  },
  async inventory(cursor?: string, signal?: AbortSignal): Promise<MigrationInventory> {
    ensure(cursor === undefined || identity(cursor), "Invalid File page cursor.");
    const message = "Invalid File inventory.", value = record(await request(`/files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, signal), ["items", "nextCursor"], message);
    ensure(Array.isArray(value.items) && value.items.length <= FILE_JOB_MAX_FILES && (value.nextCursor === null || identity(value.nextCursor)), message);
    const seen = new Set<string>();
    for (const valueItem of value.items) {
      const item = record(valueItem, ["fileId", "purpose", "byteSize", "sha256", "profileId", "locationId"], message);
      ensure(identity(item.fileId) && !seen.has(String(item.fileId)) && purpose(item.purpose) && byteSize(item.byteSize)
        && hash(item.sha256) && identity(item.profileId) && identity(item.locationId), message);
      seen.add(String(item.fileId));
    }
    ensure(value.nextCursor === null || value.items.length === FILE_JOB_MAX_FILES
      && (value.items.at(-1) as MigratableFile).fileId === value.nextCursor, message);
    return value as unknown as MigrationInventory;
  },
  async plan(input: AcceptFileMigrationInput, signal?: AbortSignal): Promise<FileMigrationPlan> {
    const checked = checkedAcceptFileMigration(input), message = "Invalid File migration plan.", value = record(await request("/plans", checked, signal),
      ["target", "items", "bytes", "retainedSourceBytes", "stagingBytes", "transferAndVerificationBytes", "maxTransferAndVerificationBytes", "maxAttemptsPerFile", "bytesVerified"], message);
    const target = checkedFileJobTarget(value.target);
    ensure(value.bytesVerified === false && Array.isArray(value.items) && value.items.length === checked.fileIds.length
      && target.profileId === checked.target.profileId && target.configurationRevision === checked.target.configurationRevision, message);
    let total = 0; const seen = new Set<string>();
    for (const valueItem of value.items) {
      const item = record(valueItem, ["fileId", "purpose", "sourceLocationId", "sourceProfileId", "byteSize", "sha256", "status"], message);
      ensure(identity(item.fileId) && checked.fileIds.includes(String(item.fileId)) && !seen.has(String(item.fileId))
        && purpose(item.purpose) && identity(item.sourceLocationId) && identity(item.sourceProfileId) && byteSize(item.byteSize) && hash(item.sha256), message);
      const expected = Number(item.byteSize) > FILE_JOB_MAX_BYTES ? "unsupported_size" : item.sourceProfileId === target.profileId ? "same_profile" : "eligible";
      ensure(item.status === expected, message);
      seen.add(String(item.fileId)); total += Number(item.byteSize);
    }
    ensure(Number.isSafeInteger(total) && Number.isSafeInteger(total * 3 * FILE_JOB_MAX_ATTEMPTS) && value.bytes === total
      && value.retainedSourceBytes === total && value.stagingBytes === total * FILE_JOB_MAX_ATTEMPTS && value.transferAndVerificationBytes === total * 3
      && value.maxAttemptsPerFile === FILE_JOB_MAX_ATTEMPTS && value.maxTransferAndVerificationBytes === total * 3 * FILE_JOB_MAX_ATTEMPTS, message);
    return value as unknown as FileMigrationPlan;
  },
  async accept(input: AcceptFileMigrationInput, signal?: AbortSignal): Promise<FileJobStatus> {
    const checked = checkedAcceptFileMigration(input), value = job(await request("", checked, signal));
    ensure(value.target.profileId === checked.target.profileId && value.target.configurationRevision === checked.target.configurationRevision,
      "Invalid File migration acceptance.");
    return value;
  },
  async control(id: string, action: "pause" | "resume" | "cancel" | "retry" | "cleanup", signal?: AbortSignal) {
    ensure(identity(id) && ["pause", "resume", "cancel", "retry", "cleanup"].includes(action), "Invalid File job control.");
    const value = job(await request(`/${encodeURIComponent(id)}/${action}`, {}, signal));
    ensure(value.id === id, "Invalid File job control response."); return value;
  },
  async executor(signal?: AbortSignal) { return executor(await request("/executor", undefined, signal)); },
  async setExecutor(enabled: boolean, signal?: AbortSignal) {
    ensure(typeof enabled === "boolean", "Invalid executor input.");
    const value = executor(await request("/executor", { enabled }, signal));
    ensure(value.enabled === enabled, "Invalid executor control response."); return value;
  },
};
