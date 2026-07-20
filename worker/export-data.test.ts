import { describe, expect, it } from "vitest";
import { collectExportAssetKeys } from "./export-data";

describe("collectExportAssetKeys", () => {
  it("deduplicates ordinary, imported, workbook, and manifest assets", () => {
    expect(collectExportAssetKeys(
      [{ r2_key: "comments/main.webp" }, { r2_key: "imports/1/layer.webp" }],
      [{ workbook_asset_key: "imports/1/source.xlsx", manifest_asset_key: "imports/1/manifest.json" },
        { workbook_asset_key: "comments/main.webp", manifest_asset_key: null }],
    )).toEqual([
      "comments/main.webp",
      "imports/1/layer.webp",
      "imports/1/manifest.json",
      "imports/1/source.xlsx",
    ]);
  });
});
