/** Safe administrator-visible evidence. Protected provider context stays server-side. */
export const MAX_STORAGE_CHECK_INPUT_BYTES = 4096;
export const MAX_STORAGE_CANDIDATE_CHECKS = 50;
export const STORAGE_CANDIDATE_CHECK_CODES = [
  "credential_unavailable", "provider_unavailable", "read_verification_failed",
  "metadata_verification_failed", "cleanup_unconfirmed", "execution_interrupted",
] as const;
export type StorageCandidateCheckCode = typeof STORAGE_CANDIDATE_CHECK_CODES[number];
export type StorageCandidateCheckStatus = "running" | "succeeded" | "failed" | "interrupted";
export type StorageCandidateCheckStage = "pending" | "passed" | "failed" | "unknown" | "not_run";
export type StorageCandidateCheckCleanup = "pending" | "running" | "required" | "confirmed_absent" | "absence_observed";
export interface StartStorageCandidateCheckInput { checkId: string; profileId: string; expectedRevision: number }
export interface StorageCandidateCheck {
  id: string;
  profileId: string;
  revision: number;
  status: StorageCandidateCheckStatus;
  write: StorageCandidateCheckStage;
  read: StorageCandidateCheckStage;
  metadata: StorageCandidateCheckStage;
  delete: StorageCandidateCheckStage;
  cleanup: StorageCandidateCheckCleanup;
  code: StorageCandidateCheckCode | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface StorageCandidateCheckList { items: StorageCandidateCheck[]; hasMore: boolean }
export class StorageCandidateCheckInputError extends Error {
  constructor() { super("Invalid storage candidate check."); this.name = "StorageCandidateCheckInputError"; }
}
function invalid(): never { throw new StorageCandidateCheckInputError(); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !keys.includes(key))) invalid();
  return result;
}
function safeText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)
    || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) !== value) invalid();
  return value;
}
export function checkedStorageCandidateCheckId(value: unknown): string {
  const id = safeText(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) invalid();
  return id.toLowerCase();
}
export function checkedStorageCandidateCheckProfileId(value: unknown): string { return safeText(value, 256); }
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}
function timestamp(value: unknown): string {
  const result = safeText(value, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result))
    || new Date(result).toISOString() !== result) invalid();
  return result;
}
function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}
export function checkedStartStorageCandidateCheckInput(value: unknown): StartStorageCandidateCheckInput {
  const input = record(value, ["checkId", "profileId", "expectedRevision"]);
  const result = { checkId: checkedStorageCandidateCheckId(input.checkId), profileId: checkedStorageCandidateCheckProfileId(input.profileId), expectedRevision: revision(input.expectedRevision) };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_STORAGE_CHECK_INPUT_BYTES) invalid();
  return result;
}
export function checkedStorageCandidateCheckCleanupInput(value: unknown): Record<string, never> { record(value, []); return {}; }
export function checkedStorageCandidateCheck(value: unknown): StorageCandidateCheck {
  const input = record(value, ["id", "profileId", "revision", "status", "write", "read", "metadata", "delete", "cleanup", "code", "createdAt", "updatedAt", "completedAt"]);
  const stage = (value: unknown) => enumValue(value, ["pending", "passed", "failed", "unknown", "not_run"] as const);
  const result: StorageCandidateCheck = {
    id: checkedStorageCandidateCheckId(input.id), profileId: checkedStorageCandidateCheckProfileId(input.profileId), revision: revision(input.revision),
    status: enumValue(input.status, ["running", "succeeded", "failed", "interrupted"] as const),
    write: stage(input.write), read: stage(input.read), metadata: stage(input.metadata), delete: stage(input.delete),
    cleanup: enumValue(input.cleanup, ["pending", "running", "required", "confirmed_absent", "absence_observed"] as const),
    code: input.code === null ? null : enumValue(input.code, STORAGE_CANDIDATE_CHECK_CODES),
    createdAt: timestamp(input.createdAt), updatedAt: timestamp(input.updatedAt), completedAt: input.completedAt === null ? null : timestamp(input.completedAt),
  };
  if (result.updatedAt < result.createdAt || result.completedAt !== null && (result.completedAt < result.createdAt || result.completedAt > result.updatedAt)
    || (result.status === "running") !== (result.completedAt === null) || result.cleanup === "running" && result.status === "running"
    || result.write === "unknown" && result.cleanup === "confirmed_absent"
    || result.status === "succeeded" && (result.write !== "passed" || result.read !== "passed" || result.metadata !== "passed"
      || result.delete !== "passed" || result.cleanup !== "confirmed_absent" || result.code !== null)) invalid();
  return result;
}
export function checkedStorageCandidateCheckList(value: unknown): StorageCandidateCheckList {
  const input = record(value, ["items", "hasMore"]);
  if (!Array.isArray(input.items) || input.items.length > MAX_STORAGE_CANDIDATE_CHECKS || typeof input.hasMore !== "boolean") invalid();
  const items = input.items.map(checkedStorageCandidateCheck);
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  return { items, hasMore: input.hasMore };
}
