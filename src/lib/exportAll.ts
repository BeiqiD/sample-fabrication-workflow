import type {
  BlobExportOutcome,
  FullExportBlobEntry,
  FullExportManifest,
} from "../../shared/types";
import { sha256Hex } from "../../shared/content-addressing";
import { api } from "./api";

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function archivePath(entry: FullExportBlobEntry) {
  if (entry.storeKind === "r2") {
    return `blobs/r2/${entry.objectKey.split("/").map(safeSegment).join("/")}`;
  }
  const identity = entry.blobRecordIds[0] || entry.locatorId;
  return `blobs/managed/${safeSegment(entry.provider)}/${safeSegment(identity)}-${safeSegment(entry.filename)}`;
}

function warningMessage(outcome: Exclude<BlobExportOutcome, "packaged">, entry: FullExportBlobEntry) {
  const subject = `${entry.storeKind} blob ${entry.filename}`;
  switch (outcome) {
    case "missing": return `${subject} is missing from its storage provider.`;
    case "provider_unavailable": return `The storage provider was unavailable while reading ${subject}.`;
    case "metadata_not_ready": return `${subject} does not have ready byte metadata.`;
    case "download_failed": return `${subject} could not be downloaded.`;
    case "size_mismatch": return `${subject} did not match its recorded byte size.`;
    case "hash_mismatch": return `${subject} did not match its recorded SHA-256 hash.`;
  }
}

export async function buildFullExportArchive(
  manifest: FullExportManifest,
  onProgress?: (completed: number, total: number) => void,
  fetcher: typeof fetch = fetch,
) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const [name, rows] of Object.entries(manifest.tables)) {
    zip.file(`tables/${safeSegment(name)}.json`, JSON.stringify(rows, null, 2));
  }

  const total = manifest.blobs.length;
  onProgress?.(0, total);
  let completed = 0;
  const results: Array<{
    locatorId: string;
    storeKind: FullExportBlobEntry["storeKind"];
    provider: string;
    objectKey: string;
    blobRecordIds: string[];
    filename: string;
    expectedByteSize: number | null;
    expectedSha256: string | null;
    sourceOccurrences: FullExportBlobEntry["sourceOccurrences"];
    outcome: BlobExportOutcome;
    path: string | null;
  }> = [];

  for (const entry of manifest.blobs) {
    let outcome: BlobExportOutcome = entry.initialOutcome ?? "download_failed";
    let path: string | null = null;
    if (entry.downloadUrl) {
      try {
        const response = await fetcher(entry.downloadUrl);
        if (!response.ok) {
          outcome = response.status === 404
            ? "missing"
            : response.status === 503
              ? "provider_unavailable"
              : "download_failed";
        } else {
          const bytes = await response.arrayBuffer();
          if (entry.expectedByteSize !== null && bytes.byteLength !== entry.expectedByteSize) {
            outcome = "size_mismatch";
          } else if (entry.expectedSha256
            && await sha256Hex(bytes) !== entry.expectedSha256.toLowerCase()) {
            outcome = "hash_mismatch";
          } else {
            outcome = "packaged";
            path = archivePath(entry);
            zip.file(path, bytes);
          }
        }
      } catch {
        outcome = "provider_unavailable";
      }
    }
    results.push({
      locatorId: entry.locatorId,
      storeKind: entry.storeKind,
      provider: entry.provider,
      objectKey: entry.objectKey,
      blobRecordIds: entry.blobRecordIds,
      filename: entry.filename,
      expectedByteSize: entry.expectedByteSize,
      expectedSha256: entry.expectedSha256,
      sourceOccurrences: entry.sourceOccurrences,
      outcome,
      path,
    });
    completed += 1;
    onProgress?.(completed, total);
  }

  const warnings = results.flatMap((entry) => entry.outcome === "packaged" ? [] : [{
    code: entry.outcome,
    locatorId: entry.locatorId,
    blobRecordIds: entry.blobRecordIds,
    sourceOccurrences: entry.sourceOccurrences,
    message: warningMessage(entry.outcome, manifest.blobs.find((blob) => blob.locatorId === entry.locatorId)!),
  }]);
  zip.file("export-manifest.json", JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    exportedAt: manifest.exportedAt,
    tables: Object.fromEntries(Object.entries(manifest.tables).map(([name, rows]) => [name, {
      rowCount: rows.length,
      path: `tables/${safeSegment(name)}.json`,
    }])),
    blobs: results,
  }, null, 2));
  zip.file("export-warnings.json", JSON.stringify(warnings, null, 2));

  return {
    archive: await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
    warnings,
    results,
  };
}

export async function exportAll(onProgress?: (completed: number, total: number) => void) {
  const manifest = await api.getFullExport();
  const { archive } = await buildFullExportArchive(manifest, onProgress);
  const url = URL.createObjectURL(archive);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `sample-log-${manifest.exportedAt.slice(0, 10)}.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
