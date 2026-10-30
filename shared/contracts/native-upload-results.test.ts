import { describe, expect, it } from "vitest";
import { nativeAssetUrl, validateFileUploadResult } from "./r2-upload";
import { validateMetrologyReferenceUploadResult, validateMetrologyReferenceUploadResultV21 } from "./metrology-reference-upload";

const id = "7a49b6dd-4d40-4c29-a45d-d9a09689b027";
const fileId = "83bcde84-0651-48a2-a7e1-3039caa6ec38";
const native = { id, key: null, fileId, storageKind: "native", url: nativeAssetUrl(id), deduplicated: false };
const metrology = { assetId: id, deduplicated: false, reference: { id: "reference", filename: "manual.pdf", mimeType: "application/pdf",
  byteSize: 12, assetKey: null, fileId, url: nativeAssetUrl(id), createdAt: "2026-10-05T12:00:00.000Z" } };

describe("native File upload results", () => {
  it("keeps the real legacy locator and accepts explicit business URLs for native results", () => {
    const legacy = { id, key: "legacy/image.png", deduplicated: true };
    expect(validateFileUploadResult(legacy)).toEqual(legacy);
    expect(validateFileUploadResult(native)).toEqual(native);
  });
  it.each([{ ...native, key: "fake-r2" }, { ...native, url: "https://provider.invalid/private" },
    { ...native, fileId: "" }, { ...native, storageKind: "r2" }, { ...native, credentials: {} }])("rejects an ambiguous or untrusted native result %j", value => {
    expect(() => validateFileUploadResult(value)).toThrow();
  });
  it("admits a native metrology result only through the successor validator", () => {
    expect(() => validateMetrologyReferenceUploadResult(metrology)).toThrow();
    expect(validateMetrologyReferenceUploadResultV21(metrology)).toEqual(metrology);
  });
  it.each([{ ...metrology.reference, url: nativeAssetUrl("wrong-asset") }, { ...metrology.reference, fileId: null },
    { ...metrology.reference, assetKey: "fake-r2" }, { ...metrology.reference, provider: "r2" }])("rejects a mismatched native metrology reference %j", reference => {
    expect(() => validateMetrologyReferenceUploadResultV21({ ...metrology, reference })).toThrow();
  });
});
