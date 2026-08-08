export const REFERENCE_REGISTRY_VERSION = 1 as const;

export const REFERENCE_TARGET_TYPES = [
  "sample",
  "run",
  "run_step",
  "comment",
  "comment_occurrence",
  "comment_attachment",
  "execution_image",
  "metrology_reference",
  "recipe_revision",
] as const;

export type ReferenceTargetType = typeof REFERENCE_TARGET_TYPES[number];

export const MAX_REFERENCE_RESOLUTION_TARGETS = 200;
export const MAX_REFERENCE_TARGET_ID_LENGTH = 256;

export interface ReferenceTarget {
  type: ReferenceTargetType;
  id: string;
}

export type ReferenceResolutionStatus =
  | "resolved"
  | "not_found"
  | "inconsistent"
  | "tombstoned";

export type ReferenceContextSegmentType =
  | "sample"
  | "run"
  | "run_step"
  | "recipe_revision";

export interface ReferenceContextSegment {
  type: ReferenceContextSegmentType;
  id: string;
  label: string;
  deletedAt: string | null;
  archivedAt: string | null;
}

export interface ReferenceContext {
  segments: ReferenceContextSegment[];
}

export interface ResolvedReferenceSource {
  title: string;
  subtitle: string | null;
  excerpt: string | null;
  kind: string | null;
  state: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  archivedAt: string | null;
}

export type ReferenceDestinationMode = "source" | "archived";

export interface ReferenceDestination {
  referenceUrl: string;
  mode: ReferenceDestinationMode;
  openSourceUrl: string | null;
  contextOpenSourceUrls: Array<string | null>;
}

export interface ReferenceResolution {
  target: ReferenceTarget;
  resolution: ReferenceResolutionStatus;
  source: ResolvedReferenceSource | null;
  contexts: ReferenceContext[];
  destination: ReferenceDestination;
}

export interface ResolveReferencesInput {
  targets: ReferenceTarget[];
}

export interface ResolveReferencesResponse {
  results: ReferenceResolution[];
}

export interface ReferenceTargetRegistryEntry {
  id: string;
  registryVersion: typeof REFERENCE_REGISTRY_VERSION;
  target: ReferenceTarget;
  firstRegisteredAt: string;
  lastValidatedAt: string;
  tombstonedAt: string | null;
  lastKnownContexts: ReferenceContext[];
}

export const REFERENCE_TARGET_TO_PERMANENT_DELETE_SOURCE = {
  sample: "sample",
  run: "run",
  run_step: "run_step",
  comment: "comment_submission",
  comment_occurrence: "run_step_comment",
  comment_attachment: "comment_submission_item",
  execution_image: "run_step_asset",
  metrology_reference: "metrology_template_reference",
  recipe_revision: "template_version",
} as const satisfies Record<ReferenceTargetType, string>;

export type ReferencePermanentDeleteSourceType =
  typeof REFERENCE_TARGET_TO_PERMANENT_DELETE_SOURCE[ReferenceTargetType];

export function isReferenceTargetType(value: unknown): value is ReferenceTargetType {
  return typeof value === "string"
    && (REFERENCE_TARGET_TYPES as readonly string[]).includes(value);
}

export function isReferenceTarget(value: unknown): value is ReferenceTarget {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReferenceTarget>;
  return isReferenceTargetType(candidate.type)
    && typeof candidate.id === "string"
    && candidate.id.length > 0
    && candidate.id.length <= MAX_REFERENCE_TARGET_ID_LENGTH;
}
