// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord, ProjectSnapshot } from "../shared/project-api";
import { projectApi } from "./lib/project-client";
import { projectEdgeHistoryTouchesItem, type ProjectEdgeHistoryCommand } from "./lib/project-edge-history";
import { useProjectEdgeController } from "./lib/use-project-edge-controller";
import { projectTestSnapshot } from "./project-test-fixture";

function fixture() {
  const snapshot = projectTestSnapshot();
  const edge: ProjectEdgeRecord = {
    id: "edge-a", projectId: snapshot.project.id,
    sourceItemId: "item-note", targetItemId: "item-reference", sourceHandle: "right", targetHandle: "left",
    markerStart: "none", markerEnd: "arrow", label: "Feeds", revision: 4,
    createdBy: "user@example.com", updatedBy: "user@example.com",
    createdAt: "2026-09-11T10:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z",
    deletedAt: null, deletedBy: null,
  };
  snapshot.edges = [edge];
  return snapshot;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Project edge reconnect controller", () => {
  it("replays an uncertain reconnect exactly and restores endpoints through Undo/Redo", async () => {
    const initial = fixture();
    const sourceEdge = initial.edges[0];
    const history: ProjectEdgeHistoryCommand[] = [];
    const onHistory = (command: ProjectEdgeHistoryCommand) => history.push(command);
    let acknowledged = sourceEdge;
    const update = vi.spyOn(projectApi, "updateEdge")
      .mockRejectedValueOnce(new TypeError("Network interrupted"))
      .mockImplementation(async (_projectId, _edgeId, input) => {
        acknowledged = {
          ...acknowledged, sourceItemId: input.sourceItemId ?? acknowledged.sourceItemId,
          targetItemId: input.targetItemId ?? acknowledged.targetItemId,
          sourceHandle: input.sourceHandle ?? acknowledged.sourceHandle,
          targetHandle: input.targetHandle ?? acknowledged.targetHandle,
          markerStart: input.markerStart, markerEnd: input.markerEnd,
          label: input.label, revision: acknowledged.revision + 1,
        };
        return { value: acknowledged, replayed: false };
      });
    const { result } = renderHook(() => {
      const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(initial);
      return useProjectEdgeController({ projectId: initial.project.id, snapshot, setSnapshot, externalBusy: false, onHistory });
    });
    const connection = {
      sourceItemId: "item-reference", targetItemId: "item-note",
      sourceHandle: "bottom" as const, targetHandle: "top" as const,
    };
    act(() => { expect(result.current.reconnect(sourceEdge.id, connection)).toBe(true); });
    await waitFor(() => expect(result.current.pending?.status).toBe("uncertain"));
    const originalInput = update.mock.calls[0][2];
    expect(originalInput).toMatchObject({ ...connection, expectedRevision: 4, label: "Feeds", markerEnd: "arrow" });
    expect(originalInput.expectedSourceItemRevision).toBe(initial.items.find((item) => item.id === "item-reference")!.revision);
    expect(result.current.unsafe).toBe(true);
    act(() => result.current.retryExact());
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(update.mock.calls[1][2]).toEqual(originalInput);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: "edge-reconnect", before: {
      sourceItemId: "item-note", targetItemId: "item-reference", sourceHandle: "right", targetHandle: "left",
    }, after: connection });
    const afterUndo = vi.fn();
    act(() => { expect(result.current.applyHistory(history[0], "undo", afterUndo)).toBe(true); });
    await waitFor(() => expect(afterUndo).toHaveBeenCalledOnce());
    expect(update.mock.calls[2][2]).toMatchObject({
      sourceItemId: "item-note", targetItemId: "item-reference", sourceHandle: "right", targetHandle: "left", expectedRevision: 5,
    });
    expect(update.mock.calls[2][2].operationId).not.toBe(originalInput.operationId);
    const afterRedo = vi.fn();
    act(() => { expect(result.current.applyHistory(history[0], "redo", afterRedo)).toBe(true); });
    await waitFor(() => expect(afterRedo).toHaveBeenCalledOnce());
    expect(update.mock.calls[3][2]).toMatchObject({ ...connection, expectedRevision: 6 });
    expect(history).toHaveLength(1);
  });

  it("rejects self links, missing endpoints and unchanged gestures before sending writes", () => {
    const initial = fixture();
    const edge = initial.edges[0];
    const update = vi.spyOn(projectApi, "updateEdge");
    const { result } = renderHook(() => {
      const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(initial);
      return useProjectEdgeController({ projectId: initial.project.id, snapshot, setSnapshot, externalBusy: false, onHistory: () => undefined });
    });
    act(() => {
      expect(result.current.reconnect(edge.id, { ...edge })).toBe(false);
      expect(result.current.reconnect(edge.id, { ...edge, targetItemId: edge.sourceItemId })).toBe(false);
      expect(result.current.reconnect(edge.id, { ...edge, targetItemId: "missing" })).toBe(false);
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("invalidates reconnect history when either the old or new endpoint is removed", () => {
    const command: ProjectEdgeHistoryCommand = {
      kind: "edge-reconnect", edgeId: "edge-a", sourceItemId: "item-new", targetItemId: "item-target",
      before: { sourceItemId: "item-old", targetItemId: "item-target", sourceHandle: "right", targetHandle: "left" },
      after: { sourceItemId: "item-new", targetItemId: "item-target", sourceHandle: "bottom", targetHandle: "top" },
    };
    expect(projectEdgeHistoryTouchesItem(command, "item-old")).toBe(true);
    expect(projectEdgeHistoryTouchesItem(command, "item-new")).toBe(true);
    expect(projectEdgeHistoryTouchesItem(command, "unrelated")).toBe(false);
  });
});
