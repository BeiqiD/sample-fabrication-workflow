export type SampleStatus = "active" | "stored" | "consumed" | "lost";
export type StepStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked";
export type EventKind = "comment" | "image" | "location" | "status" | "created" | "step";

export interface SampleSummary {
  id: string;
  code: string;
  title: string;
  status: SampleStatus;
  location: string | null;
  parentId: string | null;
  pinned: boolean;
  updatedAt: string;
}

export interface SampleEvent {
  id: string;
  sampleId: string;
  kind: EventKind;
  body: string | null;
  assetKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SampleDetail extends SampleSummary {
  description: string | null;
  createdAt: string;
  parent: Pick<SampleSummary, "id" | "code" | "title"> | null;
  children: Array<Pick<SampleSummary, "id" | "code" | "title">>;
  events: SampleEvent[];
}

export interface CreateSampleInput {
  code: string;
  title: string;
  description?: string;
  location?: string;
  parentId?: string;
}

export interface CreateEventInput {
  kind: EventKind;
  body?: string;
  assetKey?: string;
  metadata?: Record<string, unknown>;
}

export interface TemplatePreview {
  name: string;
  sourceFile: string;
  sheets: Array<{
    name: string;
    rows: unknown[][];
  }>;
  images: Array<{
    filename: string;
    mimeType: string;
    data: Uint8Array;
  }>;
}
