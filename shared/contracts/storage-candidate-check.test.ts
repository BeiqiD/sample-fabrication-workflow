import { describe, expect, it } from "vitest";
import { checkedStartStorageCandidateCheckInput, checkedStorageCandidateCheck, checkedStorageCandidateCheckCleanupInput, checkedStorageCandidateCheckId, checkedStorageCandidateCheckList } from "./storage-candidate-check";
const id = "11111111-1111-4111-8111-111111111111";
const pending = { id, profileId: "external:profile", revision: 1, status: "running", write: "pending", read: "pending", metadata: "pending", delete: "pending", cleanup: "pending", code: null,
  createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", completedAt: null };
describe("safe candidate check contracts", () => {
  it("strictly validates idempotent inputs and empty cleanup intent", () => {
    expect(checkedStartStorageCandidateCheckInput({ checkId: id, profileId: "external:profile", expectedRevision: 1 })).toEqual({ checkId: id, profileId: "external:profile", expectedRevision: 1 });
    expect(checkedStorageCandidateCheckId("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    for (const value of [{ checkId: "not-a-uuid", profileId: "p", expectedRevision: 1 }, { checkId: id, profileId: "p", expectedRevision: 0 },
      { checkId: id, profileId: "p", expectedRevision: 1, key: "unsafe" }, { checkId: id, profileId: "p\u0000", expectedRevision: 1 }])
      expect(() => checkedStartStorageCandidateCheckInput(value)).toThrow("Invalid storage candidate check.");
    expect(checkedStorageCandidateCheckCleanupInput({})).toEqual({});
    expect(() => checkedStorageCandidateCheckCleanupInput({ key: "foreign-object" })).toThrow();
  });
  it("accepts safe outcome evidence and rejects protected context and impossible success", () => {
    expect(checkedStorageCandidateCheck(pending)).toEqual(pending);
    const interrupted = { ...pending, status: "interrupted", write: "unknown", read: "not_run", metadata: "not_run", delete: "passed", cleanup: "absence_observed", code: "execution_interrupted", completedAt: pending.createdAt };
    expect(checkedStorageCandidateCheck(interrupted)).toEqual(interrupted);
    expect(() => checkedStorageCandidateCheck({ ...interrupted, cleanup: "confirmed_absent" })).toThrow();
    const succeeded = { ...pending, status: "succeeded", write: "passed", read: "passed", metadata: "passed", delete: "passed", cleanup: "confirmed_absent", completedAt: pending.createdAt };
    expect(checkedStorageCandidateCheck(succeeded)).toEqual(succeeded);
    expect(checkedStorageCandidateCheck({ ...interrupted, cleanup: "running" }).cleanup).toBe("running");
    for (const value of [{ ...pending, ciphertext: "secret" }, { ...pending, endpoint: "https://provider.example.test" },
      { ...pending, status: "succeeded", completedAt: pending.createdAt }, { ...pending, code: "raw-provider-error" },
      { ...pending, updatedAt: "2026-02-30T00:00:00.000Z" }, { ...pending, cleanup: "running" }])
      expect(() => checkedStorageCandidateCheck(value)).toThrow();
  });
  it("bounds lists and rejects duplicated check identities", () => {
    expect(checkedStorageCandidateCheckList({ items: [pending], hasMore: false }).items).toEqual([pending]);
    expect(() => checkedStorageCandidateCheckList({ items: [pending, pending], hasMore: false })).toThrow();
    expect(() => checkedStorageCandidateCheckList({ items: [], hasMore: false, credentials: {} })).toThrow();
  });
});
