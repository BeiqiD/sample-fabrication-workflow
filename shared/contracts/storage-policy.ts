export interface NativeStorageActivationInput {
  operationId: string;
  nativeProfileId: string;
  candidateProfileId: string;
  expectedCandidateRevision: number;
  expectedEnvelopeRevision: number;
  checkId: string;
  expectedBindingRevision: number | null;
}
export interface NativeStorageActivationReceipt {
  operationId: string; nativeProfileId: string; candidateProfileId: string;
  candidateRevision: number; envelopeRevision: number; checkId: string;
  bindingRevision: number; createdAt: string; createdBy: string;
}
export interface StorageRolePolicyInput {
  operationId: string; expectedPolicyRevision: number | null;
  internalProfileId: string; originalsProfileId: string;
}
export interface StorageRolePolicyReceipt {
  operationId: string; policyRevision: number; internalProfileId: string;
  originalsProfileId: string; createdAt: string; createdBy: string;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error("Invalid storage policy input.");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || value.includes("\0")) throw new Error("Invalid storage policy input.");
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid storage policy input.");
  return value;
}
export function checkedNativeStorageActivationInput(value: unknown): NativeStorageActivationInput {
  const v = object(value, ["operationId", "nativeProfileId", "candidateProfileId", "expectedCandidateRevision", "expectedEnvelopeRevision", "checkId", "expectedBindingRevision"]);
  const checkId = id(v.checkId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(checkId)) throw new Error("Invalid storage policy input.");
  return { operationId: id(v.operationId), nativeProfileId: id(v.nativeProfileId), candidateProfileId: id(v.candidateProfileId),
    expectedCandidateRevision: revision(v.expectedCandidateRevision), expectedEnvelopeRevision: revision(v.expectedEnvelopeRevision), checkId,
    expectedBindingRevision: v.expectedBindingRevision === null ? null : revision(v.expectedBindingRevision) };
}
export function checkedStorageRolePolicyInput(value: unknown): StorageRolePolicyInput {
  const v = object(value, ["operationId", "expectedPolicyRevision", "internalProfileId", "originalsProfileId"]);
  const expectedPolicyRevision = v.expectedPolicyRevision === null ? null : revision(v.expectedPolicyRevision);
  if (expectedPolicyRevision !== null && expectedPolicyRevision < 2) throw new Error("Invalid storage policy input.");
  return { operationId: id(v.operationId), expectedPolicyRevision, internalProfileId: id(v.internalProfileId), originalsProfileId: id(v.originalsProfileId) };
}
function timestamp(value: unknown): string {
  const text = id(value);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw new Error("Invalid storage policy receipt.");
  return text;
}
export function checkedNativeStorageActivationReceipt(value: unknown): NativeStorageActivationReceipt {
  const v = object(value, ["operationId", "nativeProfileId", "candidateProfileId", "candidateRevision", "envelopeRevision", "checkId", "bindingRevision", "createdAt", "createdBy"]);
  const input = checkedNativeStorageActivationInput({ operationId: v.operationId, nativeProfileId: v.nativeProfileId, candidateProfileId: v.candidateProfileId,
    expectedCandidateRevision: v.candidateRevision, expectedEnvelopeRevision: v.envelopeRevision, checkId: v.checkId, expectedBindingRevision: null });
  return { operationId: input.operationId, nativeProfileId: input.nativeProfileId, candidateProfileId: input.candidateProfileId,
    candidateRevision: input.expectedCandidateRevision, envelopeRevision: input.expectedEnvelopeRevision, checkId: input.checkId,
    bindingRevision: revision(v.bindingRevision), createdAt: timestamp(v.createdAt), createdBy: id(v.createdBy) };
}
export function checkedStorageRolePolicyReceipt(value: unknown): StorageRolePolicyReceipt {
  const v = object(value, ["operationId", "policyRevision", "internalProfileId", "originalsProfileId", "createdAt", "createdBy"]);
  const input = checkedStorageRolePolicyInput({ operationId: v.operationId, expectedPolicyRevision: null,
    internalProfileId: v.internalProfileId, originalsProfileId: v.originalsProfileId });
  const policyRevision = revision(v.policyRevision);
  if (policyRevision < 3) throw new Error("Invalid storage policy receipt.");
  return { operationId: input.operationId, policyRevision, internalProfileId: input.internalProfileId, originalsProfileId: input.originalsProfileId,
    createdAt: timestamp(v.createdAt), createdBy: id(v.createdBy) };
}
