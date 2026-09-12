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

/** Refresh card data without replacing geometry owned by an active pointer gesture. */
export function projectMapInteractionProjection<T extends Node<ProjectInteractionProjectionData>>(
  projectedNodes: readonly T[],
  currentNodes: readonly T[],
  dragStarts: ReadonlyMap<string, ProjectMapGeometry>,
  resizeStarts: ReadonlyMap<string, ProjectMapGeometry>,
): T[] {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  return projectedNodes.map((projected) => {
    const placementId = projected.data.descriptor.placementId;
    const dragging = dragStarts.has(placementId);
    const resizing = resizeStarts.has(placementId);
    if ((!dragging && !resizing) || !canKeepInteraction(projected)) return projected;
    const current = currentById.get(projected.id);
    if (!current || current.data.descriptor.placementId !== placementId || !canKeepInteraction(current)) {
      return projected;
    }
    const next = { ...projected, position: current.position };
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
