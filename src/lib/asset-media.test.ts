import { describe, expect, it } from "vitest";
import { commentImageUrl, fileAssetMediaUrls, sampleEventAssetUrl } from "./asset-media";

describe("legacy and native File media", () => {
  it("keeps real legacy keys and explicit native IDs in the same gallery", () => {
    expect(fileAssetMediaUrls(["images/legacy.png"], [{ assetId: "native", fileId: "file-native", url: "/api/file-assets/native" }]))
      .toEqual(["/api/assets/images/legacy.png", "/api/file-assets/native"]);
    expect(commentImageUrl({ assetKey: null, assetUrl: "/api/file-assets/native" })).toBe("/api/file-assets/native");
    expect(sampleEventAssetUrl({ assetKey: "images/legacy.png" })).toBe("/api/assets/images/legacy.png");
    expect(commentImageUrl({ assetKey: null })).toBeNull();
  });
});
