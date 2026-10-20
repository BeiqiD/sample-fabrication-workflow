import { describe, expect, it } from "vitest";
import { checkedShadowWithdrawalRequest, shadowWithdrawalRequestSha256 } from "./file-shadow-withdrawal";
import { stableJson } from "../domain/content-addressing";

const request = () => ({
  operationId: "11111111-1111-4111-8111-111111111111",
  key: { consumerKind: "project_content_attachment", consumerId: "legacy\0e\u0301", consumerSubId: "", fileSlot: "primary" },
  expectedBaselineSha256: "a".repeat(64),
  destinationProfile: { profileId: "storage-profile:r2:bootstrap", configurationRevision: 1 as const },
  runtimeIncarnation: "22222222-2222-4222-8222-222222222222",
});

describe("withdrawal binds the complete immutable conversion request", () => {
  it("preserves historical typed keys without Unicode normalization or NUL truncation", async () => {
    const original = request(), frozen = checkedShadowWithdrawalRequest(original);
    expect(frozen).toEqual(original);
    original.key.consumerId = "edited";
    expect(frozen.key.consumerId).toBe("legacy\0e\u0301");
    const composed = { ...frozen, key: { ...frozen.key, consumerId: "legacy\0é" } };
    expect(await shadowWithdrawalRequestSha256(frozen)).not.toBe(await shadowWithdrawalRequestSha256(composed));
  });

  it("ignores property order but binds baseline, destination and original runtime", async () => {
    const original = request();
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(stableJson(checkedShadowWithdrawalRequest(reordered))).toBe(stableJson(original));
    const expected = await shadowWithdrawalRequestSha256(original);
    for (const changed of [
      { ...original, expectedBaselineSha256: "b".repeat(64) },
      { ...original, destinationProfile: { ...original.destinationProfile, profileId: "another-profile" } },
      { ...original, runtimeIncarnation: "33333333-3333-4333-8333-333333333333" },
      { ...original, key: { ...original.key, consumerSubId: "another-occurrence" } },
    ]) expect(await shadowWithdrawalRequestSha256(changed)).not.toBe(expected);
  });

  it("rejects omitted fields, caller timestamps, non-v4 IDs and malformed profile identities", () => {
    for (const changed of [
      { ...request(), runtimeIncarnation: undefined },
      { ...request(), withdrawnAt: "2026-09-28T00:00:00.000Z" },
      { ...request(), operationId: "11111111-1111-1111-8111-111111111111" },
      { ...request(), expectedBaselineSha256: "A".repeat(64) },
      { ...request(), key: { ...request().key, extra: "unreviewed" } },
      { ...request(), key: { ...request().key, consumerId: 1 } },
      { ...request(), key: { "consumerId,consumerKind": "confusable", consumerSubId: "", fileSlot: "primary" } },
      { ...request(), destinationProfile: { profileId: "r2\0other", configurationRevision: 1 } },
      { ...request(), destinationProfile: { profileId: "r2", configurationRevision: 2 } },
    ]) expect(() => checkedShadowWithdrawalRequest(changed)).toThrow(/Invalid File shadow withdrawal/);
  });

  it("bounds encoded metadata bytes while accepting large exact historical keys", () => {
    const bounded = request(); bounded.key.consumerId = "界".repeat(21000);
    expect(checkedShadowWithdrawalRequest(bounded).key.consumerId).toBe(bounded.key.consumerId);
    bounded.key.consumerId += "界".repeat(1000);
    expect(() => checkedShadowWithdrawalRequest(bounded)).toThrow();
  });
});
