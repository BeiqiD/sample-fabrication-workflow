export const PROJECT_SCHEMA_VERSION = 1 as const;
export const PROJECT_EXPORT_SCHEMA_VERSION = 4 as const;

export const PROJECT_CONTENT_TYPES = ["markdown", "attachment"] as const;
export type ProjectContentType = typeof PROJECT_CONTENT_TYPES[number];

export const PROJECT_ITEM_TYPES = ["content", "reference"] as const;
export type ProjectItemType = typeof PROJECT_ITEM_TYPES[number];

export const PROJECT_EDGE_HANDLES = ["top", "right", "bottom", "left"] as const;
export type ProjectEdgeHandle = typeof PROJECT_EDGE_HANDLES[number];

export const PROJECT_EDGE_MARKERS = ["none", "arrow"] as const;
export type ProjectEdgeMarker = typeof PROJECT_EDGE_MARKERS[number];

export const MAX_PROJECT_ID_LENGTH = 256;
export const MAX_PROJECT_TITLE_LENGTH = 200;
export const MAX_PROJECT_EDGE_LABEL_LENGTH = 200;

export interface ProjectMapGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

export interface ProjectEdgeShape {
  sourceHandle: ProjectEdgeHandle;
  targetHandle: ProjectEdgeHandle;
  markerStart: ProjectEdgeMarker;
  markerEnd: ProjectEdgeMarker;
  label: string | null;
}

function oneOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isProjectContentType(value: unknown): value is ProjectContentType {
  return oneOf(PROJECT_CONTENT_TYPES, value);
}

export function isProjectItemType(value: unknown): value is ProjectItemType {
  return oneOf(PROJECT_ITEM_TYPES, value);
}

export function isProjectEdgeHandle(value: unknown): value is ProjectEdgeHandle {
  return oneOf(PROJECT_EDGE_HANDLES, value);
}

export function isProjectEdgeMarker(value: unknown): value is ProjectEdgeMarker {
  return oneOf(PROJECT_EDGE_MARKERS, value);
}

export function isProjectMapGeometry(value: unknown): value is ProjectMapGeometry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectMapGeometry>;
  return Number.isFinite(candidate.x)
    && Number.isFinite(candidate.y)
    && Number.isFinite(candidate.width)
    && Number.isFinite(candidate.height)
    && Number.isInteger(candidate.zIndex)
    && candidate.width! > 0
    && candidate.height! > 0;
}

export function isProjectEdgeShape(value: unknown): value is ProjectEdgeShape {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectEdgeShape>;
  return isProjectEdgeHandle(candidate.sourceHandle)
    && isProjectEdgeHandle(candidate.targetHandle)
    && isProjectEdgeMarker(candidate.markerStart)
    && isProjectEdgeMarker(candidate.markerEnd)
    && (candidate.label === null
      || (typeof candidate.label === "string" && candidate.label.length <= MAX_PROJECT_EDGE_LABEL_LENGTH));
}
