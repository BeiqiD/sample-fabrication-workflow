import { validateFullExportV26 } from "../../shared/contracts/export-portable-runtime-v26";
import { validateFullExportV25 } from "../../shared/contracts/export-portable-runtime";
import type JSZip from "jszip";
import { createExportArtifact, exportArtifactText, validateFullExportV8, validateFullExportV9, validateFullExportV10, validateFullExportV11, validateFullExportV12, validateFullExportV13, validateFullExportV14, validateFullExportV15, validateFullExportV16, validateFullExportV17, validateFullExportV18, validateFullExportV19, validateFullExportV20, validateFullExportV21, validateFullExportV22, validateFullExportV23, validateFullExportV24 } from "../../shared/contracts/export-protocol";
import type { FullExportBlobEntryV15, FullExportNativeBlobEntryV21 } from "../../shared/contracts/export";
import type {
  BlobExportOutcome,
  FullExportBlobEntry,
  FullExportManifest,
} from "../../shared/types";
import { sha256Hex } from "../../shared/content-addressing";
import { checkFullExportAbort, exportTextBytes, FullExportCapacityError, fullExportLimits, isFullExportInterruption,
  preflightFullExport, readBoundedExportResponse, type FullExportOptions, type FullExportLimits } from "./full-export-safety";

interface ExportBuild {
  options: FullExportOptions; limits: FullExportLimits; assetBytes: number; metadataBytes: number;
}
function beginBuild(input: unknown, options: FullExportOptions): ExportBuild {
  checkFullExportAbort(options.signal);
  options.onStageProgress?.({ stage: "preparing", completed: 0, total: 0, bytesRead: 0 });
  checkFullExportAbort(options.signal);
  const limits = fullExportLimits(options); preflightFullExport(input, limits);
  return { options, limits, assetBytes: 0, metadataBytes: 0 };
}
function addMetadata(zip: JSZip, path: string, content: string, build: ExportBuild) {
  checkFullExportAbort(build.options.signal);
  const length = exportTextBytes(content);
  if (length > build.limits.metadataBytes - build.metadataBytes) throw new FullExportCapacityError("metadata", build.limits.metadataBytes);
  build.metadataBytes += length; zip.file(path, content);
}
function stage(build: ExportBuild, value: "reading" | "verifying", completed: number, total: number) {
  build.options.onStageProgress?.({ stage: value, completed, total, bytesRead: build.assetBytes });
  checkFullExportAbort(build.options.signal);
}
async function assetSha256(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
  checkFullExportAbort(signal); const digest = await sha256Hex(bytes.buffer); checkFullExportAbort(signal); return digest;
}
/** Accumulate bounded ZIP output. Production runs this work in a dedicated
 * Worker, whose termination also interrupts CPU compression immediately. */
async function generateArchive(zip: JSZip, build: ExportBuild): Promise<Blob> {
  const { signal, onStageProgress } = build.options;
  checkFullExportAbort(signal);
  onStageProgress?.({ stage: "compressing", completed: 0, total: 0, bytesRead: build.assetBytes, percent: 0 });
  checkFullExportAbort(signal);
  const output = zip.generateInternalStream({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0, settled = false;
    const release = () => { signal?.removeEventListener("abort", abort); chunks.length = 0;
      for (const path of Object.keys(zip.files)) zip.remove(path); };
    const fail = (error: unknown) => { if (settled) return; settled = true; output.pause(); release(); reject(error); };
    const abort = () => fail(signal?.reason ?? new DOMException("Export cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    output.on("data", (bytes, metadata) => {
      if (settled) return;
      try {
        checkFullExportAbort(signal);
        if (bytes.byteLength > build.limits.archiveBytes - size) throw new FullExportCapacityError("archive", build.limits.archiveBytes);
        // JSZip's uint8array generator creates ordinary ArrayBuffer chunks.
        size += bytes.byteLength; chunks.push(bytes as Uint8Array<ArrayBuffer>);
        onStageProgress?.({ stage: "compressing", completed: 0, total: 0, bytesRead: build.assetBytes, percent: metadata.percent });
        checkFullExportAbort(signal);
      } catch (error) { fail(error); }
    }).on("error", fail).on("end", () => {
      if (settled) return;
      try { checkFullExportAbort(signal); const blob = new Blob(chunks, { type: "application/zip" }); settled = true; release(); resolve(blob); }
      catch (error) { fail(error); }
    });
    if (signal?.aborted) abort(); else output.resume();
  });
}

type VersionedExportBlobEntry = FullExportBlobEntry | FullExportNativeBlobEntryV21;

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function archivePath(entry: VersionedExportBlobEntry, index: number) {
  // Provider keys and record IDs are opaque identities, not filesystem paths.
  // Sanitizing them can merge different locators or preserve dot segments. The
  // manifest's unique ordinal owns the path; its metadata retains every exact
  // identity needed to put these bytes back into the original provider.
  const ordinal = String(index + 1).padStart(6, "0");
  const filename = safeSegment(entry.filename).slice(0, 160).replace(/\.+$/, "") || "blob";
  return `blobs/${entry.storeKind}/${ordinal}-${filename}`;
}

function warningMessage(outcome: Exclude<BlobExportOutcome, "packaged">, entry: VersionedExportBlobEntry) {
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

async function packageExportBlobs(
  zip: JSZip,
  blobs: VersionedExportBlobEntry[],
  onProgress: ((completed: number, total: number) => void) | undefined,
  fetcher: typeof fetch,
  validatedFileLocationTransport = false,
  build: ExportBuild,
) {
  const total = blobs.length;
  onProgress?.(0, total);
  let completed = 0;
  type ShadowIdentity = Pick<FullExportBlobEntryV15, "byteAuthority" | "storageProfileId" | "storageProfileRevision" | "locationId">;
  const identity = (entry: VersionedExportBlobEntry): Partial<ShadowIdentity> => "byteAuthority" in entry
    ? { byteAuthority: (entry as ShadowIdentity).byteAuthority,
      storageProfileId: (entry as ShadowIdentity).storageProfileId,
      storageProfileRevision: (entry as ShadowIdentity).storageProfileRevision,
      locationId: (entry as ShadowIdentity).locationId } : {};
  const results: Array<Partial<ShadowIdentity> & {
    locatorId: string;
    storeKind: VersionedExportBlobEntry["storeKind"];
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

  for (const [index, entry] of blobs.entries()) {
    checkFullExportAbort(build.options.signal);
    let outcome: BlobExportOutcome = entry.initialOutcome ?? "download_failed";
    let path: string | null = null;
    if (entry.downloadUrl) {
      try {
        // V15–V17 freeze location URLs relative to the export router. Adapt
        // only this validated plan at delivery time to the root Worker's /api
        // mount; canonical manifests and already-prefixed legacy URLs stay intact.
        const downloadUrl = validatedFileLocationTransport && "byteAuthority" in entry
          && entry.byteAuthority === "file_location" && entry.downloadUrl.startsWith("/exports/file-locations/")
          ? `/api${entry.downloadUrl}` : entry.downloadUrl;
        stage(build, "reading", completed, total);
        const response = build.options.signal ? await fetcher(downloadUrl, { signal: build.options.signal }) : await fetcher(downloadUrl);
        if (build.options.signal?.aborted) {
          void response.body?.cancel(build.options.signal.reason).catch(() => undefined);
          checkFullExportAbort(build.options.signal);
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          outcome = response.status === 404
            ? "missing"
            : response.status === 503
              ? "provider_unavailable"
              : "download_failed";
        } else {
          const before = build.assetBytes;
          const bytes = await readBoundedExportResponse(response, build.limits.assetBytes - before, build.options.signal,
            received => { build.assetBytes = before + received; stage(build, "reading", completed, total); }, "asset", build.limits.assetBytes);
          stage(build, "verifying", completed, total);
          if (entry.expectedByteSize !== null && bytes.byteLength !== entry.expectedByteSize) {
            outcome = "size_mismatch";
          } else if (entry.expectedSha256
            && await assetSha256(bytes, build.options.signal) !== entry.expectedSha256.toLowerCase()) {
            outcome = "hash_mismatch";
          } else {
            outcome = "packaged";
            path = archivePath(entry, index);
            zip.file(path, bytes);
          }
        }
      } catch (error) {
        if (isFullExportInterruption(error, build.options.signal)) throw error;
        outcome = "provider_unavailable";
      }
    }
    results.push({
      ...identity(entry),
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
    checkFullExportAbort(build.options.signal);
  }

  const warnings = results.flatMap((entry) => entry.outcome === "packaged" ? [] : [{
    ...identity(blobs.find((blob) => blob.locatorId === entry.locatorId)!),
    code: entry.outcome,
    locatorId: entry.locatorId,
    blobRecordIds: entry.blobRecordIds,
    sourceOccurrences: entry.sourceOccurrences,
    message: warningMessage(entry.outcome, blobs.find((blob) => blob.locatorId === entry.locatorId)!),
  }]);
  return { results, warnings };
}

export async function buildFullExportArchive(
  manifest: FullExportManifest,
  onProgress?: (completed: number, total: number) => void,
  fetcher: typeof fetch = fetch,
  options: FullExportOptions = {},
) {
  const build = beginBuild(manifest, options);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const [name, rows] of Object.entries(manifest.tables)) {
    addMetadata(zip, `tables/${safeSegment(name)}.json`, JSON.stringify(rows, null, 2), build);
  }

  const { results, warnings } = await packageExportBlobs(zip, manifest.blobs, onProgress, fetcher, false, build);
  addMetadata(zip, "export-manifest.json", JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    exportedAt: manifest.exportedAt,
    tables: Object.fromEntries(Object.entries(manifest.tables).map(([name, rows]) => [name, {
      rowCount: rows.length,
      path: `tables/${safeSegment(name)}.json`,
    }])),
    blobs: results,
  }, null, 2), build);
  addMetadata(zip, "export-warnings.json", JSON.stringify(warnings, null, 2), build);

  return {
    archive: await generateArchive(zip, build),
    warnings,
    results,
  };
}

async function buildVersionedFullExportArchive(
  version: 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26,
  input: unknown,
  onProgress?: (completed: number, total: number) => void,
  fetcher: typeof fetch = fetch,
  options: FullExportOptions = {},
) {
  const build = beginBuild(input, options);
  const manifest = version === 8 ? await validateFullExportV8(input)
    : version === 9 ? await validateFullExportV9(input)
      : version === 10 ? await validateFullExportV10(input)
        : version === 11 ? await validateFullExportV11(input)
          : version === 12 ? await validateFullExportV12(input)
            : version === 13 ? await validateFullExportV13(input)
              : version === 14 ? await validateFullExportV14(input)
                : version === 15 ? await validateFullExportV15(input) : version === 16 ? await validateFullExportV16(input) : version === 17 ? await validateFullExportV17(input) : version === 18 ? await validateFullExportV18(input) : version === 19 ? await validateFullExportV19(input) : version === 20 ? await validateFullExportV20(input) : version === 21 ? await validateFullExportV21(input) : version === 22 ? await validateFullExportV22(input) : version === 23 ? await validateFullExportV23(input) : version === 24 ? await validateFullExportV24(input) : version === 25 ? await validateFullExportV25(input) : await validateFullExportV26(input);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const paths = new Set(["export-manifest.json", "export-warnings.json"]);
  const tables: Record<string, { rowCount: number; path: string; byteSize: number; sha256: string }> = {};
  for (const [name, rows] of Object.entries(manifest.tables)) {
    const artifact = await createExportArtifact(`tables/${name}.json`, rows);
    addMetadata(zip, artifact.path, exportArtifactText(rows), build);
    paths.add(artifact.path);
    tables[name] = { rowCount: rows.length, path: artifact.path, byteSize: artifact.byteSize, sha256: artifact.sha256 };
  }
  const artifacts = Object.fromEntries(Object.entries(manifest.artifacts).map(([name, artifact]) => {
    addMetadata(zip, artifact.path, exportArtifactText(artifact.value), build);
    paths.add(artifact.path);
    return [name, { path: artifact.path, byteSize: artifact.byteSize, sha256: artifact.sha256 }];
  }));
  const { results, warnings } = await packageExportBlobs(zip, manifest.blobs, onProgress, fetcher, version >= 15, build);
  for (const result of results) if (result.path) paths.add(result.path);
  addMetadata(zip, "export-manifest.json", JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    archiveWriter: manifest.archiveWriter,
    ...(manifest.schemaVersion !== 8 ? { archiveProfile: manifest.archiveProfile } : {}),
    exportedAt: manifest.exportedAt,
    tables,
    artifacts,
    blobs: results,
    ...(manifest.schemaVersion === 23 || manifest.schemaVersion === 24 || manifest.schemaVersion === 25 || manifest.schemaVersion === 26 ? { excludedOutputs: manifest.excludedOutputs } : {}),
    ...(manifest.schemaVersion === 24 || manifest.schemaVersion === 25 || manifest.schemaVersion === 26 ? { relocatedSources: manifest.relocatedSources, backupHoldOwner: manifest.backupHoldOwner } : {}),
  }, null, 2), build);
  addMetadata(zip, "export-warnings.json", JSON.stringify(warnings, null, 2), build);
  const files = Object.values(zip.files).filter((file) => !file.dir);
  if (files.length !== paths.size || files.some((file) => !paths.has(file.name))) throw new Error("Full export ZIP inventory differs from its manifest");
  return {
    archive: await generateArchive(zip, build),
    warnings,
    results,
  };
}

export function buildFullExportArchiveV8(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(8, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV9(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(9, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV10(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(10, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV11(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(11, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV12(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(12, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV13(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(13, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV14(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(14, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV15(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(15, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV16(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(16, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV17(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(17, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV18(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(18, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV19(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(19, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV20(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(20, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV21(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(21, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV22(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(22, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV23(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(23, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV24(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(24, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV25(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(25, input, onProgress, fetcher, options);
}

export function buildFullExportArchiveV26(input: unknown, onProgress?: (completed: number, total: number) => void, fetcher: typeof fetch = fetch, options: FullExportOptions = {}) {
  return buildVersionedFullExportArchive(26, input, onProgress, fetcher, options);
}
