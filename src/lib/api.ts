import type { CreateEventInput, CreateSampleInput, SampleDetail, SampleSummary } from "../../shared/types";

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
  createEvent: (id: string, input: CreateEventInput) => request<{ id: string }>(`/samples/${id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  uploadAsset: async (file: Blob, filename: string) => request<{ key: string }>("/assets", {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream", "x-filename": filename },
    body: file,
  }),
  listTemplates: () => request<{ templates: TemplateRecord[] }>("/templates"),
  createTemplate: (input: CreateTemplateInput) => request<{ id: string; version: number }>("/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
};

export interface TemplateRecord {
  id: string;
  name: string;
  templateType: "process" | "module" | "recipe";
  version: number;
  sourceFilename: string | null;
  createdAt: string;
}

export interface CreateTemplateInput {
  name: string;
  templateType: TemplateRecord["templateType"];
  sourceFilename: string;
  sourceAssetKey: string;
  content: unknown;
}
