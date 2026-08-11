// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../shared/project-api";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    Controls: () => null,
    MiniMap: () => null,
    NodeResizer: () => null,
    useNodesState: (initializer: unknown) => {
      const [nodes, setNodes] = React.useState(() => typeof initializer === "function" ? (initializer as () => unknown[])() : initializer);
      return [nodes, setNodes, () => undefined];
    },
    ReactFlow: ({ nodes, nodeTypes, onNodeDragStart, onNodeDragStop, onSelectionChange, children }: any) => <div data-testid="mock-flow">
      {nodes.map((node: any) => {
        const NodeComponent = nodeTypes[node.type];
        return <div key={node.id}>
          <NodeComponent id={node.id} data={node.data} selected={false} type={node.type} dragging={false} zIndex={node.zIndex ?? 0} selectable draggable deletable width={node.style?.width} height={node.style?.height} />
          <button type="button" onClick={() => {
            onNodeDragStart?.({}, node, [node]);
            onNodeDragStop?.({}, { ...node, position: { x: node.position.x + 40, y: node.position.y + 10 } }, [node]);
          }}>Drag {node.id}</button>
          <button type="button" onClick={() => {
            node.data.onResizeStart(node.id);
            node.data.onResizeEnd(node.id, { x: node.position.x, y: node.position.y, width: Number(node.style.width) + 30, height: Number(node.style.height) + 20 });
          }}>Resize {node.id}</button>
          <button type="button" onClick={() => onSelectionChange?.({ nodes: [node], edges: [] })}>Select {node.id}</button>
        </div>;
      })}
      {children}
    </div>,
  };
});

import { ProjectMapEditor } from "./components/project/ProjectMapEditor";

function snapshot(): ProjectSnapshot {
  return {
    schemaVersion: 1,
    project: { id: "project-a", title: "Project A", revision: 1, nextCreatedSequence: 2, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, deletedBy: null },
    contents: [{ id: "content-a", projectId: "project-a", contentType: "markdown", markdownSource: "Map note", attachmentCaption: null, attachmentSourceUrl: null, formatVersion: 1, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, deletedBy: null }],
    attachments: [], references: [], edges: [],
    items: [{ id: "item-a", projectId: "project-a", itemType: "content", projectContentId: "content-a", referenceTargetId: null, createdSequence: 1, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, deletedBy: null }],
    placements: [{ id: "placement-a", projectItemId: "item-a", x: 10, y: 20, width: 240, height: 140, zIndex: 0, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z" }],
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }));
}

describe("Project Map editor", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "operation-a" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps drag local until explicit Save, then advances the authoritative placement revision", async () => {
    fetchMock.mockImplementation((_path, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        value: { id: "placement-a", projectItemId: "item-a", ...body.geometry, revision: 2, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:01:00.000Z" },
        replayed: false,
      });
    });

    render(<ProjectMapEditor snapshot={snapshot()} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Drag item-a" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("1 unsaved placement")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/projects/project-a/placements/placement-a");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      geometry: { x: 50, y: 30, width: 240, height: 140, zIndex: 0 },
      expectedRevision: 1,
      operationId: "placement-operation-a",
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("supports session undo/redo and bounded autosave after resize end", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_path, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ value: { id: "placement-a", projectItemId: "item-a", ...body.geometry, revision: 2, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:01:00.000Z" }, replayed: false });
    });

    render(<ProjectMapEditor snapshot={snapshot()} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Drag item-a" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.getByText("1 unsaved placement")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resize item-a" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_600);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps conflicting local geometry visible and requires authoritative reload", async () => {
    const reload = vi.fn();
    fetchMock.mockImplementation(() => jsonResponse({ error: "Project placement revision conflict" }, 409));

    render(<ProjectMapEditor snapshot={snapshot()} onReload={reload} />);
    fireEvent.click(screen.getByRole("button", { name: "Drag item-a" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Conflict")).toBeTruthy();
    expect(screen.getByText("Project placement revision conflict")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload authoritative snapshot" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
