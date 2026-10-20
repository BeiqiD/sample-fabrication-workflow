/** Administrator-visible wrapping status and immutable receipts. Encryption
 * key IDs, key material and protected credential envelopes stay server-side. */
export const MAX_STORAGE_CREDENTIAL_REENVELOPE_INPUT_BYTES = 4096;
export const MAX_STORAGE_CREDENTIAL_ENVELOPES = 100;
export type StorageCredentialEnvelopeStatus = "current" | "needs_reenvelope" | "unavailable";
export interface StorageCredentialEnvelopeMetadata {
  profileId: string;
  revision: number;
  credentialRef: string;
  envelopeRevision: number | null;
  isCurrentCandidate: boolean;
  status: StorageCredentialEnvelopeStatus;
}
export interface StorageCredentialEnvelopeList { items: StorageCredentialEnvelopeMetadata[]; hasMore: boolean }
export interface ReenvelopeStorageCredentialInput {
  operationId: string;
  profileId: string;
  revision: number;
  credentialRef: string;
  expectedEnvelopeRevision: number;
}
export interface StorageCredentialReenvelopeReceipt {
  operationId: string;
  profileId: string;
  revision: number;
  credentialRef: string;
  previousEnvelopeRevision: number;
  envelopeRevision: number;
  outcome: "reenveloped" | "already_current";
  createdAt: string;
  createdBy: string;
}
export class StorageCredentialReenvelopeInputError extends Error {
  constructor() { super("Invalid storage credential re-envelope."); this.name = "StorageCredentialReenvelopeInputError"; }
}
function invalid(): never { throw new StorageCredentialReenvelopeInputError(); }
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
export function checkedStorageCredentialReenvelopeOperationId(value: unknown): string {
  const id = safeText(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) invalid();
  return id.toLowerCase();
}
export function checkedStorageCredentialEnvelopeProfileId(value: unknown): string { return safeText(value, 256); }
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
export function checkedStorageCredentialEnvelopeMetadata(value: unknown): StorageCredentialEnvelopeMetadata {
  const input = record(value, ["profileId", "revision", "credentialRef", "envelopeRevision", "isCurrentCandidate", "status"]);
  if (typeof input.isCurrentCandidate !== "boolean" || !["current", "needs_reenvelope", "unavailable"].includes(input.status as string)
    || input.envelopeRevision === null && input.status !== "unavailable") invalid();
  return {
    profileId: checkedStorageCredentialEnvelopeProfileId(input.profileId), revision: revision(input.revision), credentialRef: safeText(input.credentialRef, 256),
    envelopeRevision: input.envelopeRevision === null ? null : revision(input.envelopeRevision), isCurrentCandidate: input.isCurrentCandidate,
    status: input.status as StorageCredentialEnvelopeStatus,
  };
}
export function checkedStorageCredentialEnvelopeList(value: unknown): StorageCredentialEnvelopeList {
  const input = record(value, ["items", "hasMore"]);
  if (!Array.isArray(input.items) || input.items.length > MAX_STORAGE_CREDENTIAL_ENVELOPES || typeof input.hasMore !== "boolean") invalid();
  const items = input.items.map(checkedStorageCredentialEnvelopeMetadata);
  if (new Set(items.map(item => item.credentialRef)).size !== items.length
    || new Set(items.map(item => item.profileId)).size > 1 || items.filter(item => item.isCurrentCandidate).length > 1) invalid();
  return { items, hasMore: input.hasMore };
}
export function checkedReenvelopeStorageCredentialInput(value: unknown): ReenvelopeStorageCredentialInput {
  const input = record(value, ["operationId", "profileId", "revision", "credentialRef", "expectedEnvelopeRevision"]);
  const result: ReenvelopeStorageCredentialInput = {
    operationId: checkedStorageCredentialReenvelopeOperationId(input.operationId), profileId: checkedStorageCredentialEnvelopeProfileId(input.profileId),
    revision: revision(input.revision), credentialRef: safeText(input.credentialRef, 256), expectedEnvelopeRevision: revision(input.expectedEnvelopeRevision),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_STORAGE_CREDENTIAL_REENVELOPE_INPUT_BYTES) invalid();
  return result;
}
export function checkedStorageCredentialReenvelopeReceipt(value: unknown): StorageCredentialReenvelopeReceipt {
  const input = record(value, ["operationId", "profileId", "revision", "credentialRef", "previousEnvelopeRevision", "envelopeRevision", "outcome", "createdAt", "createdBy"]);
  if (input.outcome !== "reenveloped" && input.outcome !== "already_current") invalid();
  const result: StorageCredentialReenvelopeReceipt = {
    operationId: checkedStorageCredentialReenvelopeOperationId(input.operationId), profileId: checkedStorageCredentialEnvelopeProfileId(input.profileId),
    revision: revision(input.revision), credentialRef: safeText(input.credentialRef, 256), previousEnvelopeRevision: revision(input.previousEnvelopeRevision),
    envelopeRevision: revision(input.envelopeRevision), outcome: input.outcome, createdAt: timestamp(input.createdAt), createdBy: safeText(input.createdBy, 254),
  };
  if (result.envelopeRevision !== result.previousEnvelopeRevision + (result.outcome === "reenveloped" ? 1 : 0)) invalid();
  return result;
}
