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
  runs: SampleRun[];
}

export interface RunStep {
  id: string;
  position: number;
  title: string;
  status: StepStatus;
  notes: string | null;
  toolName: string | null;
  parametersText: string | null;
  templateCommentsText: string | null;
  templateImageKey: string | null;
  updatedAt: string;
}

export interface SampleRun {
  id: string;
  templateVersionId: string;
  templateName: string;
  templateType: "process" | "module" | "recipe";
  templateVersion: number;
  status: "active" | "complete" | "cancelled";
  createdAt: string;
  completedAt: string | null;
  steps: RunStep[];
}

export interface CreateSampleInput {
  code: string;
  title: string;
  description?: string;
  location?: string;
  parentId?: string;
}

export interface UpdateSampleInput {
  status?: SampleStatus;
  location?: string;
  pinned?: boolean;
  expectedUpdatedAt: string;
}

export interface FullExportManifest {
  schemaVersion: 1;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
  assetKeys: string[];
}

export interface CreateEventInput {
  kind: EventKind;
  body?: string;
  assetKey?: string;
  metadata?: Record<string, unknown>;
}

export interface FabubloxSection {
  localId: string;
  sourceRow: number;
  name: string;
}

export interface FabubloxStep {
  localId: string;
  sourceRow: number;
  position: number;
  stepNumber: string | null;
  sectionName: string | null;
  name: string;
  toolName: string | null;
  parametersText: string | null;
  commentsText: string | null;
  imageIds: string[];
  rawCells: Record<string, unknown>;
}

export interface FabubloxImage {
  localId: string;
  sourcePart: string;
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  anchor: {
    row: number;
    col: number;
    rowOffsetEmu?: number;
    colOffsetEmu?: number;
  };
  assignedStepLocalId: string | null;
}

export interface ParsedFabubloxImage extends FabubloxImage {
  data: Uint8Array;
}

export interface ImportWarning {
  code: string;
  message: string;
  sourceRow?: number;
}

export interface FabubloxImportPreview {
  schemaVersion: 1;
  title: string;
  source: {
    fileName: string;
    fileSha256: string;
    sheetName: string;
  };
  detected: {
    headerRow: number;
    layerStackColumn: number | null;
  };
  sections: FabubloxSection[];
  steps: FabubloxStep[];
  images: ParsedFabubloxImage[];
  unassignedImageIds: string[];
  warnings: ImportWarning[];
}
