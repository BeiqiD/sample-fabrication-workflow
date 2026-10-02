import { describe, expect, it } from "vitest";
import {
  checkedReenvelopeStorageCredentialInput, checkedStorageCredentialEnvelopeList, checkedStorageCredentialEnvelopeMetadata,
  checkedStorageCredentialReenvelopeOperationId, checkedStorageCredentialReenvelopeReceipt,
} from "./storage-credential-reenvelope";
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = { operationId, profileId: "external:profile", revision: 2, credentialRef: "credential:retained", expectedEnvelopeRevision: 3 };
const metadata = { profileId: input.profileId, revision: input.revision, credentialRef: input.credentialRef, envelopeRevision: 3, isCurrentCandidate: true, status: "needs_reenvelope" };
const receipt = { operationId, profileId: input.profileId, revision: input.revision, credentialRef: input.credentialRef,
  previousEnvelopeRevision: 3, envelopeRevision: 4, outcome: "reenveloped", createdAt: "2026-10-02T10:00:00.000Z", createdBy: "admin@example.test" };
describe("safe credential re-envelope contracts", () => {
  it("canonicalizes idempotency identities and requires exact bounded intent", () => {
    expect(checkedStorageCredentialReenvelopeOperationId(operationId.toUpperCase())).toBe(operationId);
    expect(checkedReenvelopeStorageCredentialInput(input)).toEqual(input);
    for (const value of [{ ...input, operationId: "invalid" }, { ...input, expectedEnvelopeRevision: 0 }, { ...input, revision: 1.5 },
      { ...input, expectedEnvelopeRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...input, credentialRef: "x".repeat(257) },
      { ...input, profileId: "unsafe\u0000" }, { ...input, credentialRef: "\ud800" }, { ...input, keyId: "new-key" },
      { ...input, credentialRef: undefined }]) expect(() => checkedReenvelopeStorageCredentialInput(value)).toThrow("Invalid storage credential re-envelope.");
  });
  it("keeps wrapping status independent of candidate currency and rejects protected context", () => {
    expect(checkedStorageCredentialEnvelopeMetadata(metadata)).toEqual(metadata);
    expect(checkedStorageCredentialEnvelopeMetadata({ ...metadata, isCurrentCandidate: false, status: "current" }).status).toBe("current");
    expect(checkedStorageCredentialEnvelopeMetadata({ ...metadata, status: "unavailable" }).status).toBe("unavailable");
    expect(checkedStorageCredentialEnvelopeMetadata({ ...metadata, status: "unavailable", envelopeRevision: null }).envelopeRevision).toBeNull();
    for (const value of [{ ...metadata, keyId: "secret-key-id" }, { ...metadata, ciphertext: "protected" }, { ...metadata, nonce: "protected" },
      { ...metadata, status: "decryptable" }, { ...metadata, isCurrentCandidate: 1 }, { ...metadata, envelopeRevision: 0 }, { ...metadata, envelopeRevision: null }])
      expect(() => checkedStorageCredentialEnvelopeMetadata(value)).toThrow();
  });
  it("bounds single-profile histories and rejects ambiguous descriptor identities", () => {
    const historical = { ...metadata, revision: 1, credentialRef: "credential:earlier", isCurrentCandidate: false };
    expect(checkedStorageCredentialEnvelopeList({ items: [metadata, historical], hasMore: true }).items).toHaveLength(2);
    expect(checkedStorageCredentialEnvelopeList({ items: [metadata, { ...historical, revision: metadata.revision }], hasMore: false }).items).toHaveLength(2);
    for (const items of [[metadata, metadata], [metadata, { ...historical, credentialRef: metadata.credentialRef }],
      [metadata, { ...historical, isCurrentCandidate: true }],
      [metadata, { ...historical, profileId: "external:different" }], Array.from({ length: 101 }, (_, index) => ({ ...historical, revision: index + 1, credentialRef: `credential:${index}` }))])
      expect(() => checkedStorageCredentialEnvelopeList({ items, hasMore: false })).toThrow();
    expect(() => checkedStorageCredentialEnvelopeList({ items: [], hasMore: false, keyIds: [] })).toThrow();
  });
  it("accepts immutable changed and unchanged receipts without impossible revision advances", () => {
    expect(checkedStorageCredentialReenvelopeReceipt(receipt)).toEqual(receipt);
    expect(checkedStorageCredentialReenvelopeReceipt({ ...receipt, outcome: "already_current", envelopeRevision: 3 }).outcome).toBe("already_current");
    for (const value of [{ ...receipt, envelopeRevision: 5 }, { ...receipt, outcome: "already_current" },
      { ...receipt, previousEnvelopeRevision: Number.MAX_SAFE_INTEGER, envelopeRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...receipt, createdAt: "2026-02-30T10:00:00.000Z" }, { ...receipt, createdBy: "admin\n@example.test" },
      { ...receipt, expectedCiphertext: "protected" }, { ...receipt, outcome: "failed" }])
      expect(() => checkedStorageCredentialReenvelopeReceipt(value)).toThrow();
  });
});
