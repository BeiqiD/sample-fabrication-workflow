import { describe, expect, it } from "vitest";
import { validateCommentAcceptedItemResult, validateCommentAcceptedItemResultV21 } from "./comment-acceptance";

const legacy = { storeKind: "r2", provider: "r2", blobRecordId: "legacy-image", objectKey: "comments/legacy/image",
  sha256: "a".repeat(64), byteSize: 4, deduplicated: false };
const native = { schema: "comment-upload/2", storeKind: "file", provider: "s3", blobRecordId: "native-image", fileId: "native-file",
  storageProfileId: "native-profile", storageProfileRevision: 1, objectKey: "comments/native/image", sha256: "b".repeat(64),
  byteSize: 4, deduplicated: false };

describe("native accepted Comment result contract", () => {
  it("admits explicit native File/profile provenance while preserving frozen legacy admission", () => {
    expect(validateCommentAcceptedItemResultV21(native)).toEqual(native);
    expect(validateCommentAcceptedItemResultV21(legacy)).toEqual(legacy);
    expect(() => validateCommentAcceptedItemResult(native)).toThrow("Invalid accepted Comment upload result");
  });

  it.each([
    { storeKind: "r2" }, { storeKind: "managed" }, { storeKind: "s3" }, { provider: "r2" }, { provider: "switchdrive" },
    { schema: "comment-upload/1" }, { schema: undefined }, { fileId: "" }, { fileId: "file\0other" },
    { storageProfileId: "" }, { storageProfileId: "profile\0other" }, { storageProfileRevision: 0 }, { storageProfileRevision: 2 },
    { blobRecordId: "" }, { objectKey: "" }, { sha256: "bad" }, { byteSize: 0 }, { byteSize: 1.5 }, { byteSize: "4" },
    { deduplicated: 1 }, { unrelated: "extra" },
  ])("rejects ambiguous or malformed native provenance %j", change => {
    expect(() => validateCommentAcceptedItemResultV21({ ...native, ...change })).toThrow();
  });

  it("requires every native identity and rejects omissions", () => {
    for (const key of Object.keys(native)) {
      const omitted = { ...native } as Record<string, unknown>;
      delete omitted[key];
      expect(() => validateCommentAcceptedItemResultV21(omitted), key).toThrow();
    }
  });

  it("keeps image and original byte limits explicit at the acceptance boundary", () => {
    const original = { ...native, byteSize: 6 * 1024 * 1024 };
    expect(validateCommentAcceptedItemResultV21(original, { maxByteSize: 100 * 1024 * 1024 })).toEqual(original);
    expect(() => validateCommentAcceptedItemResultV21(original, { maxByteSize: 5 * 1024 * 1024 })).toThrow();
    expect(() => validateCommentAcceptedItemResultV21({ ...native, byteSize: 100 * 1024 * 1024 + 1 })).toThrow();
  });
});
