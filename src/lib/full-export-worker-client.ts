import type { buildFullExportArchiveV26 } from "./full-export-archive";
import { checkFullExportAbort, FullExportCapacityError, fullExportLimits, preflightFullExport,
  type FullExportOptions, type FullExportProgress } from "./full-export-safety";

type ArchiveResult = Awaited<ReturnType<typeof buildFullExportArchiveV26>>;
export type FullExportWorkerReply =
  | { type: "assets"; completed: number; total: number }
  | { type: "progress"; progress: FullExportProgress }
  | { type: "complete"; result: ArchiveResult }
  | { type: "error"; name: string; message: string; code?: string; budget?: "asset" | "metadata" | "archive"; maximum?: number };

/** One worker per admitted export. Termination releases its fetches, source
 * buffers and compressor even when compression is currently using the CPU. */
export async function buildFullExportInWorker(manifest: unknown, onProgress?: (completed: number, total: number) => void,
  options: FullExportOptions = {}): Promise<ArchiveResult> {
  checkFullExportAbort(options.signal);
  const limits = fullExportLimits(options); preflightFullExport(manifest, limits);
  if (typeof Worker === "undefined") return Promise.reject(new Error("This browser cannot run the export worker. Use a browser with Web Worker support or an available durable export workflow."));
  const worker = new Worker(new URL("../workers/full-export.worker.ts", import.meta.url), { type: "module", name: "full-content-export" });
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => { options.signal?.removeEventListener("abort", abort); worker.onmessage = null;
      worker.onerror = null; worker.onmessageerror = null; worker.terminate(); };
    const fail = (error: unknown) => { if (settled) return; settled = true; release(); reject(error); };
    const abort = () => { try { worker.postMessage({ type: "cancel" }); } finally {
      fail(options.signal?.reason ?? new DOMException("Export cancelled.", "AbortError"));
    } };
    worker.onmessage = (event: MessageEvent<FullExportWorkerReply>) => {
      if (settled) return;
      try {
        checkFullExportAbort(options.signal);
        const message = event.data;
        if (message.type === "assets") onProgress?.(message.completed, message.total);
        else if (message.type === "progress") options.onStageProgress?.(message.progress);
        else if (message.type === "complete") { settled = true; release(); resolve(message.result); }
        else if (message.type === "error") {
          const error = message.code === "export_capacity" && message.budget && typeof message.maximum === "number"
            ? new FullExportCapacityError(message.budget, message.maximum) : new Error(message.message);
          error.name = message.name; fail(error);
        } else fail(new Error("The export worker returned an invalid response."));
      } catch (error) { fail(error); }
    };
    worker.onerror = () => fail(new Error("The export worker failed. Retry the export or use an available durable export workflow."));
    worker.onmessageerror = () => fail(new Error("The export worker returned an unreadable result."));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else { try { worker.postMessage({ type: "build", manifest, limits }); } catch (error) { fail(error); } }
  });
}
