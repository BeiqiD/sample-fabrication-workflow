import { describe, expect, it } from "vitest";
import { checkedFileShadowEvidenceReview, checkedFileShadowIdentification, checkedFileShadowReviewKey, type FileShadowEvidenceReview } from "./file-shadow-evidence-review";
const key = { consumerKind: "project_content_attachment", consumerId: "historic\0文件", consumerSubId: "", fileSlot: "primary" };
const review = (): FileShadowEvidenceReview => ({ version: 1, kind: "file-shadow-evidence-review", readOnly: true, bytesVerified: false, key: { ...key },
  head: { generation: 1, occurrenceId: "shadow:abc", sourceMetadataSha256: "a".repeat(64) }, baselineSha256: "b".repeat(64), status: "ambiguous",
  reasons: ["consumer_purpose_unresolved", "namespace_evidence_missing"], identification: { projectId: "project", projectTitle: "Title", attachmentName: "Name" },
  purpose: null, expectedBytes: 0, expectedSha256: "c".repeat(64), sourceProvider: "r2", sourceProfile: null, peerReferences: [{ key: { ...key, consumerId: "other" }, purpose: null }] });
describe("safe historical File review contract", () => {
  it("preserves opaque identities and detaches every nested response field", () => {
    const input = review(), output = checkedFileShadowEvidenceReview(input);
    expect(output).toEqual(input); input.key.consumerId = "changed"; input.head!.generation = 2; input.reasons.push("changed");
    input.identification!.projectTitle = "Changed"; input.peerReferences[0].key.consumerSubId = "changed";
    expect(output).toEqual(review()); expect(checkedFileShadowReviewKey(key)).toEqual(key);
  });
  it("rejects accidental raw metadata and comma-joined key collisions", () => {
    for (const value of [{ ...review(), locator: "private" }, { ...review(), sourceProfile: { profileId: "p", configurationRevision: 1, namespace: "private" } },
      { ...review(), peerReferences: [{ key, purpose: null, actor: "private" }] }, { ...review(), purpose: ["research_source"] }, { ...review(), status: ["ambiguous"] },
      { ...review(), reasons: ["private_lowercase_text"] }]) {
      expect(() => checkedFileShadowEvidenceReview(value)).toThrow();
    }
    expect(() => checkedFileShadowReviewKey({ consumerId: "id", "consumerKind,consumerSubId": "value", fileSlot: "primary" })).toThrow();
  });
  it("bounds labels, peer count, complete response and typed keys", () => {
    expect(() => checkedFileShadowIdentification({ projectId: "p", projectTitle: "🧪".repeat(1024), attachmentName: "a" })).not.toThrow();
    expect(() => checkedFileShadowIdentification({ projectId: "p", projectTitle: "🧪".repeat(1025), attachmentName: "a" })).toThrow();
    expect(() => checkedFileShadowEvidenceReview({ ...review(), peerReferences: Array.from({ length: 101 }, (_, index) => ({ key: { ...key, consumerId: `peer-${index}` }, purpose: null })) })).toThrow();
    expect(() => checkedFileShadowEvidenceReview({ ...review(), peerReferences: Array.from({ length: 10 }, (_, index) => ({ key: { ...key, consumerId: `peer-${index}-${"x".repeat(60000)}` }, purpose: null })) })).toThrow();
    expect(() => checkedFileShadowReviewKey({ ...key, consumerId: "x".repeat(65536) })).toThrow();
  });
  it("never upgrades read-only or recorded expectations to verification", () => {
    for (const invalid of [{ readOnly: false }, { bytesVerified: true }, { expectedBytes: -1 }, { expectedBytes: Number.MAX_SAFE_INTEGER + 1 },
      { expectedSha256: "unverified" }, { sourceProfile: { profileId: "p", configurationRevision: 2 } }]) {
      expect(() => checkedFileShadowEvidenceReview({ ...review(), ...invalid })).toThrow();
    }
  });
  it("rejects non-absent responses without a generation and duplicate/self peer identities", () => {
    for (const invalid of [{ head: null }, { peerReferences: [{ key, purpose: null }] },
      { peerReferences: [...review().peerReferences, ...review().peerReferences] }]) {
      expect(() => checkedFileShadowEvidenceReview({ ...review(), ...invalid })).toThrow();
    }
  });
});
