import { checkedStorageCandidateCheckId } from "./storage-candidate-check";
import { checkedExternalStorageNamespace } from "./storage-configuration";

export const MAX_STORAGE_PROFILE_ADMISSION_INPUT_BYTES = 4096;

export interface NativeS3Namespace {
  kind: "aws-s3";
  partition: "aws";
  accountId: string;
  bucketName: string;
  root: string;
}
export interface StorageProfileAdmissionInput {
  operationId: string;
  profileId: string;
  expectedRevision: number;
  expectedEnvelopeRevision: number;
  checkId: string;
}
export interface StorageProfileAdmissionReceipt {
  operationId: string;
  profileId: string;
  revision: number;
  envelopeRevision: number;
  checkId: string;
  nativeProfileId: string;
  configurationRevision: 1;
  runtimeAccess: "read_only";
  createdAt: string;
  createdBy: string;
}
export class StorageProfileAdmissionInputError extends Error {
  constructor() { super("Invalid storage profile admission."); this.name = "StorageProfileAdmissionInputError"; }
}
function invalid(): never { throw new StorageProfileAdmissionInputError(); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) invalid();
  return item;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)
    || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) !== value) invalid();
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}
export function checkedStorageProfileAdmissionOperationId(value: unknown): string {
  try { return checkedStorageCandidateCheckId(value); } catch { return invalid(); }
}

/** Native identity includes the asserted bucket owner. Endpoint, region and
 * addressing mode remain frozen transport configuration, not physical identity.
 * This admission slice supports only commercial AWS, never other partitions. */
export function awsS3NativeNamespace(value: unknown): string {
  try {
    const namespace = checkedExternalStorageNamespace(value);
    if (namespace.kind !== "s3" || !namespace.expectedBucketOwner
      || /^(?:cn-|us-gov-)|(?:^|-)iso[a-z]*-/.test(namespace.region)) return invalid();
    const identity = JSON.stringify({ kind: "aws-s3", partition: "aws", accountId: namespace.expectedBucketOwner,
      bucketName: namespace.bucket, root: namespace.root } satisfies NativeS3Namespace);
    if (identity.length > 2048) return invalid();
    return identity;
  } catch { return invalid(); }
}
export function checkedNativeS3Namespace(value: unknown): NativeS3Namespace {
  const item = record(value, ["kind", "partition", "accountId", "bucketName", "root"]);
  if (item.kind !== "aws-s3" || item.partition !== "aws") return invalid();
  // Reuse the bounded AWS bucket/root/account grammar without inferring a
  // transport region from a portable identity.
  const canonical = awsS3NativeNamespace({ kind: "s3", endpoint: "https://s3.amazonaws.com", region: "us-east-1",
    expectedBucketOwner: item.accountId, bucket: item.bucketName, root: item.root, forcePathStyle: true });
  return JSON.parse(canonical) as NativeS3Namespace;
}
export function canonicalNativeS3Namespace(value: unknown): string {
  return JSON.stringify(checkedNativeS3Namespace(value));
}
export function checkedStorageProfileAdmissionInput(value: unknown): StorageProfileAdmissionInput {
  const item = record(value, ["operationId", "profileId", "expectedRevision", "expectedEnvelopeRevision", "checkId"]);
  const result = { operationId: checkedStorageProfileAdmissionOperationId(item.operationId), profileId: text(item.profileId, 256),
    expectedRevision: revision(item.expectedRevision), expectedEnvelopeRevision: revision(item.expectedEnvelopeRevision),
    checkId: checkedStorageProfileAdmissionOperationId(item.checkId) };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_STORAGE_PROFILE_ADMISSION_INPUT_BYTES) invalid();
  return result;
}
export function checkedStorageProfileAdmissionReceipt(value: unknown): StorageProfileAdmissionReceipt {
  const item = record(value, ["operationId", "profileId", "revision", "envelopeRevision", "checkId", "nativeProfileId",
    "configurationRevision", "runtimeAccess", "createdAt", "createdBy"]);
  const nativeProfileId = text(item.nativeProfileId, 256), createdAt = text(item.createdAt, 24);
  if (!/^storage-profile:aws-s3:[0-9a-f]{64}$/.test(nativeProfileId) || item.configurationRevision !== 1
    || item.runtimeAccess !== "read_only" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt)
    || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return invalid();
  return { operationId: checkedStorageProfileAdmissionOperationId(item.operationId), profileId: text(item.profileId, 256),
    revision: revision(item.revision), envelopeRevision: revision(item.envelopeRevision),
    checkId: checkedStorageProfileAdmissionOperationId(item.checkId), nativeProfileId, configurationRevision: 1,
    runtimeAccess: "read_only", createdAt, createdBy: text(item.createdBy, 254) };
}
