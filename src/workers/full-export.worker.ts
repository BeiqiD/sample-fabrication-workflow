import { buildFullExportArchiveV26 } from "../lib/full-export-archive";
import { FullExportCapacityError, type FullExportLimits } from "../lib/full-export-safety";
import type { FullExportWorkerReply } from "../lib/full-export-worker-client";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ type: "build"; manifest: unknown; limits: FullExportLimits } | { type: "cancel" }>) => void) | null;
  postMessage(message: FullExportWorkerReply): void;
};
let controller: AbortController | null = null;
scope.onmessage = event => {
  if (event.data.type === "cancel") { controller?.abort(); return; }
  if (controller) return;
  const active = new AbortController(); controller = active;
  const { manifest, limits } = event.data;
  void buildFullExportArchiveV26(manifest, (completed, total) => {
    scope.postMessage({ type: "assets", completed, total });
  }, fetch, { signal: active.signal, limits, onStageProgress: progress => scope.postMessage({ type: "progress", progress }) })
    .then(result => { if (!active.signal.aborted) scope.postMessage({ type: "complete", result }); })
    .catch((error: unknown) => {
      scope.postMessage({ type: "error", name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "Full export failed.",
        ...(error instanceof FullExportCapacityError ? { code: error.code, budget: error.budget, maximum: error.maximum } : {}) });
    });
};
