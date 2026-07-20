import type { ConfirmRunStepsInput, CreateRecordInput, CreateRunStepCommentsInput, CreateRunStepInput, CreateSampleInput, CreateStateVerificationInput, FabubloxImportPreview, FullExportManifest, PlanUpdatePreview, SampleDetail, SampleSummary, StateVerification, UpdateRunStepInput, UpdateSampleInput } from "../../shared/types";
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
  createSample: (input: CreateSampleInput) => request<{ id: string }>("/samples", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  updateSample: (id: string, input: UpdateSampleInput) => request<{ ok: true; updatedAt: string }>(`/samples/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  createRecord: (id: string, input: CreateRecordInput) => request<{ ok: true; updatedAt: string }>(`/samples/${id}/records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  assignTemplate: (sampleId: string, templateVersionId: string) => request<{ id: string }>(`/samples/${sampleId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateVersionId }),
  }),
  previewPlanUpdate: (sampleId: string, runId: string, templateVersionId: string) => request<PlanUpdatePreview & { familyMismatch?: boolean }>(`/samples/${sampleId}/runs/${runId}/plan-update/preview`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateVersionId }),
  }),
  applyPlanUpdate: (sampleId: string, runId: string, templateVersionId: string, reason = "") => request<{ ok: true; planRevisionId: string; revisionNumber: number }>(`/samples/${sampleId}/runs/${runId}/plan-update`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateVersionId, reason }),
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
  listTemplates: () => request<{ templates: TemplateRecord[] }>("/templates"),
  getTemplate: (id: string) => request<{ template: TemplateDetail }>(`/templates/${id}`),
  updateTemplate: (id: string, input: { name: string; version: number }) => request<{ ok: true }>(`/templates/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  archiveTemplate: (id: string) => request<{ ok: true }>(`/templates/${id}`, { method: "DELETE" }),
  cloneTemplate: (id: string) => request<{ id: string; version: number }>(`/templates/${id}/clone`, { method: "POST" }),
  createTemplateStep: (templateId: string, input: TemplateStepInput) => request<{ id: string }>(`/templates/${templateId}/steps`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  updateTemplateStep: (templateId: string, stepId: string, input: TemplateStepInput) => request<{ ok: true }>(`/templates/${templateId}/steps/${stepId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  getFullExport: () => request<FullExportManifest>("/exports/all"),
  importFabublox: async (file: File, preview: FabubloxImportPreview, templateType: TemplateRecord["templateType"], recipeFamilyId?: string) => {
    const form = new FormData();
    form.append("workbook", file, file.name);
    const manifest = { ...preview, images: preview.images.map(({ data: _data, ...image }) => image), templateType, recipeFamilyId: recipeFamilyId || null };
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
