import { sha256Hex, stableJson } from "../domain/content-addressing";

/** A withdrawal seals this exact request ID without asserting any source state.
 * Historical typed keys are preserved byte-for-byte, including empty/NUL text. */
export interface ShadowWithdrawalRequest {
  operationId: string;
  key: { consumerKind: string; consumerId: string; consumerSubId: string; fileSlot: string };
  expectedBaselineSha256: string;
  destinationProfile: { profileId: string; configurationRevision: 1 };
  runtimeIncarnation: string;
}

export const FILE_SHADOW_WITHDRAWAL_EXPORT_COLUMNS = {
  file_shadow_withdrawals: ["operation_id", "request_json", "request_sha256", "created_by", "created_at"],
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
function invalid(): never { throw new Error("Invalid File shadow withdrawal request"); }
function object(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort(), expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) invalid();
  return value as Record<string, unknown>;
}

export function checkedShadowWithdrawalRequest(value: unknown): ShadowWithdrawalRequest {
  const input = object(value, ["operationId", "key", "expectedBaselineSha256", "destinationProfile", "runtimeIncarnation"]);
  const key = object(input.key, ["consumerKind", "consumerId", "consumerSubId", "fileSlot"]);
  const profile = object(input.destinationProfile, ["profileId", "configurationRevision"]);
  if (typeof input.operationId !== "string" || !UUID.test(input.operationId)
    || typeof input.runtimeIncarnation !== "string" || !UUID.test(input.runtimeIncarnation)
    || typeof input.expectedBaselineSha256 !== "string" || !SHA.test(input.expectedBaselineSha256)
    || Object.values(key).some((part) => typeof part !== "string")
    || encoder.encode(stableJson(key)).length > 64 * 1024
    || typeof profile.profileId !== "string" || !profile.profileId || profile.profileId.length > 256
    || profile.profileId.includes("\0") || profile.configurationRevision !== 1) invalid();
  const result: ShadowWithdrawalRequest = {
    operationId: input.operationId,
    key: { consumerKind: key.consumerKind as string, consumerId: key.consumerId as string,
      consumerSubId: key.consumerSubId as string, fileSlot: key.fileSlot as string },
    expectedBaselineSha256: input.expectedBaselineSha256,
    destinationProfile: { profileId: profile.profileId, configurationRevision: 1 },
    runtimeIncarnation: input.runtimeIncarnation,
  };
  if (encoder.encode(stableJson(result)).length > 80 * 1024) invalid();
  return result;
}

export async function shadowWithdrawalRequestSha256(input: ShadowWithdrawalRequest): Promise<string> {
  return sha256Hex(stableJson(checkedShadowWithdrawalRequest(input)));
}
