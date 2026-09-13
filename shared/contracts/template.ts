import type { InitialSubstrateStep } from "./types";

export interface TemplateRecord {
  id: string;
  recipeFamilyId: string;
  name: string;
  templateType: "process" | "module" | "recipe";
  templateKind: "process" | "metrology";
  version: number;
  manifestHash: string;
  sourceFilename: string | null;
  stepCount: number;
  toolName: string | null;
  parametersText: string | null;
  commentsText: string | null;
  initialStateHash: string | null;
  initialStateImageKeys: string[];
  initialSubstrateStep: InitialSubstrateStep | null;
  locked: boolean;
  lockedAt: string | null;
  createdAt: string;
}

export interface ProcessTemplateVersionSummary {
  id: string;
  recipeFamilyId: string;
  name: string;
  templateType: "process" | "module" | "recipe";
  version: number;
  sourceFilename: string | null;
  stepCount: number;
  initialStateHash: string | null;
  hasInitialSubstrateStep: boolean;
  initialStateImageCount: number;
  locked: boolean;
  createdAt: string;
}

export interface ProcessTemplateFamilySummary {
  recipeFamilyId: string;
  name: string;
  templateType: ProcessTemplateVersionSummary["templateType"];
  latestVersion: number;
  versionCount: number;
  latest: ProcessTemplateVersionSummary;
}

export interface ProcessTemplateFamilyOption {
  recipeFamilyId: string;
  name: string;
  latestVersion: number;
}

export interface MetrologyTemplateSummary {
  id: string;
  name: string;
  toolName: string | null;
  hasDefaultContent: boolean;
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

// Detail responses carry tool and default text on steps, while list records
// include those fields as a first-step summary.
export interface TemplateDetail extends Omit<TemplateRecord, "stepCount" | "toolName" | "parametersText" | "commentsText"> {
  archived: boolean;
  metrologyNotes: string | null;
  referenceAttachments: MetrologyTemplateReference[];
  steps: TemplateStepRecord[];
}

export interface MetrologyTemplateReference {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  assetKey: string;
  createdAt: string;
}

export interface TemplateStepInput {
  name: string;
  toolName: string;
  parametersText: string;
  commentsText: string;
  assetKey?: string;
}

export interface MetrologyTemplateInput {
  name: string;
  toolName: string;
  parametersText: string;
  commentsText: string;
}
