import {
  isReferenceTarget,
  type ReferenceResolution,
  type ReferenceTarget,
} from "./reference-types";

export const DEFAULT_REFERENCE_CHILD_LIMIT = 50;
export const MAX_REFERENCE_CHILD_LIMIT = 100;

export interface ListReferenceChildrenInput {
  parent: ReferenceTarget;
  limit?: number;
}

export interface ListReferenceChildrenResponse {
  parent: ReferenceResolution;
  parentEligible: boolean;
  children: ReferenceResolution[];
  truncated: boolean;
}

export function isListReferenceChildrenInput(
  value: unknown,
): value is ListReferenceChildrenInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ListReferenceChildrenInput>;
  if (!isReferenceTarget(candidate.parent)
    || candidate.parent.id.trim() !== candidate.parent.id) return false;
  if (candidate.limit === undefined) return true;
  return Number.isSafeInteger(candidate.limit)
    && candidate.limit >= 1
    && candidate.limit <= MAX_REFERENCE_CHILD_LIMIT;
}
