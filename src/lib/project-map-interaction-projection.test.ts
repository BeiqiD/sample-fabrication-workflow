import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { ProjectMapGeometry } from "../../shared/project-types";
import { projectMapInteractionProjection } from "./project-map-interaction-projection";

const geometry: ProjectMapGeometry = { x: 20, y: 40, width: 250, height: 180, zIndex: 0 };
const noInteractions = new Map<string, ProjectMapGeometry>();
function starts(...ids: string[]) { return new Map(ids.map((id) => [`placement-${id}`, geometry])); }
type TestNode = Node<{
  descriptor: { placementId: string; title: string };
  geometryInteractionDisabled: boolean;
  pendingReference: unknown;
  pendingAttachment: unknown;
  markdownEditor: unknown;
  primarySelected: boolean;
}>;
function node(id: string): TestNode {
  return {
    id,
    position: { x: geometry.x, y: geometry.y },
    width: geometry.width,
    height: geometry.height,
    style: { width: geometry.width, height: geometry.height, zIndex: 0 },
    selected: false,
    draggable: true,
    data: {
      descriptor: { placementId: `placement-${id}`, title: "Latest title" },
      geometryInteractionDisabled: false,
      pendingReference: null,
      pendingAttachment: null,
      markdownEditor: null,
      primarySelected: false,
    },
  };
}

describe("Project Map projection during pointer interactions", () => {
  it("keeps every moving card in a multi-drag while accepting new data and controlled selection", () => {
    const projected = [node("a"), node("b"), node("c")];
    const current = projected.map((value, index) => ({
      ...value, position: { x: 100 + index * 20, y: 80 }, selected: true, dragging: true,
      data: { ...value.data, primarySelected: true, descriptor: { ...value.data.descriptor, title: "Old title" } },
    }));
    const result = projectMapInteractionProjection(projected, current, starts("a", "b"), noInteractions);
    for (const index of [0, 1]) {
      expect(result[index].position).toEqual(current[index].position);
      expect(result[index].data).toBe(projected[index].data);
      expect(result[index].selected).toBe(false);
      expect(result[index]).toHaveProperty("dragging", true);
    }
    expect(result[2]).toBe(projected[2]);
    expect(projected[0].position).toEqual({ x: 20, y: 40 });
  });

  it("keeps top-left resize position and dimensions without restoring stale card styling or metadata", () => {
    const projected = { ...node("a"), style: { width: 250, height: 180, zIndex: 7, opacity: 0.8 } };
    const current = { ...node("a"), position: { x: -40, y: -10 }, width: 310, height: 230,
      measured: { width: 310, height: 230 }, resizing: true };
    const [result] = projectMapInteractionProjection([projected], [current], noInteractions, starts("a"));
    expect(result.position).toEqual(current.position);
    expect(result.width).toBe(310);
    expect(result.height).toBe(230);
    expect(result.style).toEqual({ width: 310, height: 230, zIndex: 7, opacity: 0.8 });
    expect(result).toHaveProperty("measured", { width: 310, height: 230 });
    expect(result).toHaveProperty("resizing", true);
    expect(result.data).toBe(projected.data);
  });

  it("accepts authoritative geometry once the pointer interaction has ended", () => {
    const projected = node("a");
    const current = { ...projected, position: { x: 70, y: 70 }, dragging: true };
    expect(projectMapInteractionProjection([projected], [current], noInteractions, noInteractions)[0])
      .toBe(projected);
  });

  it("does not revive deleted nodes or carry a gesture across an item or placement replacement", () => {
    const current = { ...node("a"), position: { x: 70, y: 70 }, dragging: true };
    expect(projectMapInteractionProjection([], [current], starts("a"), noInteractions)).toEqual([]);
    const replacement = { ...node("a"), data: { ...node("a").data,
      descriptor: { placementId: "placement-b", title: "Replacement" } } };
    const replacementItem = { ...node("a"), id: "other-item" };
    expect(projectMapInteractionProjection([replacement], [current], starts("a", "b"), noInteractions)[0])
      .toBe(replacement);
    expect(projectMapInteractionProjection([replacementItem], [current], starts("a"), noInteractions)[0])
      .toBe(replacementItem);
  });

  it.each(["locked", "not-draggable", "editor", "pending-reference", "pending-attachment"])(
    "does not preserve stale geometry when the projected card is %s", (state) => {
      const current = { ...node("a"), position: { x: 70, y: 70 }, dragging: true };
      const projected = node("a");
      if (state === "locked") projected.data.geometryInteractionDisabled = true;
      if (state === "not-draggable") projected.draggable = false;
      if (state === "editor") projected.data.markdownEditor = {};
      if (state === "pending-reference") projected.data.pendingReference = {};
      if (state === "pending-attachment") projected.data.pendingAttachment = {};
      expect(projectMapInteractionProjection([projected], [current], starts("a"), starts("a"))[0])
        .toBe(projected);
    },
  );
});
