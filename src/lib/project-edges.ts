import type { ProjectEdgeRecord, ProjectSnapshot } from "../../shared/project-api";
import type { ProjectEdgeHandle, ProjectEdgeMarker } from "../../shared/project-types";

export type ProjectEdgeDirection = "undirected" | "forward" | "reverse" | "bidirectional";

export interface ProjectEdgeEndpointShape {
  sourceItemId: string;
  targetItemId: string;
  sourceHandle: ProjectEdgeHandle;
  targetHandle: ProjectEdgeHandle;
  markerStart: ProjectEdgeMarker;
  markerEnd: ProjectEdgeMarker;
}

export interface ProjectEdgeMetadataShape {
  markerStart: ProjectEdgeMarker;
  markerEnd: ProjectEdgeMarker;
  label: string | null;
}

export function projectEdgeDirection(
  markerStart: ProjectEdgeMarker,
  markerEnd: ProjectEdgeMarker,
): ProjectEdgeDirection {
  if (markerStart === "arrow" && markerEnd === "arrow") return "bidirectional";
  if (markerStart === "arrow") return "reverse";
  if (markerEnd === "arrow") return "forward";
  return "undirected";
}

export function projectEdgeMarkers(direction: ProjectEdgeDirection): {
  markerStart: ProjectEdgeMarker;
  markerEnd: ProjectEdgeMarker;
} {
  if (direction === "forward") return { markerStart: "none", markerEnd: "arrow" };
  if (direction === "reverse") return { markerStart: "arrow", markerEnd: "none" };
  if (direction === "bidirectional") return { markerStart: "arrow", markerEnd: "arrow" };
  return { markerStart: "none", markerEnd: "none" };
}

export function projectEdgeMetadata(edge: ProjectEdgeRecord): ProjectEdgeMetadataShape {
  return {
    markerStart: edge.markerStart,
    markerEnd: edge.markerEnd,
    label: edge.label,
  };
}

export function projectEdgeMetadataEquals(
  left: ProjectEdgeMetadataShape,
  right: ProjectEdgeMetadataShape,
) {
  return left.markerStart === right.markerStart
    && left.markerEnd === right.markerEnd
    && left.label === right.label;
}

export function projectEdgeEndpointShape(edge: ProjectEdgeRecord): ProjectEdgeEndpointShape {
  return {
    sourceItemId: edge.sourceItemId,
    targetItemId: edge.targetItemId,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    markerStart: edge.markerStart,
    markerEnd: edge.markerEnd,
  };
}

export function projectEdgeWouldDuplicate(
  edges: readonly ProjectEdgeRecord[],
  candidate: ProjectEdgeEndpointShape,
  excludeEdgeId?: string,
) {
  return edges.some((edge) => edge.id !== excludeEdgeId
    && edge.sourceItemId === candidate.sourceItemId
    && edge.targetItemId === candidate.targetItemId
    && edge.sourceHandle === candidate.sourceHandle
    && edge.targetHandle === candidate.targetHandle
    && edge.markerStart === candidate.markerStart
    && edge.markerEnd === candidate.markerEnd);
}

export function projectItemRevisionIndex(snapshot: ProjectSnapshot) {
  return Object.fromEntries(snapshot.items.map((item) => [item.id, item.revision]));
}
