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
  actorEmail: string | null;
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
  templateStepId: string | null;
  position: number;
  origin: "template" | "ad_hoc";
  title: string;
  status: StepStatus;
  notes: string | null;
  toolName: string | null;
  parametersText: string | null;
  commentsText: string | null;
  deviationNote: string | null;
  plannedTitle: string | null;
  plannedToolName: string | null;
  plannedParametersText: string | null;
  plannedCommentsText: string | null;
  plannedImageKeys: string[];
  executionImageKeys: string[];
  comments: RunStepComment[];
  createdAt: string;
  updatedAt: string;
}

export interface RunStepComment {
  id: string;
  scope: "common" | "individual";
  operationGroupId: string | null;
  body: string;
  assetKey: string | null;
  actorEmail: string | null;
  createdAt: string;
}

export interface RunStepTarget {
  sampleId: string;
  runId: string;
  stepId: string;
  expectedUpdatedAt: string;
}

export interface CreateRunStepCommentsInput {
  scope: RunStepComment["scope"];
  body: string;
  targets: RunStepTarget[];
  assetKey?: string;
}

export interface ConfirmRunStepsInput {
  targets: RunStepTarget[];
}

export interface UpdateRunStepInput {
  status: StepStatus;
  title: string;
  toolName: string;
  parametersText: string;
  commentsText: string;
  deviationNote: string;
  notes: string;
  expectedUpdatedAt: string;
  assetKey?: string;
}

export interface CreateRunStepInput {
  afterStepId?: string;
  title: string;
  toolName: string;
  parametersText: string;
  commentsText: string;
  deviationNote: string;
  assetKey?: string;
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

export interface CreateRecordInput {
  status: SampleStatus;
  location: string;
  pinned: boolean;
  expectedUpdatedAt: string;
  body?: string;
  assetKey?: string;
  thumbnailKey?: string;
}

export interface FullExportManifest {
  schemaVersion: 1;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
  assetKeys: string[];
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
