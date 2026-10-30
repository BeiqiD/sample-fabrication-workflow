// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord, ProjectSnapshot } from "../shared/project-api";
import { ProjectApiError, projectApi } from "./lib/project-client";
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

  it.each(["edge", "source", "target"])("settles an uncertain reconnect only after its %s revision has advanced", async (changed) => {
    const initial = fixture();
    const fresh = structuredClone(initial);
    const edge = initial.edges[0];
    const connection = {
      sourceItemId: edge.targetItemId, targetItemId: edge.sourceItemId,
      sourceHandle: "bottom" as const, targetHandle: "top" as const,
    };
    if (changed === "edge") {
      fresh.edges[0].revision += 1;
      fresh.edges[0].deletedAt = "2026-09-12T10:00:00.000Z";
    } else {
      const itemId = changed === "source" ? connection.sourceItemId : connection.targetItemId;
      fresh.items.find((item) => item.id === itemId)!.revision += 1;
    }
    const update = vi.spyOn(projectApi, "updateEdge")
      .mockRejectedValueOnce(new TypeError("Original response lost"))
      .mockRejectedValueOnce(new ProjectApiError("Revision conflict", 409));
    const read = vi.spyOn(projectApi, "readTrash").mockResolvedValue(fresh);
    const history = vi.fn();
    const { result } = renderHook(() => {
      const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(initial);
      return useProjectEdgeController({ projectId: initial.project.id, snapshot, setSnapshot, externalBusy: false, onHistory: history });
    });
    act(() => { result.current.reconnect(edge.id, connection); });
    await waitFor(() => expect(result.current.pending?.status).toBe("uncertain"));
    act(() => result.current.retryExact());
    await waitFor(() => expect(result.current.pending?.status).toBe("conflict"));
    expect(read).toHaveBeenCalledWith(initial.project.id);
    expect(update.mock.calls[1][2]).toEqual(update.mock.calls[0][2]);
    expect(history).not.toHaveBeenCalled();
    expect(result.current.unsafe).toBe(true);
    act(() => result.current.resetForAuthoritativeReload());
    expect(result.current.unsafe).toBe(false);
  });

  it.each(["unchanged", "missing edge", "older edge", "unavailable read"])("keeps reconnect frozen when the conflict proof is %s", async (proof) => {
    const initial = fixture();
    const edge = initial.edges[0];
    const connection = {
      sourceItemId: edge.targetItemId, targetItemId: edge.sourceItemId,
      sourceHandle: "bottom" as const, targetHandle: "top" as const,
    };
    const fresh = structuredClone(initial);
    if (proof === "missing edge") fresh.edges = [];
    if (proof === "older edge") fresh.edges[0].revision -= 1;
    const read = vi.spyOn(projectApi, "readTrash");
    if (proof === "unavailable read") read.mockRejectedValue(new TypeError("Offline"));
    else read.mockResolvedValue(fresh);
    const update = vi.spyOn(projectApi, "updateEdge")
      .mockRejectedValueOnce(new TypeError("Original response lost"))
      .mockRejectedValueOnce(new ProjectApiError("Temporary relationship conflict", 409))
      .mockResolvedValue({ value: { ...edge, ...connection, revision: edge.revision + 1 }, replayed: true });
    const history = vi.fn();
    const { result } = renderHook(() => {
      const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(initial);
      return useProjectEdgeController({ projectId: initial.project.id, snapshot, setSnapshot, externalBusy: false, onHistory: history });
    });
    act(() => { result.current.reconnect(edge.id, connection); });
    await waitFor(() => expect(result.current.pending?.status).toBe("uncertain"));
    act(() => result.current.retryExact());
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.pending?.status).toBe("uncertain"));
    expect(result.current.unsafe).toBe(true);
    expect(history).not.toHaveBeenCalled();
    act(() => result.current.retryExact());
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(update.mock.calls[1][2]).toEqual(update.mock.calls[0][2]);
    expect(update.mock.calls[2][2]).toEqual(update.mock.calls[0][2]);
    expect(history).toHaveBeenCalledOnce();
  });

  it("does not use unrelated endpoint revisions to settle a metadata update", async () => {
    const initial = fixture();
    const fresh = structuredClone(initial);
    for (const item of fresh.items) item.revision += 1;
    vi.spyOn(projectApi, "readTrash").mockResolvedValue(fresh);
    const update = vi.spyOn(projectApi, "updateEdge")
      .mockRejectedValueOnce(new TypeError("Original response lost"))
      .mockRejectedValueOnce(new ProjectApiError("Temporary relationship conflict", 409));
    const { result } = renderHook(() => {
      const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(initial);
      return useProjectEdgeController({ projectId: initial.project.id, snapshot, setSnapshot, externalBusy: false, onHistory: vi.fn() });
    });
    act(() => { result.current.selectEdge(initial.edges[0].id); });
    act(() => { result.current.startEdit(); });
    act(() => { result.current.changeEdit("label", "Changed label"); });
    act(() => { result.current.saveEdit(); });
    await waitFor(() => expect(result.current.pending?.status).toBe("uncertain"));
    act(() => result.current.retryExact());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.pending?.status).toBe("uncertain"));
    expect(update.mock.calls[0][2].expectedSourceItemRevision).toBeUndefined();
    expect(result.current.editor?.status).toBe("uncertain");
  });

  it("accepts the server's durable rejection proof without trusting a plain conflict", async () => {
    const initial = fixture();
    const create = vi.spyOn(projectApi, "createEdge")
      .mockRejectedValueOnce(new TypeError("Original response lost"))
      .mockRejectedValueOnce(new ProjectApiError("The stable edge ID is already occupied", 409, "authoritative-rejection"));
    const read = vi.spyOn(projectApi, "readTrash");
    const { result } = renderHook(() => {
      const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(initial);
      return useProjectEdgeController({ projectId: initial.project.id, snapshot, setSnapshot, externalBusy: false, onHistory: vi.fn() });
    });
    act(() => { result.current.connect({
      sourceItemId: "item-note", targetItemId: "item-reference", sourceHandle: "bottom", targetHandle: "top",
    }); });
    await waitFor(() => expect(result.current.pending?.status).toBe("uncertain"));
    act(() => result.current.retryExact());
    await waitFor(() => expect(result.current.pending?.status).toBe("conflict"));
    expect(create.mock.calls[1][1]).toEqual(create.mock.calls[0][1]);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["resolves", "rejects"])("ignores a deferred settlement read that %s after the controller resets", async (outcome) => {
    const initial = fixture();
    const fresh = structuredClone(initial);
    fresh.edges[0].revision += 1;
    let resolveRead!: (snapshot: ProjectSnapshot) => void;
    let rejectRead!: (error: Error) => void;
    const read = vi.spyOn(projectApi, "readTrash").mockImplementation(() => new Promise((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
    }));
    vi.spyOn(projectApi, "updateEdge")
      .mockRejectedValueOnce(new TypeError("Original response lost"))
      .mockRejectedValueOnce(new ProjectApiError("Revision conflict", 409));
    const history = vi.fn();
    const { result } = renderHook(() => {
      const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(initial);
      return useProjectEdgeController({ projectId: initial.project.id, snapshot, setSnapshot, externalBusy: false, onHistory: history });
    });
    act(() => { result.current.reconnect(initial.edges[0].id, {
      sourceItemId: "item-note", targetItemId: "item-reference", sourceHandle: "bottom", targetHandle: "top",
    }); });
    await waitFor(() => expect(result.current.pending?.status).toBe("uncertain"));
    act(() => result.current.retryExact());
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    act(() => result.current.resetForAuthoritativeReload());
    await act(async () => {
      if (outcome === "resolves") resolveRead(fresh);
      else rejectRead(new TypeError("Offline"));
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.actionError).toBe("");
    expect(result.current.unsafe).toBe(false);
    expect(history).not.toHaveBeenCalled();
  });
});
