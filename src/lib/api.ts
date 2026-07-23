import type { ApplyPlanUpdateInput, ConfirmRunStepsInput, CreateCommentSubmissionInput, CreateRecordInput, CreateRunStepCommentsInput, CreateRunStepInput, CreateSampleInput, CreateStateVerificationInput, DeleteSampleInput, FabubloxImportPreview, FinishProcessRunInput, FullExportManifest, ManagedStorageStatus, PlanUpdatePreview, ProcessingSampleDetail, RunStartPreview, SampleDeletionImpact, SampleDetail, SampleSummary, SplitSampleInput, StartProcessRunInput, StateVerification, UpdateRunStepInput, UpdateSampleInput } from "../../shared/types";
import { compressLayerStackImage } from "./images";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  listSamples: (query = "") => request<{ samples: SampleSummary[] }>(`/samples?q=${encodeURIComponent(query)}`),
  getSample: (id: string) => request<SampleDetail>(`/samples/${id}`),
  getProcessingSample: (id: string) => request<ProcessingSampleDetail>(`/samples/${id}?view=processing`),
  createSample: (input: CreateSampleInput) => request<{ id: string }>("/samples", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  splitSample: (id: string, input: SplitSampleInput) => request<{ children: Array<{ id: string; code: string }>; updatedAt: string }>(`/samples/${id}/split`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  updateSample: (id: string, input: UpdateSampleInput) => request<{ ok: true; updatedAt: string }>(`/samples/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  deleteSample: (id: string, input: DeleteSampleInput) => request<{ ok: true; deleted: SampleDeletionImpact }>(`/samples/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  createRecord: (id: string, input: CreateRecordInput) => request<{ ok: true; updatedAt: string }>(`/samples/${id}/records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  deleteSampleRecord: (sampleId: string, eventId: string) => request<{ ok: true; updatedAt: string }>(`/samples/${sampleId}/records/${eventId}`, {
    method: "DELETE",
  }),
  deleteEventAsset: (sampleId: string, eventId: string) => request<{ ok: true; updatedAt: string }>(`/samples/${sampleId}/events/${eventId}/asset`, {
    method: "DELETE",
  }),
  previewRunStart: (sampleId: string, templateVersionId: string) => request<RunStartPreview>(`/samples/${sampleId}/runs/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateVersionId }),
  }),
  startProcessRun: (sampleId: string, input: StartProcessRunInput) => request<{ id: string }>(`/samples/${sampleId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  finishProcessRun: (sampleId: string, runId: string, input: FinishProcessRunInput) => request<{ ok: true; completedAt: string }>(`/samples/${sampleId}/runs/${runId}/finish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  previewPlanUpdate: (sampleId: string, runId: string, templateVersionId: string) => request<PlanUpdatePreview & { familyMismatch?: boolean }>(`/samples/${sampleId}/runs/${runId}/plan-update/preview`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateVersionId }),
  }),
  applyPlanUpdate: (sampleId: string, runId: string, input: ApplyPlanUpdateInput) => request<{ ok: true; planRevisionId: string; revisionNumber: number }>(`/samples/${sampleId}/runs/${runId}/plan-update`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  updateRunStep: (sampleId: string, runId: string, stepId: string, input: UpdateRunStepInput) => request<{ ok: true }>(`/samples/${sampleId}/runs/${runId}/steps/${stepId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  createRunStep: (sampleId: string, runId: string, input: CreateRunStepInput) => request<{ id: string }>(`/samples/${sampleId}/runs/${runId}/steps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  addRunStepComments: (input: CreateRunStepCommentsInput) => request<{ ok: true; operationGroupId: string }>("/run-step-comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  deleteRunStepComment: (commentId: string) => request<{ ok: true; deleted: number }>(`/run-step-comments/${commentId}`, {
    method: "DELETE",
  }),
  deleteRunStepCommentAsset: (commentId: string) => request<{ ok: true; updatedAt: string }>(`/run-step-comments/${commentId}/asset`, {
    method: "DELETE",
  }),
  deleteRunStepAsset: (sampleId: string, runId: string, stepId: string, assetKey: string) => request<{ ok: true; updatedAt: string }>(`/samples/${sampleId}/runs/${runId}/steps/${stepId}/assets`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetKey }),
  }),
  confirmRunSteps: (input: ConfirmRunStepsInput) => request<{ ok: true; confirmed: number }>("/run-steps/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  verifyState: (sampleId: string, runId: string, stepId: string, input: CreateStateVerificationInput) => request<{ verification: StateVerification }>(`/samples/${sampleId}/runs/${runId}/steps/${stepId}/verify-state`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  uploadAsset: async (file: Blob, filename: string) => request<{ id: string; key: string; deduplicated: boolean }>("/assets", {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream", "x-filename": filename },
    body: file,
  }),
  getManagedStorageStatus: () => request<ManagedStorageStatus>("/storage/status"),
  createCommentSubmission: (input: CreateCommentSubmissionInput) => request<{ id: string; deduplicated: boolean }>("/comment-submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  uploadCommentSubmissionItem: (
    submissionId: string,
    itemId: string,
    file: File,
    sha256: string | null,
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
  ) => new Promise<{ ok: true; deduplicated: boolean }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/comment-submissions/${encodeURIComponent(submissionId)}/items/${encodeURIComponent(itemId)}/content`);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-upload-size", String(file.size));
    if (sha256) xhr.setRequestHeader("x-content-sha256", sha256);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))));
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        try { resolve(JSON.parse(xhr.responseText) as { ok: true; deduplicated: boolean }); }
        catch { reject(new Error("The upload completed but returned an invalid response")); }
        return;
      }
      try {
        const payload = JSON.parse(xhr.responseText) as { error?: string };
        reject(new Error(payload.error || `Upload failed (${xhr.status})`));
      } catch { reject(new Error(`Upload failed (${xhr.status})`)); }
    });
    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.addEventListener("abort", () => reject(new DOMException("Upload cancelled", "AbortError")));
    if (signal) {
      if (signal.aborted) xhr.abort();
      else signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(file);
    onProgress(0);
  }),
  markCommentSubmissionItemFailed: (submissionId: string, itemId: string, error: string) => request<{ ok: true }>(
    `/comment-submissions/${encodeURIComponent(submissionId)}/items/${encodeURIComponent(itemId)}/fail`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error }),
    },
  ),
  removeCommentSubmissionItem: (submissionId: string, itemId: string) => request<{ ok: true }>(
    `/comment-submissions/${encodeURIComponent(submissionId)}/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE" },
  ),
  finalizeCommentSubmission: (submissionId: string) => request<{ ok: true; status: "ready" }>(
    `/comment-submissions/${encodeURIComponent(submissionId)}/finalize`,
    { method: "POST" },
  ),
  cancelCommentSubmission: (submissionId: string) => request<{ ok: true }>(
    `/comment-submissions/${encodeURIComponent(submissionId)}/cancel`,
    { method: "POST" },
  ),
  deleteCommentSubmission: (submissionId: string) => request<{ ok: true }>(
    `/comment-submissions/${encodeURIComponent(submissionId)}`,
    { method: "DELETE" },
  ),
  listTemplates: () => request<{ templates: TemplateRecord[] }>("/templates"),
  getTemplate: (id: string) => request<{ template: TemplateDetail }>(`/templates/${id}`),
  updateTemplate: (id: string, input: { name: string; version: number }) => request<{ ok: true }>(`/templates/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  removeTemplate: (id: string) => request<{ ok: true; disposition: "deleted" | "archived" }>(`/templates/${id}`, { method: "DELETE" }),
  cloneTemplate: (id: string) => request<{ id: string; version: number }>(`/templates/${id}/clone`, { method: "POST" }),
  createTemplateStep: (templateId: string, input: TemplateStepInput) => request<{ id: string }>(`/templates/${templateId}/steps`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  updateTemplateStep: (templateId: string, stepId: string, input: TemplateStepInput) => request<{ ok: true }>(`/templates/${templateId}/steps/${stepId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  deleteTemplateStepImage: (templateId: string, stepId: string, assetKey: string) => request<{ ok: true }>(`/templates/${templateId}/steps/${stepId}/images`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetKey }),
  }),
  getFullExport: () => request<FullExportManifest>("/exports/all"),
  importFabublox: async (file: File, preview: FabubloxImportPreview, recipeFamilyId?: string) => {
    const form = new FormData();
    form.append("workbook", file, file.name);
    const manifest = { ...preview, images: preview.images.map(({ data: _data, ...image }) => image), recipeFamilyId: recipeFamilyId || null };
    form.append("manifest", new Blob([JSON.stringify(manifest)], { type: "application/json" }), "manifest.json");
    for (const image of preview.images) {
      const sourceName = image.sourcePart.split("/").pop() || `${image.localId}.png`;
      const source = new File([new Uint8Array(image.data)], sourceName, { type: image.mimeType });
      const compressed = await compressLayerStackImage(source);
      form.append(`image:${image.localId}`, compressed, compressed.name);
    }
    return request<{ id: string; templateVersionId: string; version: number }>("/imports/fabublox", { method: "POST", body: form });
  },
};

export interface TemplateRecord {
  id: string;
  recipeFamilyId: string;
  name: string;
  templateType: "process" | "module" | "recipe";
  version: number;
  manifestHash: string;
  sourceFilename: string | null;
  stepCount: number;
  initialStateHash: string | null;
  initialStateImageKeys: string[];
  initialSubstrateStep: FabubloxImportPreview["initialSubstrateStep"];
  locked: boolean;
  lockedAt: string | null;
  createdAt: string;
}

export interface TemplateStepRecord {
  id: string;
  logicalStepKey: string;
  definitionHash: string;
  expectedStateHash: string | null;
  position: number;
  sourceRow: number | null;
  stepNumber: string | null;
  sectionName: string | null;
  name: string;
  toolName: string | null;
  parametersText: string | null;
  commentsText: string | null;
  imageKeys: string[];
}

export interface TemplateDetail extends Omit<TemplateRecord, "stepCount"> {
  archived: boolean;
  steps: TemplateStepRecord[];
}

export interface TemplateStepInput {
  name: string;
  toolName: string;
  parametersText: string;
  commentsText: string;
  assetKey?: string;
}
