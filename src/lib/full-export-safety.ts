// Application capacity budgets, not estimates or guarantees of browser heap use.
// Compression, the manifest, buffers and the download Blob also consume memory.
export const FULL_EXPORT_ASSET_MAX_BYTES = 50_000_000;
export const FULL_EXPORT_METADATA_MAX_BYTES = 8_000_000;
export const FULL_EXPORT_ARCHIVE_MAX_BYTES = 64_000_000;

export interface FullExportLimits { assetBytes: number; metadataBytes: number; archiveBytes: number }
export interface FullExportProgress {
  stage: "preparing" | "reading" | "verifying" | "compressing";
  completed: number; total: number; bytesRead: number; percent?: number;
}
export interface FullExportOptions {
  signal?: AbortSignal;
  limits?: Partial<FullExportLimits>;
  onStageProgress?: (progress: FullExportProgress) => void;
}
export class FullExportCapacityError extends Error {
  readonly code = "export_capacity";
  constructor(readonly budget: "asset" | "metadata" | "archive", readonly maximum: number) {
    super(`The browser export exceeds its ${maximum.toLocaleString("en-US")}-byte ${budget} limit. Use an available durable export workflow for a larger backup.`);
    this.name = "FullExportCapacityError";
  }
}
export function fullExportLimits(options: FullExportOptions = {}): FullExportLimits {
  const limits = { assetBytes: FULL_EXPORT_ASSET_MAX_BYTES, metadataBytes: FULL_EXPORT_METADATA_MAX_BYTES,
    archiveBytes: FULL_EXPORT_ARCHIVE_MAX_BYTES, ...options.limits };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0)) throw new TypeError("Export limits must be non-negative safe integers.");
  return limits;
}
export function checkFullExportAbort(signal?: AbortSignal) { signal?.throwIfAborted(); }
export function isFullExportInterruption(error: unknown, signal?: AbortSignal) {
  return signal?.aborted || error instanceof FullExportCapacityError
    || error instanceof Error && error.name === "AbortError";
}
export function exportTextBytes(value: string) { return new TextEncoder().encode(value).byteLength; }
export function preflightFullExport(input: unknown, limits: FullExportLimits) {
  const serialized = JSON.stringify(input);
  if (typeof serialized !== "string" || exportTextBytes(serialized) > limits.metadataBytes) throw new FullExportCapacityError("metadata", limits.metadataBytes);
  let known = 0;
  const blobs = input && typeof input === "object" && "blobs" in input ? (input as { blobs: unknown }).blobs : undefined;
  if (Array.isArray(blobs)) for (const entry of blobs) {
    if (entry && typeof entry === "object" && entry.downloadUrl && Number.isSafeInteger(entry.expectedByteSize) && entry.expectedByteSize >= 0) {
      if (entry.expectedByteSize > limits.assetBytes - known) throw new FullExportCapacityError("asset", limits.assetBytes);
      known += entry.expectedByteSize;
    }
  }
}

/** Count actual response bytes before allocating the final contiguous buffer.
 * The caller supplies its remaining aggregate budget, including failed assets. */
export async function readBoundedExportResponse(response: Response, maximum: number, signal?: AbortSignal,
  onBytes?: (received: number) => void, budget: "asset" | "metadata" = "asset", reportedMaximum = maximum): Promise<Uint8Array<ArrayBuffer>> {
  if (signal?.aborted) {
    void response.body?.cancel(signal.reason).catch(() => undefined);
    checkFullExportAbort(signal);
  }
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("Invalid remaining export byte budget.");
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximum) {
    void response.body?.cancel().catch(() => undefined);
    throw new FullExportCapacityError(budget, reportedMaximum);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0, complete = false;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      checkFullExportAbort(signal); const item = await reader.read(); checkFullExportAbort(signal);
      if (item.done) { complete = true; break; }
      if (!(item.value instanceof Uint8Array)) throw new Error("Export response did not supply byte chunks.");
      if (item.value.byteLength > maximum - length) throw new FullExportCapacityError(budget, reportedMaximum);
      chunks.push(item.value); length += item.value.byteLength; onBytes?.(length);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { checkFullExportAbort(signal); bytes.set(chunk, offset); offset += chunk.byteLength; }
    checkFullExportAbort(signal); return bytes;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!complete) cancel();
    chunks.length = 0; reader.releaseLock();
  }
}
