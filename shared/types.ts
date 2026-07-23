export const SAMPLE_STATUSES = ["active", "stored", "consumed", "lost"] as const;
export type SampleStatus = typeof SAMPLE_STATUSES[number];
export const DEFAULT_SAMPLE_STATUS: SampleStatus = "stored";
export const SAMPLE_CREATION_STATUSES: readonly SampleStatus[] = Object.freeze([
  DEFAULT_SAMPLE_STATUS,
  ...SAMPLE_STATUSES.filter((status) => status !== DEFAULT_SAMPLE_STATUS),
]);
export const SAMPLE_STATUS_LABELS: Readonly<Record<SampleStatus, string>> = {
  active: "Active",
  stored: "Stored",
  consumed: "Consumed",
  lost: "Lost",
};
export function isSampleStatus(value: unknown): value is SampleStatus {
  return typeof value === "string" && (SAMPLE_STATUSES as readonly string[]).includes(value);
}
export type StepStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked";
type EventKind = "comment" | "image" | "location" | "status" | "created" | "step" | "run" | "plan" | "verification";
export const MAX_SPLIT_PIECES = 32;

export interface SampleSummary {
  id: string;
  code: string;
  title: string;
  status: SampleStatus;
  location: string | null;
  parentId: string | null;
  pinned: boolean;
  updatedAt: string;
  latestWorkflowName: string | null;
  latestWorkflowVersion: number | null;
  latestRunStatus: SampleRun["status"] | null;
  currentStepTitle: string | null;
  currentStateStepTitle: string | null;
  currentStateThumbnailKey: string | null;
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

export interface ProcessingSampleDetail extends SampleSummary {
  runs: SampleRun[];
  stateVerifications: StateVerification[];
}

export interface SampleDetail extends ProcessingSampleDetail {
  description: string | null;
  createdAt: string;
  parent: Pick<SampleSummary, "id" | "code" | "title"> | null;
  children: Array<Pick<SampleSummary, "id" | "code" | "title">>;
  events: SampleEvent[];
}

export interface RunStep {
  id: string;
  templateStepId: string | null;
  logicalStepKey: string | null;
  definitionHash: string | null;
  expectedStateHash: string | null;
  position: number;
  origin: "template" | "ad_hoc";
  planStatus: "current" | "superseded";
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
  actualizedAt: string | null;
  verificationIds: string[];
  stateVerification: StateVerification | null;
  createdAt: string;
  updatedAt: string;
}

export interface StateVerification {
  id: string;
  sampleId: string;
  afterRunStepId: string;
  previousVerificationId: string | null;
  runPlanRevisionId: string | null;
  expectedStateHash: string | null;
  result: "matched" | "mismatched";
  note: string | null;
  status: "valid" | "stale";
  actorEmail: string | null;
  createdAt: string;
  coveredRunStepIds: string[];
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
  recipeFamilyId: string;
  templateVersionId: string;
  templateName: string;
  templateType: "process" | "module" | "recipe";
  templateVersion: number;
  status: "active" | "complete" | "cancelled" | "superseded";
  currentPlanRevisionId: string;
  planRevisionNumber: number;
  predecessorRunId: string | null;
  anchorStepId: string | null;
  sequenceNo: number;
  runGroupId: string;
  initialStateHash: string | null;
  initialStateImageKeys: string[];
  createdAt: string;
  completedAt: string | null;
  steps: RunStep[];
}

export interface RunStartPreview {
  successor: boolean;
  sampleUpdatedAt: string;
  template: {
    id: string;
    name: string;
    version: number;
    initialStateHash: string | null;
    initialStateImageKeys: string[];
  };
  sampleCurrentState: {
    hash: string | null;
    stepTitle: string | null;
    imageKeys: string[];
  };
}

export interface StartProcessRunInput {
  templateVersionId: string;
  initialStateHash?: string | null;
  expectedSampleUpdatedAt?: string;
}

export interface FinishProcessRunInput {
  expectedSampleUpdatedAt: string;
}

export interface PlanUpdatePreview {
  compatible: boolean;
  currentTemplateVersionId: string;
  nextTemplateVersionId: string;
  preservedCount: number;
  additionCount: number;
  supersededCount: number;
  conflicts: Array<{
    kind: "inserted_before_execution_head";
    existingStepId?: string;
    templateStepId?: string;
  }>;
  historicalDifferences: Array<{
    kind: "modified_executed_step" | "removed_executed_step";
    existingStepId: string;
    templateStepId?: string;
  }>;
}

export interface CreateStateVerificationInput {
  result: "matched" | "mismatched";
  note: string;
  expectedUpdatedAt: string;
  completeStep?: boolean;
  assetKey?: string;
}

export interface CreateSampleInput {
  code: string;
  title: string;
  description?: string;
  location?: string;
  status?: SampleStatus;
}

export interface SplitSamplePieceInput {
  code: string;
  title: string;
  description?: string;
  location: string;
  status: SampleStatus;
}

export interface SplitSampleInput {
  expectedUpdatedAt: string;
  parentStatusAfter: "active" | "consumed";
  pieces: SplitSamplePieceInput[];
}

export interface UpdateSampleInput {
  title?: string;
  status?: SampleStatus;
  location?: string;
  pinned?: boolean;
  expectedUpdatedAt: string;
}

export interface DeleteSampleInput {
  confirmationCode: string;
  expectedUpdatedAt: string;
}

export interface SampleDeletionImpact {
  runs: number;
  steps: number;
  events: number;
  verifications: number;
  childrenDetached: number;
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

interface FabubloxImage {
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
  initialStateImageIds: string[];
  unassignedImageIds: string[];
  warnings: ImportWarning[];
}
