import { api } from "./api";
import { buildFullExportInWorker } from "./full-export-worker-client";
import { checkFullExportAbort, type FullExportOptions } from "./full-export-safety";

// Preserve the historical builder entry points for archive readers and tests.
export * from "./full-export-archive";
export type { FullExportOptions, FullExportProgress } from "./full-export-safety";

export async function exportAll(onProgress?: (completed: number, total: number) => void, options: FullExportOptions = {}) {
  checkFullExportAbort(options.signal);
  options.onStageProgress?.({ stage: "preparing", completed: 0, total: 0, bytesRead: 0 });
  checkFullExportAbort(options.signal);
  const manifest = await api.getFullExport(options.signal);
  checkFullExportAbort(options.signal);
  const result = await buildFullExportInWorker(manifest, onProgress, options);
  checkFullExportAbort(options.signal);
  return { ...result, filename: `sample-log-${manifest.exportedAt.slice(0, 10)}.zip` };
}
