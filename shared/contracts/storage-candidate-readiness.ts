/** Safe, read-only candidate evidence. A matching recorded check does not
 * establish present connectivity or permission to activate a provider. */
export interface StorageCandidateReadinessInput { profileId: string; expectedRevision: number }
export interface StorageCandidateReadiness {
  profileId: string;
  revision: number;
  observedAt: string;
  credential: { envelopeRevision: number | null; status: "current" | "needs_reenvelope" | "unavailable" };
  evidence: {
    currentConfigurationSuccessCount: number;
    historicalConfigurationSuccessCount: number;
    exactCurrentContextSuccess: null | { checkId: string; completedAt: string };
    inProgressCount: number;
    unresolvedCleanupCount: number;
  };
  canActivate: false;
}
export class StorageCandidateReadinessInputError extends Error {
  constructor() { super("Invalid storage candidate readiness."); this.name = "StorageCandidateReadinessInputError"; }
}
function invalid(): never { throw new StorageCandidateReadinessInputError(); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !keys.includes(key))) invalid();
  return result;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)
    || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) !== value) invalid();
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}
function timestamp(value: unknown): string {
  const result = text(value, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result))
    || new Date(result).toISOString() !== result) invalid();
  return result;
}
export function checkedStorageCandidateReadinessInput(value: unknown): StorageCandidateReadinessInput {
  const input = record(value, ["profileId", "expectedRevision"]);
  return { profileId: text(input.profileId, 256), expectedRevision: integer(input.expectedRevision, 1) };
}
export function checkedStorageCandidateReadiness(value: unknown): StorageCandidateReadiness {
  const input = record(value, ["profileId", "revision", "observedAt", "credential", "evidence", "canActivate"]);
  const credential = record(input.credential, ["envelopeRevision", "status"]);
  const evidence = record(input.evidence, ["currentConfigurationSuccessCount", "historicalConfigurationSuccessCount",
    "exactCurrentContextSuccess", "inProgressCount", "unresolvedCleanupCount"]);
  if (input.canActivate !== false || !["current", "needs_reenvelope", "unavailable"].includes(credential.status as string)
    || credential.envelopeRevision === null && credential.status !== "unavailable") invalid();
  let exact: StorageCandidateReadiness["evidence"]["exactCurrentContextSuccess"] = null;
  if (evidence.exactCurrentContextSuccess !== null) {
    const item = record(evidence.exactCurrentContextSuccess, ["checkId", "completedAt"]);
    const checkId = text(item.checkId, 36);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkId)) invalid();
    exact = { checkId: checkId.toLowerCase(), completedAt: timestamp(item.completedAt) };
  }
  const result: StorageCandidateReadiness = {
    profileId: text(input.profileId, 256), revision: integer(input.revision, 1), observedAt: timestamp(input.observedAt),
    credential: { envelopeRevision: credential.envelopeRevision === null ? null : integer(credential.envelopeRevision, 1),
      status: credential.status as StorageCandidateReadiness["credential"]["status"] },
    evidence: { currentConfigurationSuccessCount: integer(evidence.currentConfigurationSuccessCount, 0),
      historicalConfigurationSuccessCount: integer(evidence.historicalConfigurationSuccessCount, 0),
      exactCurrentContextSuccess: exact, inProgressCount: integer(evidence.inProgressCount, 0),
      unresolvedCleanupCount: integer(evidence.unresolvedCleanupCount, 0) }, canActivate: false,
  };
  if (exact && (result.credential.envelopeRevision === null || !result.evidence.currentConfigurationSuccessCount
    || exact.completedAt > result.observedAt)) invalid();
  return result;
}
