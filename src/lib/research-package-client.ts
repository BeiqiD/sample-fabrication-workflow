import {
  checkedResearchExecutorStatus, checkedResearchExportInput, checkedResearchExportPlanInput,
  checkedResearchImportInput, checkedResearchJobControl, checkedResearchJobStatus,
  checkedResearchPackagePreview, checkedResearchPreflightError, checkedResearchRequestReceipt, checkedResearchUploadInput,
  RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES,
  type ResearchExportInput, type ResearchExportPlanInput, type ResearchImportInput,
  type ResearchJobControl, type ResearchJobKind, type ResearchPackagePreflightReason, type ResearchRequestReceipt, type ResearchUploadInput,
} from "../../shared/contracts/research-package-api";

const base = "/api/packages";
const preflightMessages: Record<ResearchPackagePreflightReason, string> = {
  definition_media_destination_conflict: "An existing immutable definition uses files in another destination. Keep its original file destination or choose another scope.",
  canonical_definition_conflict: "An immutable definition conflicts with the destination. Resolve that definition conflict before importing.",
  import_plan_budget: "The reconstructed copy exceeds the supported import plan size. Choose a smaller package.",
  publication_row_size_limit: "A record exceeds the supported publication size. Shorten that record or choose another scope.",
  publication_statement_limit: "The copy requires too many publication steps. Choose a package with fewer records.",
  destination_name_preflight_limit: "Too many existing names must be checked. Choose another naming suffix or a smaller scope.",
  destination_name_limit: "An imported name is too long. Choose a shorter naming suffix.",
  destination_name_conflict: "A destination name cannot be assigned safely. Choose another suffix and refresh the preview.",
  unsupported_source_import_state: "This package contains an unfinished foreign import workflow. Finish or resolve that workflow at the source before creating a native copy, or export an offline report.",
};
export class ResearchPackageRequestError extends Error {
  constructor(readonly status: number | null, readonly reason: ResearchPackagePreflightReason | null = null) {
    super(status === 409 && reason ? preflightMessages[reason] : status === 401 || status === 403 ? "Your application access does not allow this research package operation."
      : status === 409 ? "The request conflicts with saved work. Refresh the preview or check the original request."
        : status === 413 ? "This scope exceeds the supported package limits. Choose fewer records or smaller files."
          : status === 410 ? "This package output has expired. Start a new export to download it again."
            : status === 400 || status === 422 ? "This package or request is unsupported. Review its format, completeness and limits."
              : status === 503 ? "Research packages are unavailable. Check File access and storage configuration."
                : "The package response is unavailable. Check the original request before retrying.");
    this.name = "ResearchPackageRequestError";
  }
}
export function researchPackageErrorMessage(error: unknown): string {
  return error instanceof ResearchPackageRequestError ? error.message : "The research package could not be validated. Refresh and try again.";
}
function ensure(condition: unknown, message = "Invalid research package response."): asserts condition {
  if (!condition) throw new Error(message);
}
function identity(value: string): string {
  ensure(typeof value === "string" && value.length > 0 && value.length <= 128 && value !== "." && value !== ".."
    && !/\s|[\x00-\x1f\x7f/\\]/.test(value), "Invalid research operation identity.");
  return encodeURIComponent(value);
}
async function preflightReason(response: Response): Promise<ResearchPackagePreflightReason | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") || !response.body) return null;
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > 1024) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return checkedResearchPreflightError(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).reason;
  } catch { return null; }
  finally { reader.releaseLock(); }
}
async function request(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  const raw = body instanceof Blob;
  try {
    response = await fetch(`${base}${path}`, { method, credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      ...(method === "GET" ? {} : { headers: { "content-type": raw ? "application/zip" : "application/json" },
        body: raw ? body : JSON.stringify(body) }) });
  } catch { throw new ResearchPackageRequestError(null); }
  // Only a bounded, exact static preflight DTO can choose a public error label.
  // Arbitrary provider, archive and SQL details never enter the interface.
  if (!response.ok) throw new ResearchPackageRequestError(response.status, response.status === 409 ? await preflightReason(response) : null);
  try { return await response.json(); } catch { throw new Error("Invalid research package response."); }
}
function receipt(value: unknown, requestId: string, kind?: ResearchJobKind): ResearchRequestReceipt {
  const checked = checkedResearchRequestReceipt(value);
  ensure(checked.requestId === requestId && (!kind || checked.job.kind === kind)); return checked;
}
export const researchPackagesClient = {
  async plan(input: ResearchExportPlanInput, signal?: AbortSignal) {
    const checked = checkedResearchExportPlanInput(input);
    const preview = checkedResearchPackagePreview(await request("/plans", "POST", checked, signal));
    ensure(preview.kind === checked.kind && preview.roots.length === checked.roots.length
      && checked.roots.every(root => preview.roots.some(item => item.kind === root.kind && item.id === root.id)));
    return preview;
  },
  async export(input: ResearchExportInput, signal?: AbortSignal) {
    const checked = checkedResearchExportInput(input);
    return receipt(await request("/jobs", "POST", checked, signal), checked.requestId, checked.kind);
  },
  async acceptUpload(input: ResearchUploadInput, signal?: AbortSignal) {
    const checked = checkedResearchUploadInput(input);
    return receipt(await request("/uploads", "POST", checked, signal), checked.requestId, "upload");
  },
  async upload(jobId: string, file: Blob, signal?: AbortSignal) {
    ensure(file instanceof Blob && file.size > 0 && file.size <= RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, "Invalid package upload size.");
    const job = checkedResearchJobStatus(await request(`/jobs/${identity(jobId)}/upload`, "PUT", file, signal));
    ensure(job.id === jobId && job.kind === "upload"); return job;
  },
  async uploadIntent(jobId: string, signal?: AbortSignal) {
    return checkedResearchUploadInput(await request(`/jobs/${identity(jobId)}/upload-intent`, "GET", undefined, signal));
  },
  async preview(jobId: string, suffix?: string, signal?: AbortSignal) {
    ensure(suffix === undefined || typeof suffix === "string" && suffix.length <= 32 && !/[\x00-\x1f\x7f]/.test(suffix), "Invalid imported name suffix.");
    return checkedResearchPackagePreview(await request(`/jobs/${identity(jobId)}/preview${suffix === undefined ? "" : `?suffix=${encodeURIComponent(suffix)}`}`, "GET", undefined, signal));
  },
  async import(input: ResearchImportInput, signal?: AbortSignal) {
    const checked = checkedResearchImportInput(input);
    ensure(checked.expectedRolePolicyRevision !== null, "An available destination policy must be previewed before import.");
    return receipt(await request("/imports", "POST", checked, signal), checked.requestId, "import");
  },
  async readRequest(requestId: string, signal?: AbortSignal) {
    return receipt(await request(`/requests/${identity(requestId)}`, "GET", undefined, signal), requestId);
  },
  async status(jobId: string, signal?: AbortSignal) {
    const job = checkedResearchJobStatus(await request(`/jobs/${identity(jobId)}`, "GET", undefined, signal));
    ensure(job.id === jobId); return job;
  },
  async list(signal?: AbortSignal) {
    const raw = await request("/jobs", "GET", undefined, signal);
    ensure(raw && typeof raw === "object" && !Array.isArray(raw));
    const value = raw as Record<string, unknown>;
    ensure(Object.keys(value).length === 1 && Array.isArray(value.jobs) && value.jobs.length <= 100);
    const jobs = value.jobs.map(checkedResearchJobStatus); ensure(new Set(jobs.map(job => job.id)).size === jobs.length);
    return jobs;
  },
  async control(jobId: string, action: ResearchJobControl, signal?: AbortSignal) {
    const input = checkedResearchJobControl({ action });
    const job = checkedResearchJobStatus(await request(`/jobs/${identity(jobId)}/control`, "POST", input, signal));
    ensure(job.id === jobId); return job;
  },
  async executor(signal?: AbortSignal) { return checkedResearchExecutorStatus(await request("/executor", "GET", undefined, signal)); },
  downloadUrl(jobId: string) { return `${base}/jobs/${identity(jobId)}/download`; },
};
