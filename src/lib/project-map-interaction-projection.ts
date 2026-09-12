import type { Node } from "@xyflow/react";
import type { ProjectMapGeometry } from "../../shared/project-types";

type ProjectInteractionProjectionData = {
  descriptor: { placementId: string };
  geometryInteractionDisabled: boolean;
  pendingReference: unknown;
  pendingAttachment: unknown;
  markdownEditor: unknown;
};

function canKeepInteraction(node: Node<ProjectInteractionProjectionData>) {
  return node.draggable !== false
    && !node.data.geometryInteractionDisabled
    && !node.data.pendingReference
    && !node.data.pendingAttachment
    && !node.data.markdownEditor;
}

/** Refresh card data without invalidating stable handles or an active pointer gesture. */
export function projectMapInteractionProjection<T extends Node<ProjectInteractionProjectionData>>(
  projectedNodes: readonly T[],
  currentNodes: readonly T[],
  dragStarts: ReadonlyMap<string, ProjectMapGeometry>,
  resizeStarts: ReadonlyMap<string, ProjectMapGeometry>,
): T[] {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  return projectedNodes.map((projected) => {
    const placementId = projected.data.descriptor.placementId;
    const current = currentById.get(projected.id);
    const samePlacement = current?.data.descriptor.placementId === placementId;
    // XYFlow clears handle bounds when a refreshed node loses its measurements.
    // Keep valid measurements across data/lock changes so an edge being clicked
    // is not removed between pointer-down and click. New sizes still remeasure.
    const refreshed = current && samePlacement && current.type === projected.type
      && current.width === projected.width && current.height === projected.height
      && current.style?.width === projected.style?.width && current.style?.height === projected.style?.height
      && Boolean(current.data.pendingReference) === Boolean(projected.data.pendingReference)
      && Boolean(current.data.pendingAttachment) === Boolean(projected.data.pendingAttachment)
      && current.measured?.width && current.measured?.height
      ? { ...projected, measured: { ...current.measured, ...projected.measured } }
      : projected;
    const dragging = dragStarts.has(placementId);
    const resizing = resizeStarts.has(placementId);
    if ((!dragging && !resizing) || !canKeepInteraction(projected)) return refreshed;
    if (!current || !samePlacement || !canKeepInteraction(current)) {
      return refreshed;
    }
    const next = { ...refreshed, position: current.position };
    if (dragging) next.dragging = current.dragging;
    if (resizing) {
      const width = current.width ?? current.measured?.width ?? projected.width;
      const height = current.height ?? current.measured?.height ?? projected.height;
      next.width = width;
      next.height = height;
      next.measured = { ...projected.measured, ...current.measured };
      next.style = {
        ...projected.style,
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      };
      next.resizing = current.resizing;
    }
    return next;
  });
}
