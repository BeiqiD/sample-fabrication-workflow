import type {
  ReferenceResolution,
  ReferenceTarget,
} from "./reference-types";
import {
  isReferenceTarget,
} from "./reference-types";
import type {
  ProjectContentType,
  ProjectEdgeHandle,
  ProjectEdgeMarker,
  ProjectMapGeometry,
} from "./project-types";
import {
  isProjectEdgeHandle,
  isProjectEdgeMarker,
  isProjectMapGeometry,
  isProjectPositiveSafeInteger,
  MAX_PROJECT_ATTACHMENT_CAPTION_LENGTH,
  MAX_PROJECT_ATTACHMENT_SOURCE_URL_LENGTH,
  MAX_PROJECT_EDGE_LABEL_LENGTH,
  MAX_PROJECT_TITLE_LENGTH,
  PROJECT_SCHEMA_VERSION,
} from "./project-types";

export const MAX_PROJECT_MARKDOWN_LENGTH = 200_000;
export const PROJECT_API_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/;

export interface ProjectRecord {
  id: string;
  title: string;
  revision: number;
  nextCreatedSequence: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface ProjectContentRecord {
  id: string;
  projectId: string;
  contentType: ProjectContentType;
  markdownSource: string | null;
  attachmentCaption: string | null;
  attachmentSourceUrl: string | null;
  formatVersion: number;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface ProjectAttachmentRecord {
  projectContentId: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  createdBy: string;
  createdAt: string;
  fileUrl: string;
}

export interface ProjectItemRecord {
  id: string;
  projectId: string;
  itemType: "content" | "reference";
  projectContentId: string | null;
  referenceTargetId: string | null;
  createdSequence: number;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface ProjectPlacementRecord extends ProjectMapGeometry {
  id: string;
  projectItemId: string;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEdgeRecord {
  id: string;
  projectId: string;
  sourceItemId: string;
  targetItemId: string;
  sourceHandle: ProjectEdgeHandle;
  targetHandle: ProjectEdgeHandle;
  markerStart: ProjectEdgeMarker;
  markerEnd: ProjectEdgeMarker;
  label: string | null;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface ProjectReferenceRecord {
  registryId: string;
  resolution: ReferenceResolution;
}

export interface ProjectSnapshot {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  project: ProjectRecord;
  contents: ProjectContentRecord[];
  attachments: ProjectAttachmentRecord[];
  items: ProjectItemRecord[];
  placements: ProjectPlacementRecord[];
  edges: ProjectEdgeRecord[];
  references: ProjectReferenceRecord[];
}

export interface ProjectListResponse {
  projects: ProjectRecord[];
}

export interface ProjectMutationResponse {
  project: ProjectRecord;
  replayed: boolean;
}

export interface ProjectItemMutationResponse {
  item: ProjectItemRecord;
  content: ProjectContentRecord | null;
  attachment: ProjectAttachmentRecord | null;
  placement: ProjectPlacementRecord;
  project: ProjectRecord;
  replayed: boolean;
}

export interface ProjectRowMutationResponse<Row> {
  value: Row;
  replayed: boolean;
}

export interface CreateProjectInput {
  id: string;
  title: string;
  operationId: string;
}

export interface RenameProjectInput {
  title: string;
  expectedRevision: number;
  operationId: string;
}

export interface ProjectLifecycleInput {
  expectedRevision: number;
  operationId: string;
}

export interface CreateMarkdownProjectItemInput {
  contentId: string;
  itemId: string;
  placementId: string;
  markdownSource: string;
  geometry: ProjectMapGeometry;
  expectedProjectRevision: number;
  operationId: string;
}

export interface CreateReferenceProjectItemInput {
  itemId: string;
  placementId: string;
  target: ReferenceTarget;
  geometry: ProjectMapGeometry;
  expectedProjectRevision: number;
  operationId: string;
}

export type ProjectAttachmentLocatorInput =
  | { assetId: string; storageObjectId?: never }
  | { assetId?: never; storageObjectId: string };

export interface CreateAttachmentProjectItemInput {
  contentId: string;
  itemId: string;
  placementId: string;
  locator: ProjectAttachmentLocatorInput;
  caption: string | null;
  sourceUrl: string | null;
  geometry: ProjectMapGeometry;
  expectedProjectRevision: number;
  operationId: string;
}

export interface UpdateProjectMarkdownInput {
  markdownSource: string;
  expectedRevision: number;
  operationId: string;
}

export interface UpdateProjectAttachmentInput {
  caption: string | null;
  sourceUrl: string | null;
  expectedRevision: number;
  operationId: string;
}

export interface UpdateProjectPlacementInput {
  geometry: ProjectMapGeometry;
  expectedRevision: number;
  operationId: string;
}

export interface ProjectItemLifecycleInput {
  expectedItemRevision: number;
  expectedContentRevision?: number;
  operationId: string;
}

export interface CreateProjectEdgeInput {
  edgeId: string;
  sourceItemId: string;
  targetItemId: string;
  sourceHandle: ProjectEdgeHandle;
  targetHandle: ProjectEdgeHandle;
  markerStart: ProjectEdgeMarker;
  markerEnd: ProjectEdgeMarker;
  label: string | null;
  expectedSourceItemRevision: number;
  expectedTargetItemRevision: number;
  operationId: string;
}

export interface UpdateProjectEdgeInput {
  markerStart: ProjectEdgeMarker;
  markerEnd: ProjectEdgeMarker;
  label: string | null;
  expectedRevision: number;
  operationId: string;
}

export interface ProjectEdgeLifecycleInput {
  expectedRevision: number;
  operationId: string;
}

function isProjectPayloadText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\u0000");
}

export function projectCodePointLength(value: string) {
  let length = 0;
  for (const _character of value) {
    length += 1;
  }
  return length;
}

function hasProjectCodePointLengthAtMost(value: string, maximum: number) {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) return false;
  }
  return true;
}

export function isProjectApiId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_API_ID_PATTERN.test(value);
}

export function isProjectOperationId(value: unknown): value is string {
  return isProjectApiId(value);
}

export function isProjectTitle(value: unknown): value is string {
  return isProjectPayloadText(value)
    && value.trim() === value
    && value.length >= 1
    && hasProjectCodePointLengthAtMost(value, MAX_PROJECT_TITLE_LENGTH);
}

export function isProjectMarkdownSource(value: unknown): value is string {
  return isProjectPayloadText(value)
    && hasProjectCodePointLengthAtMost(value, MAX_PROJECT_MARKDOWN_LENGTH);
}

export function isProjectAttachmentCaption(value: unknown): value is string | null {
  return value === null
    || (isProjectPayloadText(value)
      && hasProjectCodePointLengthAtMost(
        value,
        MAX_PROJECT_ATTACHMENT_CAPTION_LENGTH,
      ));
}

export function isProjectAttachmentSourceUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (!isProjectPayloadText(value) || value.length < 1
    || !hasProjectCodePointLengthAtMost(
      value,
      MAX_PROJECT_ATTACHMENT_SOURCE_URL_LENGTH,
    )
    || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isProjectExpectedRevision(value: unknown): value is number {
  return isProjectPositiveSafeInteger(value);
}

export function isProjectAttachmentLocator(
  value: unknown,
): value is ProjectAttachmentLocatorInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const hasAssetKey = Object.prototype.hasOwnProperty.call(candidate, "assetId");
  const hasStorageKey = Object.prototype.hasOwnProperty.call(
    candidate,
    "storageObjectId",
  );
  if (hasAssetKey === hasStorageKey) return false;
  return hasAssetKey
    ? isProjectApiId(candidate.assetId)
    : isProjectApiId(candidate.storageObjectId);
}

export function isProjectEdgeLabel(value: unknown): value is string | null {
  return value === null
    || (isProjectPayloadText(value)
      && hasProjectCodePointLengthAtMost(value, MAX_PROJECT_EDGE_LABEL_LENGTH));
}

export function isCreateProjectInput(value: unknown): value is CreateProjectInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CreateProjectInput>;
  return isProjectApiId(candidate.id)
    && isProjectTitle(candidate.title)
    && isProjectOperationId(candidate.operationId);
}

export function isRenameProjectInput(value: unknown): value is RenameProjectInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RenameProjectInput>;
  return isProjectTitle(candidate.title)
    && isProjectExpectedRevision(candidate.expectedRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isProjectLifecycleInput(value: unknown): value is ProjectLifecycleInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectLifecycleInput>;
  return isProjectExpectedRevision(candidate.expectedRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isCreateMarkdownProjectItemInput(
  value: unknown,
): value is CreateMarkdownProjectItemInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CreateMarkdownProjectItemInput>;
  return isProjectApiId(candidate.contentId)
    && isProjectApiId(candidate.itemId)
    && isProjectApiId(candidate.placementId)
    && isProjectMarkdownSource(candidate.markdownSource)
    && isProjectMapGeometry(candidate.geometry)
    && isProjectExpectedRevision(candidate.expectedProjectRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isCreateReferenceProjectItemInput(
  value: unknown,
): value is CreateReferenceProjectItemInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CreateReferenceProjectItemInput>;
  return isProjectApiId(candidate.itemId)
    && isProjectApiId(candidate.placementId)
    && isReferenceTarget(candidate.target)
    && candidate.target!.id.trim() === candidate.target!.id
    && isProjectMapGeometry(candidate.geometry)
    && isProjectExpectedRevision(candidate.expectedProjectRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isCreateAttachmentProjectItemInput(
  value: unknown,
): value is CreateAttachmentProjectItemInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CreateAttachmentProjectItemInput>;
  return isProjectApiId(candidate.contentId)
    && isProjectApiId(candidate.itemId)
    && isProjectApiId(candidate.placementId)
    && isProjectAttachmentLocator(candidate.locator)
    && isProjectAttachmentCaption(candidate.caption)
    && isProjectAttachmentSourceUrl(candidate.sourceUrl)
    && isProjectMapGeometry(candidate.geometry)
    && isProjectExpectedRevision(candidate.expectedProjectRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isUpdateProjectMarkdownInput(
  value: unknown,
): value is UpdateProjectMarkdownInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UpdateProjectMarkdownInput>;
  return isProjectMarkdownSource(candidate.markdownSource)
    && isProjectExpectedRevision(candidate.expectedRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isUpdateProjectAttachmentInput(
  value: unknown,
): value is UpdateProjectAttachmentInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UpdateProjectAttachmentInput>;
  return isProjectAttachmentCaption(candidate.caption)
    && isProjectAttachmentSourceUrl(candidate.sourceUrl)
    && isProjectExpectedRevision(candidate.expectedRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isUpdateProjectPlacementInput(
  value: unknown,
): value is UpdateProjectPlacementInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UpdateProjectPlacementInput>;
  return isProjectMapGeometry(candidate.geometry)
    && isProjectExpectedRevision(candidate.expectedRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isProjectItemLifecycleInput(
  value: unknown,
): value is ProjectItemLifecycleInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectItemLifecycleInput>;
  return isProjectExpectedRevision(candidate.expectedItemRevision)
    && (candidate.expectedContentRevision === undefined
      || isProjectExpectedRevision(candidate.expectedContentRevision))
    && isProjectOperationId(candidate.operationId);
}

export function isCreateProjectEdgeInput(
  value: unknown,
): value is CreateProjectEdgeInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CreateProjectEdgeInput>;
  return isProjectApiId(candidate.edgeId)
    && isProjectApiId(candidate.sourceItemId)
    && isProjectApiId(candidate.targetItemId)
    && candidate.sourceItemId !== candidate.targetItemId
    && isProjectEdgeHandle(candidate.sourceHandle)
    && isProjectEdgeHandle(candidate.targetHandle)
    && isProjectEdgeMarker(candidate.markerStart)
    && isProjectEdgeMarker(candidate.markerEnd)
    && isProjectEdgeLabel(candidate.label)
    && isProjectExpectedRevision(candidate.expectedSourceItemRevision)
    && isProjectExpectedRevision(candidate.expectedTargetItemRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isUpdateProjectEdgeInput(
  value: unknown,
): value is UpdateProjectEdgeInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UpdateProjectEdgeInput>;
  return isProjectEdgeMarker(candidate.markerStart)
    && isProjectEdgeMarker(candidate.markerEnd)
    && isProjectEdgeLabel(candidate.label)
    && isProjectExpectedRevision(candidate.expectedRevision)
    && isProjectOperationId(candidate.operationId);
}

export function isProjectEdgeLifecycleInput(
  value: unknown,
): value is ProjectEdgeLifecycleInput {
  return isProjectLifecycleInput(value);
}
