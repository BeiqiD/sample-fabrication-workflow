import type { FilePurpose } from "./files";

export const FILE_JOB_MAX_FILES = 100;
export const FILE_JOB_MAX_ATTEMPTS = 5;
export const FILE_JOB_MAX_BYTES = 100 * 1024 * 1024;
export const FILE_JOB_STEP_MS = 60_000;
export const FILE_JOB_LEASE_MS = 15 * 60_000;
export const FILE_JOB_SOURCE_GRACE_MS = 15 * 60_000;
export const FILE_JOB_HEARTBEAT_STALE_MS = 5 * 60_000;
export type FileJobState = "queued" | "running" | "paused" | "cancel_requested" | "completed" | "cancelled";
export type FileJobItemState = "pending" | "copying" | "moved" | "stale" | "failed" | "cancelled";
export interface FileJobTarget { profileId: string; configurationRevision: number }
export interface AcceptFileMigrationInput {
  requestId: string;
  fileIds: string[];
  target: FileJobTarget;
}
export interface FileMigrationPlanItem {
  fileId: string; purpose: FilePurpose; sourceLocationId: string; sourceProfileId: string;
  byteSize: number; sha256: string; status: "eligible" | "same_profile" | "unsupported_size";
}
export interface FileMigrationPlan {
  target: FileJobTarget; items: FileMigrationPlanItem[];
  bytes: number; retainedSourceBytes: number; stagingBytes: number; transferAndVerificationBytes: number;
  maxTransferAndVerificationBytes: number; maxAttemptsPerFile: 5;
  bytesVerified: false;
}
export interface FileJobStatus {
  id: string; actor: string; state: FileJobState; target: FileJobTarget;
  acceptedAt: string; updatedAt: string; reason: string | null;
  moved: number; remaining: number; failed: number; cleanupPending: number;
}
export interface FileJobExecutorStatus {
  enabled: boolean; lastHeartbeatAt: string | null; stale: boolean;
  cadenceSeconds: 120; maxFilesPerStep: 1; maxStepMs: 60000;
}
export interface FileMigrationInventory {
  items: { fileId: string; purpose: FilePurpose; byteSize: number; sha256: string; profileId: string; locationId: string }[];
  nextCursor: string | null;
}
export interface FileMigrationItemStatus {
  fileId: string; purpose: FilePurpose; state: FileJobItemState; reason: string | null;
  sourceLocationId: string; sourceProfileId: string; destinationLocationId: string | null;
  byteSize: number; sha256: string;
  attempt: { id: string; state: string; settled: boolean } | null;
  attemptState: string | null;
  attemptCount: number; maxAttempts: 5;
  artifactCleanupPending: number; sourceCleanupPending: boolean;
  cleanupState: "not_requested" | "waiting_grace" | "pending" | "released_to_gc" | "deleted" | "complete";
  cleanup: { requestedAt: string | null; notBefore: string | null; releasedToGcAt: string | null; deleted: boolean };
}
export interface FileMigrationItems { items: FileMigrationItemStatus[]; hasMore: false }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid File job input");
  return value as Record<string, unknown>;
}
function id(value: unknown, maximum = 128): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\x00-\x20\x7f]/.test(value)) {
    throw new Error("Invalid File job identity");
  }
  return value;
}
function keys(row: Record<string, unknown>, names: string[]) {
  if (Object.keys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) throw new Error("Unknown or missing File job input fields");
}
export function checkedFileJobTarget(value: unknown): FileJobTarget {
  const row = object(value);
  keys(row, ["profileId", "configurationRevision"]);
  if (!Number.isSafeInteger(row.configurationRevision) || Number(row.configurationRevision) < 1) throw new Error("Invalid profile revision");
  return { profileId: id(row.profileId, 256), configurationRevision: Number(row.configurationRevision) };
}
export function checkedAcceptFileMigration(value: unknown): AcceptFileMigrationInput {
  const row = object(value);
  keys(row, ["requestId", "fileIds", "target"]);
  if (!Array.isArray(row.fileIds) || row.fileIds.length < 1 || row.fileIds.length > FILE_JOB_MAX_FILES) throw new Error("File selection exceeds the job bound");
  const fileIds = row.fileIds.map(value => id(value, 256)).sort();
  if (new Set(fileIds).size !== fileIds.length) throw new Error("Duplicate File selection");
  return { requestId: id(row.requestId), fileIds, target: checkedFileJobTarget(row.target) };
}
export function checkedFileJobStatus(value: unknown): FileJobStatus {
  const row = object(value), states = ["queued", "running", "paused", "cancel_requested", "completed", "cancelled"];
  if (!states.includes(String(row.state)) || typeof row.actor !== "string" || typeof row.acceptedAt !== "string"
    || typeof row.updatedAt !== "string" || !(row.reason === null || typeof row.reason === "string")) throw new Error("Invalid File job status");
  for (const name of ["moved", "remaining", "failed", "cleanupPending"]) {
    if (!Number.isSafeInteger(row[name]) || Number(row[name]) < 0 || Number(row[name]) > FILE_JOB_MAX_FILES) throw new Error("Invalid File job count");
  }
  return { id: id(row.id), actor: row.actor, state: row.state as FileJobState, target: checkedFileJobTarget(row.target),
    acceptedAt: row.acceptedAt, updatedAt: row.updatedAt, reason: row.reason as string | null,
    moved: Number(row.moved), remaining: Number(row.remaining), failed: Number(row.failed), cleanupPending: Number(row.cleanupPending) };
}
