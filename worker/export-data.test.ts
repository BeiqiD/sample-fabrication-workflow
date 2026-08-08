import { describe, expect, it } from "vitest";
import { buildBlobExportPlan } from "./export-data";

describe("buildBlobExportPlan", () => {
  it("deduplicates physical locators and keeps every source occurrence", () => {
    const plan = buildBlobExportPlan({
      assets: [{
        id: "asset-1",
        r2_key: "comments/main.webp",
        original_name: "main.webp",
        byte_size: 4,
        sha256: "a".repeat(64),
        status: "ready",
      }],
      imports: [{
        id: "import-1",
        source_filename: "source.xlsx",
        workbook_asset_key: "imports/1/source.xlsx",
        manifest_asset_key: "comments/main.webp",
      }],
      template_versions: [],
      events: [],
      managed_storage_objects: [],
      blob_gc_ledger: [],
      blob_retention_edges: [
        {
          store_kind: "r2",
          provider: "r2",
          object_key: "comments/main.webp",
          source_type: "comment_submission",
          source_id: "comment-1",
          occurrence_type: "comment_submission_item",
          occurrence_id: "item-1",
          retention_reason: "ready_comment_item",
          retain_until: null,
        },
        {
          store_kind: "r2",
          provider: "r2",
          object_key: "comments/main.webp",
          source_type: "import",
          source_id: "import-1",
          occurrence_type: "manifest",
          occurrence_id: "import-1",
          retention_reason: "import_provenance",
          retain_until: null,
        },
      ],
    });

    expect(plan).toHaveLength(2);
    expect(plan.find((entry) => entry.objectKey === "comments/main.webp")).toEqual(
      expect.objectContaining({
        blobRecordIds: ["asset-1"],
        downloadUrl: "/api/exports/r2/comments/main.webp",
        sourceOccurrences: [
          expect.objectContaining({ occurrenceId: "item-1" }),
          expect.objectContaining({ occurrenceId: "import-1" }),
        ],
      }),
    );
  });

  it("keeps failed/deleted metadata in the plan without scheduling unavailable bytes", () => {
    const plan = buildBlobExportPlan({
      assets: [{
        id: "failed-asset",
        r2_key: "missing/file.bin",
        original_name: "file.bin",
        byte_size: 8,
        sha256: "b".repeat(64),
        status: "failed",
      }],
      imports: [],
      template_versions: [],
      events: [],
      managed_storage_objects: [],
      blob_retention_edges: [],
      blob_gc_ledger: [],
    });
    expect(plan).toEqual([expect.objectContaining({
      blobRecordIds: ["failed-asset"],
      downloadUrl: null,
      initialOutcome: "metadata_not_ready",
    })]);
  });
});
