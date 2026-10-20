import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { FullExportBlobEntry, FullExportManifest } from "../../shared/types";
import { buildFullExportArchive } from "./exportAll";
import { FullExportCapacityError } from "./full-export-safety";

function asset(id: string, expectedByteSize: number | null): FullExportBlobEntry {
  return {
    locatorId: id, storeKind: "r2", provider: "r2", objectKey: `opaque/${id}`,
    blobRecordIds: [`record-${id}`], filename: `${id}.bin`, expectedByteSize,
    expectedSha256: null, sourceOccurrences: [], downloadUrl: `/api/exports/r2/${id}`, initialOutcome: null,
  };
}

function manifest(blobs: FullExportBlobEntry[] = []): FullExportManifest {
  return { schemaVersion: 7, exportedAt: "2026-10-20T10:00:00.000Z", tables: { samples: [{ id: "sample-a" }] }, blobs };
}

function byteResponse(chunks: number[]) {
  const cancelled = vi.fn();
  let pulled = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const length = chunks[pulled++];
      if (length === undefined) controller.close();
      else controller.enqueue(new Uint8Array(length).fill(41));
    },
    cancel: cancelled,
  }, { highWaterMark: 0 }));
  const wholeBody = vi.spyOn(response, "arrayBuffer").mockRejectedValue(new Error("Whole response buffering is forbidden"));
  return { response, cancelled, wholeBody, pulled: () => pulled };
}

describe("browser full ZIP capacity and cancellation", () => {
  it("rejects the aggregate declared capacity before fetching any asset", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(buildFullExportArchive(manifest([asset("first", 3), asset("second", 3)]), undefined, fetcher, {
      limits: { assetBytes: 5 },
    })).rejects.toBeInstanceOf(FullExportCapacityError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, 2])("caps actual streamed bytes when declared size is %s", async expectedByteSize => {
    const input = byteResponse([3, 3, 3]);
    const stages: string[] = [];
    await expect(buildFullExportArchive(manifest([asset("larger", expectedByteSize)]), undefined,
      vi.fn<typeof fetch>().mockResolvedValue(input.response), {
        limits: { assetBytes: 5 }, onStageProgress: progress => { stages.push(progress.stage); },
      })).rejects.toBeInstanceOf(FullExportCapacityError);
    expect(input.cancelled).toHaveBeenCalledTimes(1);
    expect(input.pulled()).toBe(2);
    expect(input.wholeBody).not.toHaveBeenCalled();
    expect(stages).not.toContain("compressing");
  });

  it("counts bytes across unknown-size files instead of resetting the capacity per asset", async () => {
    const inputs = [byteResponse([3]), byteResponse([3, 1])];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(inputs[0].response).mockResolvedValueOnce(inputs[1].response);
    await expect(buildFullExportArchive(manifest([asset("first", null), asset("second", null)]), undefined, fetcher, {
      limits: { assetBytes: 5 },
    })).rejects.toBeInstanceOf(FullExportCapacityError);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(inputs[1].cancelled).toHaveBeenCalledTimes(1);
    expect(inputs[1].pulled()).toBe(1);
  });

  it("rejects metadata and final ZIP capacity without returning a partial archive", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const large = manifest();
    large.tables.samples[0].description = "x".repeat(2_000);
    await expect(buildFullExportArchive(large, undefined, fetcher, { limits: { metadataBytes: 64 } }))
      .rejects.toBeInstanceOf(FullExportCapacityError);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(buildFullExportArchive(manifest(), undefined, fetcher, { limits: { archiveBytes: 8 } }))
      .rejects.toBeInstanceOf(FullExportCapacityError);
  });

  it("aborts a pending body read, cancels its reader, and never starts compression", async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { started(); return new Promise<void>(() => undefined); }, cancel: cancelled,
    }, { highWaterMark: 0 }));
    const controller = new AbortController();
    const stages: string[] = [];
    const operation = buildFullExportArchive(manifest([asset("pending", null)]), undefined,
      vi.fn<typeof fetch>().mockResolvedValue(response), {
        signal: controller.signal, onStageProgress: progress => { stages.push(progress.stage); },
      });
    await reading;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(stages).not.toContain("compressing");
  });

  it("propagates transport AbortError rather than emitting an unavailable-asset warning", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    await expect(buildFullExportArchive(manifest([asset("aborted", null)]), undefined, fetcher))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes the signal to asset fetch and cancels a response obtained after abortion", async () => {
    const controller = new AbortController(), input = byteResponse([3]);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort(); return input.response;
    });
    await expect(buildFullExportArchive(manifest([asset("late-response", 3)]), undefined, fetcher, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(input.cancelled).toHaveBeenCalledOnce();
    expect(input.pulled()).toBe(0);
  });

  it("counts failed integrity bytes against the next asset's aggregate capacity", async () => {
    const inputs = [byteResponse([3]), byteResponse([3])];
    const mismatch = asset("mismatch", 2), second = asset("second", null);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(inputs[0].response).mockResolvedValueOnce(inputs[1].response);
    await expect(buildFullExportArchive(manifest([mismatch, second]), undefined, fetcher, { limits: { assetBytes: 5 } }))
      .rejects.toBeInstanceOf(FullExportCapacityError);
    expect(inputs[1].cancelled).toHaveBeenCalledOnce();
  });

  it("rejects oversized declared response length without reading the asset body", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-length": "6" } });
    await expect(buildFullExportArchive(manifest([asset("unknown", null)]), undefined,
      vi.fn<typeof fetch>().mockResolvedValue(response), { limits: { assetBytes: 5 } }))
      .rejects.toBeInstanceOf(FullExportCapacityError);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("stops during verification and compression, then permits an independent retry", async () => {
    for (const target of ["verifying", "compressing"] as const) {
      const controller = new AbortController();
      const item = asset("cancelled", 3);
      item.expectedSha256 = "0".repeat(64);
      await expect(buildFullExportArchive(manifest([item]), undefined,
        vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))), {
          signal: controller.signal,
          onStageProgress: progress => { if (progress.stage === target) controller.abort(); },
        })).rejects.toMatchObject({ name: "AbortError" });
    }
    const retried = await buildFullExportArchive(manifest([asset("retry", 3)]), undefined,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));
    const zip = await JSZip.loadAsync(await retried.archive.arrayBuffer());
    expect([...await zip.file("blobs/r2/000001-retry.bin")!.async("uint8array")]).toEqual([1, 2, 3]);
    expect(retried.warnings).toEqual([]);
  });

  it("preserves complete content and legitimate unavailable-file warnings within capacity", async () => {
    const snapshot = manifest([asset("available", null), asset("missing", 2), asset("mismatch", 2)]);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9])));
    const result = await buildFullExportArchive(snapshot, undefined, fetcher, { limits: { assetBytes: 8 } });
    expect(result.results.map(entry => entry.outcome)).toEqual(["packaged", "missing", "size_mismatch"]);
    expect(result.warnings.map(entry => entry.code)).toEqual(["missing", "size_mismatch"]);
    const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
    expect(JSON.parse(await zip.file("tables/samples.json")!.async("string"))).toEqual(snapshot.tables.samples);
    expect(JSON.parse(await zip.file("export-warnings.json")!.async("string"))).toEqual(result.warnings);
    const exported = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
    expect(exported.blobs).toEqual(result.results);
    expect(JSON.stringify(exported)).not.toContain("downloadUrl");
    expect(zip.file("blobs/r2/000001-available.bin")).not.toBeNull();
    expect(zip.file("blobs/r2/000003-mismatch.bin")).toBeNull();
  });
});
