import type { FullExportManifestV13 } from "../../shared/contracts/export";
import type {
  TemplateRecord,
  ProcessTemplateVersionSummary,
  ProcessTemplateFamilySummary,
  ProcessTemplateFamilyOption,
  MetrologyTemplateSummary,
  TemplateDetail,
  MetrologyTemplateReference,
  TemplateStepInput,
  MetrologyTemplateInput,
} from "../../shared/contracts/template";
import type { ApplyPlanUpdateInput, ConfirmRunStepsInput, CreateCommentSubmissionInput, CreateMetrologyRunEntryInput, CreateRecordInput, CreateRunStepCommentsInput, CreateRunStepInput, CreateSampleInput, CreateStateVerificationInput, DeleteRunInput, DeleteSampleInput, FinishProcessRunInput, ManagedStorageStatus, PaginationMeta, PlanUpdatePreview, ProcessingSampleDetail, RunStartPreview, SampleDeletionImpact, SampleDetail, SampleDirectoryFilterOptions, SampleDirectorySort, SampleListResponse, SampleStatus, SplitSampleInput, StartMetrologyRunInput, StartProcessRunInput, StateVerification, UpdateRunStepInput, UpdateSampleInput } from "../../shared/types";
import { createDurableCommentSubmission, uploadDurableCommentItem, finalizeDurableCommentSubmission, cancelDurableCommentSubmission, removeDurableCommentItem, getCommentAcceptance } from "./comment-submission-client";
import { uploadR2Asset, type R2UploadOptions } from "./r2-upload-client";
import { uploadMetrologyReference } from "./metrology-reference-upload-client";
import { submitFabubloxImport } from "./fabublox-import-client";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export interface SampleListOptions {
  query?: string;
  page?: number;
  pageSize?: number;
  view?: "samples" | "processing";
  matchingRun?: {
    recipeFamilyId: string;
    runKind: "process" | "metrology";
    status: "active" | "complete" | "cancelled" | "superseded";
  };
  status?: "active" | "complete" | "cancelled" | "all";
  sampleStatus?: SampleStatus;
  location?: string;
  parent?: string;
  workflow?: string;
  sort?: SampleDirectorySort;
  signal?: AbortSignal;
}

function sampleListPath(options: SampleListOptions | string) {
  const normalized = typeof options === "string" ? { query: options } : options;
  const params = new URLSearchParams();
  if (normalized.query?.trim()) params.set("q", normalized.query.trim());
  if (normalized.page && normalized.page > 1) params.set("page", String(normalized.page));
  if (normalized.pageSize) params.set("pageSize", String(normalized.pageSize));
  if (normalized.matchingRun?.recipeFamilyId.trim()) {
    params.set("runFamily", normalized.matchingRun.recipeFamilyId.trim());
    params.set("runKind", normalized.matchingRun.runKind);
    params.set("runStatus", normalized.matchingRun.status);
  }
  if (normalized.view === "processing") params.set("view", "processing");
  if (normalized.view === "processing") {
    if (normalized.status && normalized.status !== "active") params.set("status", normalized.status);
  } else {
    if (normalized.sampleStatus) params.set("status", normalized.sampleStatus);
    if (normalized.location?.trim()) params.set("location", normalized.location.trim());
    if (normalized.parent?.trim()) params.set("parent", normalized.parent.trim());
    if (normalized.workflow?.trim()) params.set("process", normalized.workflow.trim());
    if (normalized.sort) params.set("sort", normalized.sort);
  }
  const query = params.toString();
  return `/samples${query ? `?${query}` : ""}`;
}

function paginatedPath(path: string, options: { query?: string; page?: number; pageSize?: number }) {
  const params = new URLSearchParams();
  if (options.query?.trim()) params.set("q", options.query.trim());
  if (options.page && options.page > 1) params.set("page", String(options.page));
  if (options.pageSize) params.set("pageSize", String(options.pageSize));
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

export const api = {
  listSamples: (options: SampleListOptions | string = {}) => {
    const signal = typeof options === "string" ? undefined : options.signal;
    return request<SampleListResponse>(sampleListPath(options), signal ? { signal } : undefined);
  },
  listSampleDirectoryOptions: (signal?: AbortSignal) =>
    request<SampleDirectoryFilterOptions>("/sample-directory-options", signal ? { signal } : undefined),
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
  finishProcessRun: (sampleId: string, runId: string, input: FinishProcessRunInput) => request<{ ok: true; completedAt: string; skippedStepCount: number }>(`/samples/${sampleId}/runs/${runId}/finish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  deleteRun: (sampleId: string, runId: string, input: DeleteRunInput) => request<{ ok: true; updatedAt: string }>(`/samples/${sampleId}/runs/${runId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  restoreRun: (sampleId: string, runId: string, input: DeleteRunInput) => request<{ ok: true; updatedAt: string }>(`/samples/${sampleId}/runs/${runId}/restore`, {
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
  createMetrologyRunEntry: (sampleId: string, runId: string, input: CreateMetrologyRunEntryInput) => request<{ id: string }>(`/samples/${sampleId}/runs/${runId}/metrology`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  startMetrologyRun: (sampleId: string, input: StartMetrologyRunInput) => request<{ id: string }>(`/samples/${sampleId}/metrology-runs`, {
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
  uploadAsset: (file: Blob, filename: string, options?: R2UploadOptions) => uploadR2Asset(file, filename, "ordinary_image", options),
  getManagedStorageStatus: () => request<ManagedStorageStatus>("/storage/status"),
  createCommentSubmission: createDurableCommentSubmission,
  getCommentSubmissionAcceptance: getCommentAcceptance,
  uploadCommentSubmissionItem: uploadDurableCommentItem,
  markCommentSubmissionItemFailed: (submissionId: string, itemId: string, error: string) => request<{ ok: true }>(
    `/comment-submissions/${encodeURIComponent(submissionId)}/items/${encodeURIComponent(itemId)}/fail`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error }),
    },
  ),
  removeCommentSubmissionItem: removeDurableCommentItem,
  finalizeCommentSubmission: finalizeDurableCommentSubmission,
  cancelCommentSubmission: cancelDurableCommentSubmission,
  deleteCommentSubmission: (submissionId: string) => request<{ ok: true }>(
    `/comment-submissions/${encodeURIComponent(submissionId)}`,
    { method: "DELETE" },
  ),
  listTemplates: (signal?: AbortSignal) => request<{ templates: TemplateRecord[] }>("/templates?view=picker", signal ? { signal } : undefined),
  listTemplateFamilies: (options: { query?: string; page?: number; pageSize?: number; signal?: AbortSignal } = {}) =>
    request<{ families: ProcessTemplateFamilySummary[]; pagination: PaginationMeta }>(
      paginatedPath("/template-families", options),
      options.signal ? { signal: options.signal } : undefined,
    ),
  listTemplateFamilyVersions: (recipeFamilyId: string, options: { query?: string; signal?: AbortSignal } = {}) => {
    const params = new URLSearchParams();
    if (options.query?.trim()) params.set("q", options.query.trim());
    const query = params.toString();
    return request<{ versions: ProcessTemplateVersionSummary[] }>(
      `/template-families/${encodeURIComponent(recipeFamilyId)}/versions${query ? `?${query}` : ""}`,
      options.signal ? { signal: options.signal } : undefined,
    );
  },
  listTemplateFamilyOptions: (signal?: AbortSignal) =>
    request<{ families: ProcessTemplateFamilyOption[] }>("/template-families/options", signal ? { signal } : undefined),
  listMetrologyTemplates: (options: { query?: string; page?: number; pageSize?: number; signal?: AbortSignal } = {}) =>
    request<{ templates: MetrologyTemplateSummary[]; pagination: PaginationMeta }>(
      paginatedPath("/metrology-templates", options),
      options.signal ? { signal: options.signal } : undefined,
    ),
  createMetrologyTemplate: (input: MetrologyTemplateInput) => request<{ id: string; version: number }>("/metrology-templates", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  updateMetrologyTemplate: (id: string, input: MetrologyTemplateInput) => request<{ ok: true }>(`/metrology-templates/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  updateMetrologyTemplateNotes: (id: string, notes: string) => request<{ ok: true }>(`/metrology-templates/${id}/notes`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes }),
  }),
  uploadMetrologyTemplateReference: (id: string, file: File) => uploadMetrologyReference(id, file),
  deleteMetrologyTemplateReference: (id: string, referenceId: string) => request<{ ok: true }>(`/metrology-templates/${id}/references/${referenceId}`, {
    method: "DELETE",
  }),
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
  deleteTemplateStep: (templateId: string, stepId: string) => request<{ ok: true }>(`/templates/${templateId}/steps/${stepId}`, { method: "DELETE" }),
  getFullExport: () => request<FullExportManifestV13>("/exports/all?archiveSchema=13&archiveWriter=1"),
  importFabublox: submitFabubloxImport,
};

export type {
  TemplateRecord,
  ProcessTemplateVersionSummary,
  ProcessTemplateFamilySummary,
  ProcessTemplateFamilyOption,
  MetrologyTemplateSummary,
  TemplateStepRecord,
  TemplateDetail,
  MetrologyTemplateReference,
  TemplateStepInput,
  MetrologyTemplateInput,
} from "../../shared/contracts/template";
