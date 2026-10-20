import {
  isProjectApiId,
  isProjectAttachmentCaption,
  isProjectAttachmentSourceUrl,
  isProjectExpectedRevision,
  isProjectOperationId,
} from "./project-api";
import type { ProjectMapGeometry } from "./project-types";
import { isProjectMapGeometry } from "./project-types";

export interface CopyAttachmentProjectItemInput {
  sourceContentId: string;
  contentId: string;
  itemId: string;
  placementId: string;
  caption: string | null;
  sourceUrl: string | null;
  geometry: ProjectMapGeometry;
  expectedProjectRevision: number;
  operationId: string;
}

export function isCopyAttachmentProjectItemInput(
  value: unknown,
): value is CopyAttachmentProjectItemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CopyAttachmentProjectItemInput>
    & Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(candidate, "locator")
    || Object.prototype.hasOwnProperty.call(candidate, "assetId")
    || Object.prototype.hasOwnProperty.call(candidate, "storageObjectId")) {
    return false;
  }
  return isProjectApiId(candidate.sourceContentId)
    && isProjectApiId(candidate.contentId)
    && candidate.sourceContentId !== candidate.contentId
    && isProjectApiId(candidate.itemId)
    && isProjectApiId(candidate.placementId)
    && isProjectAttachmentCaption(candidate.caption)
    && isProjectAttachmentSourceUrl(candidate.sourceUrl)
    && isProjectMapGeometry(candidate.geometry)
    && isProjectExpectedRevision(candidate.expectedProjectRevision)
    && isProjectOperationId(candidate.operationId);
}
