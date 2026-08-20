import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import type { FullExportManifest } from "../shared/types";
import { buildFullExportArchive } from "../src/lib/exportAll";
import { buildBlobExportPlan } from "./blob-lifecycle/export";

describe("complete blob export", () => {
  it("packages available bytes once and records missing/unready blobs without aborting", async () => {
    const bytes = new TextEncoder().encode("data");
    const manifest: FullExportManifest = {
      schemaVersion: 6,
      exportedAt: "2026-08-08T12:00:00.000Z",
      tables: {
        samples: [{ id: "sample-1", deleted_at: "2026-08-08T10:00:00.000Z" }],
        assets: [
          { id: "asset-ready", r2_key: "ready/data.bin", status: "ready" },
          { id: "asset-r2-missing", r2_key: "missing/r2.bin", status: "ready" },
          { id: "asset-missing", r2_key: "missing/data.bin", status: "ready" },
          { id: "asset-failed", r2_key: "failed/data.bin", status: "failed" },
        ],
      },
      blobs: [
        {
          locatorId: "ready",
          storeKind: "r2",
          provider: "r2",
          objectKey: "ready/data.bin",
          blobRecordIds: ["asset-ready"],
          filename: "data.bin",
          expectedByteSize: bytes.byteLength,
          expectedSha256: await sha256Hex(bytes.buffer),
          sourceOccurrences: [{
            sourceType: "comment_submission",
            sourceId: "comment-1",
            occurrenceType: "comment_submission_item",
            occurrenceId: "item-1",
            retentionReason: "ready_comment_item",
            retainUntil: null,
          }],
          downloadUrl: "/api/exports/r2/ready/data.bin",
          initialOutcome: null,
        },
        {
          locatorId: "r2-missing",
          storeKind: "r2",
          provider: "r2",
          objectKey: "missing/r2.bin",
          blobRecordIds: ["asset-r2-missing"],
          filename: "r2.bin",
          expectedByteSize: 4,
          expectedSha256: null,
          sourceOccurrences: [],
          downloadUrl: "/api/exports/r2/missing/r2.bin",
          initialOutcome: null,
        },
        {
          locatorId: "missing",
          storeKind: "managed",
          provider: "switchdrive",
          objectKey: "missing/data.bin",
          blobRecordIds: ["managed-missing"],
          filename: "missing.bin",
          expectedByteSize: 4,
          expectedSha256: null,
          sourceOccurrences: [
            {
              sourceType: "comment_submission",
              sourceId: "comment-2",
              occurrenceType: "comment_submission_item",
              occurrenceId: "item-2",
              retentionReason: "ready_comment_item",
              retainUntil: null,
            },
            {
              sourceType: "comment_submission",
              sourceId: "comment-3",
              occurrenceType: "comment_submission_item",
              occurrenceId: "item-3",
              retentionReason: "ready_comment_item",
              retainUntil: null,
            },
          ],
          downloadUrl: "/api/exports/managed/managed-missing",
          initialOutcome: null,
        },
        {
          locatorId: "failed",
          storeKind: "r2",
          provider: "r2",
          objectKey: "failed/data.bin",
          blobRecordIds: ["asset-failed"],
          filename: "failed.bin",
          expectedByteSize: 4,
          expectedSha256: null,
          sourceOccurrences: [],
          downloadUrl: null,
          initialOutcome: "metadata_not_ready",
        },
      ],
    };
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes("ready")
      ? new Response(bytes)
      : new Response("", { status: 404 }));
    const progress: Array<[number, number]> = [];

    const result = await buildFullExportArchive(
      manifest,
      (completed, total) => progress.push([completed, total]),
      fetcher as typeof fetch,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(progress).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]);
    expect(result.results.map((entry) => entry.outcome)).toEqual([
      "packaged", "missing", "missing", "metadata_not_ready",
    ]);

    const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining([
      "tables/samples.json",
      "tables/assets.json",
      "blobs/r2/ready/data.bin",
      "export-manifest.json",
      "export-warnings.json",
    ]));
    expect(zip.file("blobs/managed/switchdrive/managed-missing-missing.bin")).toBeNull();
    expect(JSON.parse(await zip.file("tables/samples.json")!.async("string"))).toEqual(
      manifest.tables.samples,
    );
    const finalManifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
    expect(finalManifest.blobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ locatorId: "ready", outcome: "packaged" }),
      expect.objectContaining({ locatorId: "missing", outcome: "missing" }),
    ]));
    expect(JSON.stringify(finalManifest)).not.toContain("downloadUrl");
    const warnings = JSON.parse(await zip.file("export-warnings.json")!.async("string"));
    expect(warnings.map((warning: { code: string }) => warning.code)).toEqual([
      "missing", "missing", "metadata_not_ready",
    ]);
    expect(warnings.find((warning: { locatorId: string }) => warning.locatorId === "missing")!
      .sourceOccurrences).toHaveLength(2);
  });

  it("deduplicates one physical locator while retaining every occurrence", () => {
    const plan = buildBlobExportPlan({
      assets: [{
        id: "asset-1",
        r2_key: "shared/data.bin",
        original_name: "data.bin",
        byte_size: 4,
        sha256: "a".repeat(64),
        status: "ready",
      }],
      imports: [{
        id: "import-1",
        source_filename: "source.xlsx",
        workbook_asset_key: "shared/data.bin",
        manifest_asset_key: null,
      }],
      template_versions: [],
      events: [],
      managed_storage_objects: [],
      blob_gc_ledger: [],
      blob_retention_edges: [
        {
          store_kind: "r2", provider: "r2", object_key: "shared/data.bin",
          source_type: "comment_submission", source_id: "comment-1",
          occurrence_type: "comment_submission_item", occurrence_id: "item-1",
          retention_reason: "ready_comment_item", retain_until: null,
        },
        {
          store_kind: "r2", provider: "r2", object_key: "shared/data.bin",
          source_type: "import", source_id: "import-1",
          occurrence_type: "import_workbook", occurrence_id: "import-1:workbook",
          retention_reason: "import_provenance", retain_until: null,
        },
      ],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual(expect.objectContaining({
      objectKey: "shared/data.bin",
      blobRecordIds: ["asset-1"],
      sourceOccurrences: [
        expect.objectContaining({ occurrenceId: "item-1" }),
        expect.objectContaining({ occurrenceId: "import-1:workbook" }),
      ],
    }));
  });

  it("does not package bytes whose size or hash disagrees with metadata", async () => {
    const bytes = new TextEncoder().encode("data");
    const base = {
      storeKind: "r2" as const,
      provider: "r2",
      blobRecordIds: ["asset"],
      filename: "data.bin",
      sourceOccurrences: [],
      downloadUrl: "/api/exports/r2/data.bin",
      initialOutcome: null,
    };
    const manifest: FullExportManifest = {
      schemaVersion: 6,
      exportedAt: "2026-08-08T12:00:00.000Z",
      tables: {},
      blobs: [
        { ...base, locatorId: "size", objectKey: "size.bin", expectedByteSize: 5, expectedSha256: null },
        { ...base, locatorId: "hash", objectKey: "hash.bin", expectedByteSize: 4, expectedSha256: "0".repeat(64) },
      ],
    };
    const result = await buildFullExportArchive(
      manifest,
      undefined,
      vi.fn(async () => new Response(bytes)) as typeof fetch,
    );
    expect(result.results.map((entry) => entry.outcome)).toEqual(["size_mismatch", "hash_mismatch"]);
    const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
    expect(Object.keys(zip.files).filter((name) => name.startsWith("blobs/"))).toEqual([]);
  });

  it("records provider outages without aborting the archive", async () => {
    const manifest: FullExportManifest = {
      schemaVersion: 6,
      exportedAt: "2026-08-08T12:00:00.000Z",
      tables: { samples: [{ id: "sample-1" }] },
      blobs: [{
        locatorId: "provider-down",
        storeKind: "managed",
        provider: "switchdrive",
        objectKey: "attachments/data.bin",
        blobRecordIds: ["managed-1"],
        filename: "data.bin",
        expectedByteSize: 4,
        expectedSha256: null,
        sourceOccurrences: [],
        downloadUrl: "/api/exports/managed/managed-1",
        initialOutcome: null,
      }],
    };
    const result = await buildFullExportArchive(
      manifest,
      undefined,
      vi.fn(async () => new Response("", { status: 503 })) as typeof fetch,
    );
    expect(result.results).toEqual([
      expect.objectContaining({ outcome: "provider_unavailable", path: null }),
    ]);
    const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
    expect(JSON.parse(await zip.file("tables/samples.json")!.async("string")))
      .toEqual(manifest.tables.samples);
    expect(JSON.parse(await zip.file("export-warnings.json")!.async("string")))
      .toEqual([expect.objectContaining({ code: "provider_unavailable" })]);
  });
});
