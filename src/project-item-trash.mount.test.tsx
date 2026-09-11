// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord, ProjectItemLifecycleInput, ProjectItemMutationResponse, ProjectSnapshot } from "../shared/project-api";
import { ProjectApiError, projectApi } from "./lib/project-client";
import { projectActiveTrashSnapshot } from "./lib/project-item-trash";
import { useProjectItemTrash } from "./lib/use-project-item-trash";
import { projectTestSnapshot } from "./project-test-fixture";

function fixture() {
  const snapshot = projectTestSnapshot();
  const base = snapshot.items[0]!;
  snapshot.edges = [{
    id: "edge-cascade", projectId: base.projectId,
    sourceItemId: "item-note", targetItemId: "item-reference",
    sourceHandle: "right", targetHandle: "left", markerStart: "none", markerEnd: "arrow", label: null,
    revision: 1, createdBy: base.createdBy, updatedBy: base.updatedBy, createdAt: base.createdAt,
    updatedAt: base.updatedAt, deletedAt: null, deletedBy: null,
  }, {
    id: "edge-manual", projectId: base.projectId,
    sourceItemId: "item-note", targetItemId: "item-reference",
    sourceHandle: "top", targetHandle: "bottom", markerStart: "none", markerEnd: "none", label: null,
    revision: 2, createdBy: base.createdBy, updatedBy: base.updatedBy, createdAt: base.createdAt,
    updatedAt: base.updatedAt, deletedAt: base.updatedAt, deletedBy: base.updatedBy,
    deletionOperationId: "old-independent-edge-delete",
  }];
  return snapshot;
}

function server(initial = fixture()) {
  const state = structuredClone(initial);
  const mutations = new Map<string, ProjectItemMutationResponse>();
  const mutate = (itemId: string, input: ProjectItemLifecycleInput, remove: boolean) => {
    const replayed = mutations.get(input.operationId);
    if (replayed) return { ...structuredClone(replayed), replayed: true };
    const item = state.items.find((candidate) => candidate.id === itemId)!;
    const content = state.contents.find((candidate) => candidate.id === item.projectContentId) ?? null;
    if (input.expectedItemRevision !== item.revision || (content && input.expectedContentRevision !== content.revision)) {
      throw new ProjectApiError("Revision changed", 409);
    }
    item.revision += 1;
    item.deletedAt = remove ? "2026-09-11T10:00:00Z" : null;
    item.deletedBy = remove ? item.updatedBy : null;
    item.deletionOperationId = remove ? input.operationId : null;
    if (content) {
      content.revision += 1;
      content.deletedAt = item.deletedAt;
      content.deletedBy = item.deletedBy;
    }
    if (remove) for (const edge of state.edges) {
      if (edge.deletedAt === null && (edge.sourceItemId === itemId || edge.targetItemId === itemId)) {
        edge.deletedAt = item.deletedAt;
        edge.deletedBy = item.deletedBy;
        edge.deletionOperationId = input.operationId;
        edge.revision += 1;
      }
    }
    const result = structuredClone({
      item, content, attachment: null,
      placement: state.placements.find((candidate) => candidate.projectItemId === itemId)!,
      project: state.project, replayed: false,
    });
    mutations.set(input.operationId, result);
    return result;
  };
  const read = vi.spyOn(projectApi, "readTrash").mockImplementation(async () => structuredClone(state));
  const remove = vi.spyOn(projectApi, "removeItem").mockImplementation(async (_project, itemId, input) => mutate(itemId, input, true));
  const restore = vi.spyOn(projectApi, "restoreItem").mockImplementation(async (_project, itemId, input) => mutate(itemId, input, false));
  const edgeResults = new Map<string, ProjectEdgeRecord>();
  const restoreEdge = vi.spyOn(projectApi, "restoreEdge").mockImplementation(async (_project, id, input) => {
    if (edgeResults.has(input.operationId)) return { value: structuredClone(edgeResults.get(input.operationId)!), replayed: true };
    const edge = state.edges.find((candidate) => candidate.id === id)!;
    expect(state.items.filter((item) => [edge.sourceItemId, edge.targetItemId].includes(item.id)).every((item) => item.deletedAt === null)).toBe(true);
    expect(input.expectedRevision).toBe(edge.revision);
    edge.revision += 1;
    edge.deletedAt = null;
    edge.deletedBy = null;
    edge.deletionOperationId = null;
    edgeResults.set(input.operationId, structuredClone(edge));
    return { value: structuredClone(edge), replayed: false };
  });
  return { state, mutate, read, remove, restore, restoreEdge };
}

function harness(snapshot: ProjectSnapshot) {
  const onItemRemoved = vi.fn();
  const onItemRestored = vi.fn();
  const onEdgeRestored = vi.fn();
  const onAuthoritativeSnapshot = vi.fn();
  return {
    ...renderHook(() => useProjectItemTrash({
      projectId: "project-a", snapshot: projectActiveTrashSnapshot(snapshot), externalBusy: false,
      onItemRemoved, onItemRestored, onEdgeRestored, onAuthoritativeSnapshot,
    })),
    onItemRemoved, onItemRestored, onEdgeRestored, onAuthoritativeSnapshot,
  };
}

describe("Project trash recovery", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("undoes a batch with original placements and its cascade edge, preserving independently removed edges", async () => {
    const remote = server();
    const view = harness(remote.state);
    const placements = structuredClone(remote.state.placements);
    act(() => { expect(view.result.current.removeItems(["item-note", "item-reference"])).toBe(true); });
    await waitFor(() => expect(view.result.current.pending).toBe(null));
    expect(remote.remove).toHaveBeenCalledTimes(2);
    expect(view.result.current.canUndo).toBe(true);
    expect(view.result.current.undoPriority).toBe(true);
    act(() => view.result.current.invalidateUndoPriority());
    expect(view.result.current.undoPriority).toBe(false);
    expect(view.result.current.canUndo).toBe(true);
    act(() => { expect(view.result.current.undoRemoval()).toBe(true); });
    await waitFor(() => expect(view.result.current.pending).toBe(null));
    expect(remote.restore).toHaveBeenCalledTimes(2);
    expect(remote.restoreEdge).toHaveBeenCalledTimes(1);
    expect(remote.restoreEdge.mock.calls[0]![1]).toBe("edge-cascade");
    expect(remote.state.placements).toEqual(placements);
    expect(remote.state.edges.find((edge) => edge.id === "edge-manual")!.deletedAt).not.toBe(null);
    expect(view.result.current.canUndo).toBe(false);
    expect(view.onAuthoritativeSnapshot.mock.calls.at(-1)![0].edges.map((edge: ProjectEdgeRecord) => edge.id)).toEqual(["edge-cascade"]);
  });

  it("retains partial acknowledgements and retries the identical uncertain removal request", async () => {
    const remote = server();
    let loseResponse = true;
    remote.remove.mockImplementation(async (_project, itemId, input) => {
      const result = remote.mutate(itemId, input, true);
      if (itemId === "item-note" && loseResponse) { loseResponse = false; throw new TypeError("Network lost after commit"); }
      return result;
    });
    const view = harness(remote.state);
    act(() => { view.result.current.removeItems(["item-reference", "item-note"]); });
    await waitFor(() => expect(view.result.current.pending?.status).toBe("uncertain"));
    expect(view.result.current.pending?.completed).toBe(1);
    expect(view.result.current.unsafeRef.current).toBe(true);
    expect(view.onItemRemoved).toHaveBeenCalledTimes(1);
    const uncertainInput = structuredClone(remote.remove.mock.calls.at(-1)![2]);
    act(() => { void view.result.current.retry(); });
    await waitFor(() => expect(view.result.current.pending).toBe(null));
    expect(remote.remove).toHaveBeenCalledTimes(3);
    expect(remote.remove.mock.calls.at(-1)![2]).toEqual(uncertainInput);
    expect(view.onItemRemoved).toHaveBeenCalledTimes(2);
    expect(view.result.current.unsafeRef.current).toBe(false);
    expect(view.result.current.canUndo).toBe(true);
  });

  it("stops on a definite conflict and retries only reconciliation after its read fails", async () => {
    const remote = server();
    remote.remove.mockImplementation(async (_project, itemId, input) => {
      if (itemId === "item-note") throw new ProjectApiError("Content revision changed", 409);
      return remote.mutate(itemId, input, true);
    });
    remote.read.mockRejectedValueOnce(new TypeError("Offline"));
    const view = harness(remote.state);
    act(() => { view.result.current.removeItems(["item-reference", "item-note"]); });
    await waitFor(() => expect(view.result.current.pending?.status).toBe("reload"));
    expect(view.result.current.unsafeRef.current).toBe(true);
    act(() => { void view.result.current.retry(); });
    await waitFor(() => expect(view.result.current.pending).toBe(null));
    expect(remote.remove).toHaveBeenCalledTimes(2);
    expect(view.result.current.error).toContain("Completed changes are preserved");
    expect(view.result.current.canUndo).toBe(true);
    expect(view.onAuthoritativeSnapshot.mock.calls.at(-1)![0].items.map((item: { id: string }) => item.id)).toEqual(["item-note"]);
  });

  it("loads existing trash after reload and preserves deferred connections until the other endpoint is restored", async () => {
    const remote = server();
    remote.mutate("item-note", { expectedItemRevision: 1, expectedContentRevision: 1, operationId: "delete-note" }, true);
    remote.mutate("item-reference", { expectedItemRevision: 1, operationId: "delete-reference" }, true);
    const first = harness(remote.state);
    act(() => first.result.current.open());
    await waitFor(() => expect(first.result.current.entries).toHaveLength(2));
    act(() => { first.result.current.restoreItems(["item-note"]); });
    await waitFor(() => expect(first.result.current.pending).toBe(null));
    expect(remote.restoreEdge).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("project-trash-recovery:project-a")).toContain("delete-note");
    first.unmount();
    const second = harness(remote.state);
    act(() => { second.result.current.restoreItems(["item-reference"]); });
    await waitFor(() => expect(second.result.current.pending).toBe(null));
    expect(remote.restoreEdge).toHaveBeenCalledTimes(1);
    expect(remote.state.edges.find((edge) => edge.id === "edge-manual")!.deletedAt).not.toBe(null);
  });

  it("does not restore a remembered connection that was restored and then independently deleted again", async () => {
    const remote = server();
    remote.mutate("item-note", { expectedItemRevision: 1, expectedContentRevision: 1, operationId: "delete-note" }, true);
    sessionStorage.setItem("project-trash-recovery:project-a", JSON.stringify([{ edgeId: "edge-manual", deletionOperationId: "previous-cascade" }]));
    const view = harness(remote.state);
    act(() => { view.result.current.restoreItems(["item-note"]); });
    await waitFor(() => expect(view.result.current.pending).toBe(null));
    expect(remote.restoreEdge.mock.calls.map((call) => call[1])).toEqual(["edge-cascade"]);
  });

  it("records the existing single-item deletion callback without duplicating its Undo group", async () => {
    const remote = server();
    const view = harness(remote.state);
    const result = remote.mutate("item-note", { expectedItemRevision: 1, expectedContentRevision: 1, operationId: "legacy-remove" }, true);
    act(() => {
      view.result.current.onRemoved(result, "legacy-remove");
      view.result.current.onRemoved(result, "legacy-remove");
    });
    expect(view.result.current.message).toBe("Card moved to trash.");
    act(() => { view.result.current.undoRemoval(); });
    await waitFor(() => expect(view.result.current.pending).toBe(null));
    expect(remote.restore).toHaveBeenCalledTimes(1);
    expect(remote.restoreEdge).toHaveBeenCalledTimes(1);
  });

  it("retries an uncertain edge restore without replaying the acknowledged item restorations", async () => {
    const remote = server();
    remote.mutate("item-note", { expectedItemRevision: 1, expectedContentRevision: 1, operationId: "delete-note" }, true);
    const restoreEdge = remote.restoreEdge.getMockImplementation()!;
    let loseResponse = true;
    remote.restoreEdge.mockImplementation(async (...args) => {
      const result = await restoreEdge(...args);
      if (loseResponse) { loseResponse = false; throw new TypeError("Lost edge acknowledgement"); }
      return result;
    });
    const view = harness(remote.state);
    act(() => { view.result.current.restoreItems(["item-note"]); });
    await waitFor(() => expect(view.result.current.pending?.status).toBe("uncertain"));
    expect(view.onItemRestored).toHaveBeenCalledTimes(1);
    const input = structuredClone(remote.restoreEdge.mock.calls[0]![2]);
    act(() => { void view.result.current.retry(); });
    await waitFor(() => expect(view.result.current.pending).toBe(null));
    expect(remote.restore).toHaveBeenCalledTimes(1);
    expect(remote.restoreEdge).toHaveBeenCalledTimes(2);
    expect(remote.restoreEdge.mock.calls[1]![2]).toEqual(input);
    expect(view.onEdgeRestored).toHaveBeenCalledTimes(1);
  });

  it("does not install a late deletion acknowledgement in another Project", async () => {
    const remote = server();
    let finish!: (result: ProjectItemMutationResponse) => void;
    remote.remove.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onItemRemoved = vi.fn();
    const onAuthoritativeSnapshot = vi.fn();
    const view = renderHook(({ projectId }) => useProjectItemTrash({
      projectId, snapshot: projectActiveTrashSnapshot(remote.state), externalBusy: false,
      onItemRemoved, onItemRestored: vi.fn(), onEdgeRestored: vi.fn(), onAuthoritativeSnapshot,
    }), { initialProps: { projectId: "project-a" } });
    act(() => { view.result.current.removeItems(["item-note"]); });
    expect(view.result.current.unsafeRef.current).toBe(true);
    view.rerender({ projectId: "project-b" });
    expect(view.result.current.pending).toBe(null);
    expect(view.result.current.unsafeRef.current).toBe(false);
    await act(async () => {
      finish(remote.mutate("item-note", remote.remove.mock.calls[0]![2], true));
    });
    expect(onItemRemoved).not.toHaveBeenCalled();
    expect(onAuthoritativeSnapshot).not.toHaveBeenCalled();
    expect(view.result.current.canUndo).toBe(false);
    expect(view.result.current.message).toBe("");
  });

  it("does not let Undo reverse a later deletion of the same card", async () => {
    const remote = server();
    const view = harness(remote.state);
    const result = remote.mutate("item-note", { expectedItemRevision: 1, expectedContentRevision: 1, operationId: "our-removal" }, true);
    act(() => view.result.current.onRemoved(result, "our-removal"));
    remote.mutate("item-note", { expectedItemRevision: 2, expectedContentRevision: 2, operationId: "other-restoration" }, false);
    remote.mutate("item-note", { expectedItemRevision: 3, expectedContentRevision: 3, operationId: "later-removal" }, true);
    act(() => { view.result.current.undoRemoval(); });
    await waitFor(() => expect(view.result.current.pending).toBe(null));
    expect(remote.restore).not.toHaveBeenCalled();
    expect(remote.state.items.find((item) => item.id === "item-note")!.deletionOperationId).toBe("later-removal");
    expect(view.result.current.error).toContain("changed after this removal");
    expect(view.result.current.canUndo).toBe(false);
  });

  it("offers recovery after a reload between an item acknowledgement and its connection restoration", async () => {
    const remote = server();
    remote.mutate("item-note", { expectedItemRevision: 1, expectedContentRevision: 1, operationId: "delete-note" }, true);
    remote.mutate("item-note", { expectedItemRevision: 2, expectedContentRevision: 2, operationId: "restore-note" }, false);
    sessionStorage.setItem("project-trash-recovery:project-a", JSON.stringify([{ edgeId: "edge-cascade", deletionOperationId: "delete-note" }]));
    const view = harness(remote.state);
    act(() => view.result.current.open());
    await waitFor(() => expect(view.result.current.recoverableConnectionCount).toBe(1));
    expect(view.result.current.entries).toHaveLength(0);
    act(() => { view.result.current.restoreConnections(); });
    await waitFor(() => expect(view.result.current.pending).toBe(null));
    expect(remote.restore).not.toHaveBeenCalled();
    expect(remote.restoreEdge.mock.calls.map((call) => call[1])).toEqual(["edge-cascade"]);
    expect(view.result.current.recoverableConnectionCount).toBe(0);
  });
});
