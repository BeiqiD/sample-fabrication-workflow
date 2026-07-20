import type { CreateEventInput, CreateSampleInput, FabubloxImportPreview, FullExportManifest, SampleDetail, SampleSummary, StepStatus, UpdateSampleInput } from "../../shared/types";
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
  createEvent: (id: string, input: CreateEventInput) => request<{ id: string }>(`/samples/${id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  assignTemplate: (sampleId: string, templateVersionId: string) => request<{ id: string }>(`/samples/${sampleId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateVersionId }),
  }),
  updateRunStep: (sampleId: string, runId: string, stepId: string, status: StepStatus, notes: string) => request<{ ok: true }>(`/samples/${sampleId}/runs/${runId}/steps/${stepId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, notes }),
  }),
  uploadAsset: async (file: Blob, filename: string) => request<{ key: string }>("/assets", {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream", "x-filename": filename },
    body: file,
  }),
  listTemplates: () => request<{ templates: TemplateRecord[] }>("/templates"),
  getFullExport: () => request<FullExportManifest>("/exports/all"),
  createTemplate: (input: CreateTemplateInput) => request<{ id: string; version: number }>("/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  importFabublox: async (file: File, preview: FabubloxImportPreview, templateType: TemplateRecord["templateType"]) => {
    const form = new FormData();
    form.append("workbook", file, file.name);
    const manifest = { ...preview, images: preview.images.map(({ data: _data, ...image }) => image), templateType };
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
  name: string;
  templateType: "process" | "module" | "recipe";
  version: number;
  sourceFilename: string | null;
  stepCount: number;
  createdAt: string;
}

export interface CreateTemplateInput {
  name: string;
  templateType: TemplateRecord["templateType"];
  sourceFilename: string;
  sourceAssetKey: string;
  content: unknown;
}
