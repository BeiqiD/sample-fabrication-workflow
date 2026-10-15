import { describe, expect, it } from "vitest";
import { checkedStorageCandidateReadiness, checkedStorageCandidateReadinessInput, StorageCandidateReadinessInputError } from "./storage-candidate-readiness";
const input = { profileId: "external:profile", expectedRevision: 1 };
const report = { profileId: input.profileId, revision: 1, observedAt: "2026-10-02T00:00:00.000Z",
  credential: { envelopeRevision: 1, status: "current" }, evidence: { currentConfigurationSuccessCount: 1,
    historicalConfigurationSuccessCount: 60, exactCurrentContextSuccess: { checkId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", completedAt: "2026-10-01T00:00:00.000Z" },
    inProgressCount: 0, unresolvedCleanupCount: 2 }, canActivate: false };
describe("safe storage candidate readiness contract", () => {
  it("validates exact inputs and safe integer revisions", () => {
    expect(checkedStorageCandidateReadinessInput(input)).toEqual(input);
    for (const value of [null, [], { ...input, ignored: true }, { profileId: input.profileId },
      ...[0, -1, 1.5, "1", Infinity, Number.MAX_SAFE_INTEGER + 1].map(expectedRevision => ({ ...input, expectedRevision })),
      ...["", "p\0", "\ud800", "p".repeat(257)].map(profileId => ({ ...input, profileId }))])
      expect(() => checkedStorageCandidateReadinessInput(value)).toThrow(StorageCandidateReadinessInputError);
  });
  it("keeps recorded evidence independent of credential availability, with canonical check identities", () => {
    expect(checkedStorageCandidateReadiness(report).evidence.exactCurrentContextSuccess?.checkId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(checkedStorageCandidateReadiness({ ...report, credential: { envelopeRevision: 1, status: "unavailable" } }).evidence.currentConfigurationSuccessCount).toBe(1);
    expect(checkedStorageCandidateReadiness({ ...report, credential: { envelopeRevision: null, status: "unavailable" },
      evidence: { ...report.evidence, currentConfigurationSuccessCount: 0, exactCurrentContextSuccess: null } }).canActivate).toBe(false);
    expect(checkedStorageCandidateReadiness({ ...report, credential: { envelopeRevision: 2, status: "needs_reenvelope" } }).credential.status).toBe("needs_reenvelope");
  });
  it("rejects secret-bearing, malformed and inconsistent reports at every nesting level", () => {
    const invalid = [
      { ...report, ciphertext: "secret" }, { ...report, canActivate: true },
      { ...report, credential: { ...report.credential, keyId: "secret" } },
      { ...report, credential: { envelopeRevision: null, status: "current" } },
      { ...report, credential: { envelopeRevision: null, status: "unavailable" } },
      { ...report, credential: { envelopeRevision: 0, status: "unavailable" } },
      { ...report, credential: { envelopeRevision: 1, status: "connected" } },
      { ...report, evidence: { ...report.evidence, provider: "secret" } },
      { ...report, evidence: { ...report.evidence, currentConfigurationSuccessCount: 0 } },
      { ...report, evidence: { ...report.evidence, exactCurrentContextSuccess: { ...report.evidence.exactCurrentContextSuccess, probeKey: "secret" } } },
      { ...report, evidence: { ...report.evidence, exactCurrentContextSuccess: { checkId: "invalid", completedAt: report.observedAt } } },
      ...["2026-02-30T00:00:00.000Z", "2026-10-02T00:00:00Z", "2026-10-02T02:00:00.000+02:00"].map(observedAt => ({ ...report, observedAt })),
      { ...report, evidence: { ...report.evidence, exactCurrentContextSuccess: { checkId: report.evidence.exactCurrentContextSuccess.checkId, completedAt: "2026-10-03T00:00:00.000Z" } } },
    ];
    for (const key of ["currentConfigurationSuccessCount", "historicalConfigurationSuccessCount", "inProgressCount", "unresolvedCleanupCount"])
      for (const value of [-1, 1.5, "2", NaN, Number.MAX_SAFE_INTEGER + 1])
        invalid.push({ ...report, evidence: { ...report.evidence, [key]: value } } as typeof report);
    for (const value of invalid) expect(() => checkedStorageCandidateReadiness(value)).toThrow(StorageCandidateReadinessInputError);
  });
});
