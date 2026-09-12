// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord } from "../shared/project-api";
import { ProjectMapSurface, type ProjectMapContextCommands } from "./components/project/ProjectMapSurface";
import { projectMapNodes } from "./lib/project-map-model";
import { projectTestSnapshot, projectTestSnapshotWithAttachment } from "./project-test-fixture";

function testContentRect(target: Element): DOMRectReadOnly {
  const width = target instanceof HTMLElement ? target.offsetWidth : 1;
  const height = target instanceof HTMLElement ? target.offsetHeight : 1;
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({ x: 0, y: 0, width, height }),
  } as DOMRectReadOnly;
}

class TestResizeObserver {
  private readonly callback: ResizeObserverCallback;
  private readonly timers = new Set<number>();
  private active = true;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.active) return;
      this.callback([{
        target,
        contentRect: testContentRect(target),
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }, 0);
    this.timers.add(timer);
  }

  unobserve() {}

  disconnect() {
    this.active = false;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
  }
}

class TestDOMMatrixReadOnly {
  m22: number;

  constructor(transform = "") {
    const scale = transform.match(/scale\(([1-9.]+)\)/)?.[1];
    this.m22 = scale === undefined ? 1 : Number(scale);
  }
}

function installReactFlowDomMocks() {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", TestDOMMatrixReadOnly);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get() {
        return Number.parseFloat(this.style.height) || 1;
      },
    },
    offsetWidth: {
      configurable: true,
      get() {
        return Number.parseFloat(this.style.width) || 1;
      },
    },
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
}

function edgeRecord(overrides: Partial<ProjectEdgeRecord> = {}): ProjectEdgeRecord {
  const now = "2026-08-13T11:30:00.000Z";
  return {
    id: "edge-a",
    projectId: "project-a",
    sourceItemId: "item-note",
    targetItemId: "item-reference",
    sourceHandle: "right",
    targetHandle: "left",
    markerStart: "none",
    markerEnd: "arrow",
    label: "feeds",
    revision: 1,
    createdBy: "user@example.com",
    updatedBy: "user@example.com",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function availableContextCommands(): ProjectMapContextCommands {
  const noop = () => undefined;
  return {
    createDisabled: false, selectAllDisabled: false, clearSelectionDisabled: false,
    copyDisabled: false, pasteDisabled: false, editDisabled: false, removeDisabled: false,
    edgeInspectDisabled: false, edgeEditDisabled: false, edgeDeleteDisabled: false,
    panelCommandsDisabled: false, alignmentDisabled: () => false, zOrderDisabled: () => false,
    inspectItem: noop, editItem: noop, copyItemLink: noop, copySelection: noop,
    pasteSelection: noop, selectAll: noop, clearSelection: noop, alignSelection: noop,
    changeZOrder: noop, removeItem: noop, inspectEdge: noop, editEdge: noop, deleteEdge: noop,
    openReferences: noop, openInspector: noop,
  };
}

describe("real Project edge surface", () => {
  beforeEach(() => {
    installReactFlowDomMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("selects edges with one click and opens Details only on double-click, excluding reconnect controls and locked commands", async () => {
    const inspectEdge = vi.fn();
    const editEdge = vi.fn();
    const selected = vi.fn();
    const nodes = projectMapNodes(projectTestSnapshot());
    const edges = [edgeRecord()];
    function EdgeActivationHarness({ locked = false }: { locked?: boolean }) {
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      return <ProjectMapSurface nodes={nodes} edges={edges} selectedItemId={null} selectedEdgeId={selectedEdgeId}
        onSelect={() => undefined} onGeometryCommit={() => undefined} onEdgeReconnect={() => undefined}
        onEdgeSelect={(edgeId) => { selected(edgeId); setSelectedEdgeId(edgeId); }}
        contextCommands={{ ...availableContextCommands(), inspectEdge, editEdge, panelCommandsDisabled: locked }} />;
    }
    const view = render(<div style={{ width: 900, height: 700 }}><EdgeActivationHarness /></div>);
    const edge = await waitFor(() => {
      const element = view.container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]');
      expect(element).toBeTruthy();
      return element!;
    });
    const currentEdge = () => view.container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    const path = () => currentEdge().querySelector(".react-flow__edge-interaction")!;
    expect(edge).toBe(currentEdge());
    fireEvent.click(path(), { detail: 1, clientX: 300, clientY: 300 });
    expect(selected).toHaveBeenCalledExactlyOnceWith("edge-a");
    expect(inspectEdge).not.toHaveBeenCalled();
    expect(editEdge).not.toHaveBeenCalled();
    await waitFor(() => expect(currentEdge()).toBeTruthy());
    fireEvent.doubleClick(path(), { detail: 2, clientX: 300, clientY: 300 });
    expect(inspectEdge).toHaveBeenCalledExactlyOnceWith("edge-a");
    expect(editEdge).not.toHaveBeenCalled();
    inspectEdge.mockClear();
    expect(currentEdge().querySelectorAll(".react-flow__edgeupdater")).toHaveLength(2);
    for (const anchor of currentEdge().querySelectorAll(".react-flow__edgeupdater")) fireEvent.doubleClick(anchor);
    fireEvent.doubleClick(path(), { button: 2 });
    fireEvent.doubleClick(view.getByRole("button", { name: "Details" }));
    expect(inspectEdge).not.toHaveBeenCalled();
    expect(editEdge).not.toHaveBeenCalled();
    view.rerender(<div style={{ width: 900, height: 700 }}><EdgeActivationHarness locked /></div>);
    await waitFor(() => expect(currentEdge()).toBeTruthy());
    fireEvent.doubleClick(path());
    expect(inspectEdge).not.toHaveBeenCalled();
  });

  it("moves the selected edge actions to each pointer click but preserves their location for keyboard and context-menu actions", async () => {
    const nodes = projectMapNodes(projectTestSnapshot());
    const edges = [edgeRecord()];
    function EdgeAnchorHarness() {
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      return <ProjectMapSurface nodes={nodes} edges={edges} selectedItemId={null} selectedEdgeId={selectedEdgeId}
        onSelect={() => undefined} onGeometryCommit={() => undefined} onEdgeSelect={setSelectedEdgeId}
        contextCommands={availableContextCommands()} />;
    }
    const view = render(<div style={{ width: 1000, height: 700 }}><EdgeAnchorHarness /></div>);
    const edge = await waitFor(() => {
      const element = view.container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]');
      expect(element).toBeTruthy();
      return element!;
    });
    const canvas = view.getByTestId("project-flow-canvas");
    const currentEdge = () => view.container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON: () => ({}) });
    fireEvent.click(edge, { detail: 1, clientX: 300, clientY: 400 });
    const toolbar = await view.findByRole("toolbar", { name: "Selected edge actions" });
    const firstPosition = toolbar.style.transform;
    fireEvent.click(currentEdge(), { detail: 1, clientX: 700, clientY: 500 });
    await waitFor(() => expect(toolbar.style.transform).not.toBe(firstPosition));
    const secondPosition = toolbar.style.transform;
    fireEvent.click(currentEdge(), { detail: 0, clientX: 0, clientY: 0 });
    expect(toolbar.style.transform).toBe(secondPosition);
    fireEvent.contextMenu(currentEdge(), { clientX: 200, clientY: 200 });
    expect(toolbar.style.transform).toBe(secondPosition);
    fireEvent.click(currentEdge(), { detail: 1, button: 2, clientX: 100, clientY: 100 });
    expect(toolbar.style.transform).toBe(secondPosition);
    fireEvent.keyDown(currentEdge(), { key: "Escape" });
    expect(view.queryByRole("toolbar", { name: "Selected edge actions" })).toBeNull();
    await waitFor(() => expect(currentEdge()).toBeTruthy());
    fireEvent.keyDown(currentEdge(), { key: "Enter" });
    const keyboardToolbar = await view.findByRole("toolbar", { name: "Selected edge actions" });
    expect(keyboardToolbar.style.transform).not.toBe(secondPosition);
  });

  it("does not retain a pointer location from a rejected edge selection", async () => {
    const nodes = projectMapNodes(projectTestSnapshot());
    const edges = [edgeRecord()];
    function RejectedEdgeHarness({ blocked = false }: { blocked?: boolean }) {
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      return <ProjectMapSurface nodes={nodes} edges={edges} selectedItemId={null} selectedEdgeId={selectedEdgeId}
        onSelect={() => undefined} onGeometryCommit={() => undefined}
        onEdgeSelect={(edgeId) => { if (blocked) return false; setSelectedEdgeId(edgeId); return true; }}
        contextCommands={availableContextCommands()} />;
    }
    const view = render(<div style={{ width: 1000, height: 700 }}><RejectedEdgeHarness /></div>);
    const edge = () => view.container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    const canvas = view.getByTestId("project-flow-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON: () => ({}) });
    await waitFor(() => expect(edge()).toBeTruthy());
    fireEvent.keyDown(edge(), { key: "Enter" });
    const firstToolbar = await view.findByRole("toolbar", { name: "Selected edge actions" });
    const keyboardPosition = firstToolbar.style.transform;
    await waitFor(() => expect(edge()).toBeTruthy());
    fireEvent.keyDown(edge(), { key: "Escape" });
    view.rerender(<div style={{ width: 1000, height: 700 }}><RejectedEdgeHarness blocked /></div>);
    await waitFor(() => expect(edge()).toBeTruthy());
    fireEvent.click(edge(), { detail: 1, clientX: 800, clientY: 600 });
    expect(view.queryByRole("toolbar", { name: "Selected edge actions" })).toBeNull();
    expect(edge().classList.contains("selected")).toBe(false);
    view.rerender(<div style={{ width: 1000, height: 700 }}><RejectedEdgeHarness /></div>);
    await waitFor(() => expect(edge()).toBeTruthy());
    fireEvent.keyDown(edge(), { key: "Enter" });
    const toolbar = await view.findByRole("toolbar", { name: "Selected edge actions" });
    expect(toolbar.style.transform).toBe(keyboardPosition);
  });

  it.each(["source handle", "target item", "source move", "target resize"])(
    "retains the pointer anchor for metadata changes but discards it after a %s change, including after undo",
    async (change) => {
      const nodes = projectMapNodes(projectTestSnapshotWithAttachment());
      const record = edgeRecord();
      const noop = () => undefined;
      const commands = availableContextCommands();
      const surface = (nextNodes = nodes, nextEdge = record) => <div style={{ width: 1000, height: 700 }}>
        <ProjectMapSurface nodes={nextNodes} edges={[nextEdge]} selectedItemId={null} selectedEdgeId={record.id}
          onSelect={noop} onGeometryCommit={noop} onEdgeSelect={noop} contextCommands={commands} />
      </div>;
      const view = render(surface());
      const edge = () => view.container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
      const canvas = view.getByTestId("project-flow-canvas");
      vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON: () => ({}) });
      await waitFor(() => expect(edge()).toBeTruthy());
      await waitFor(() => expect(view.container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform).not.toContain("scale(1)"));
      const toolbar = await view.findByRole("toolbar", { name: "Selected edge actions" });
      const initialPosition = toolbar.style.transform;
      fireEvent.click(edge(), { detail: 1, clientX: 750, clientY: 550 });
      await waitFor(() => expect(toolbar.style.transform).not.toBe(initialPosition));
      const pointerPosition = toolbar.style.transform;
      const metadataNodes = nodes.map((node) => ({
        ...node, title: `${node.title} updated`, geometry: { ...node.geometry, zIndex: node.geometry.zIndex + 4 },
      }));
      const metadataEdge = { ...record, label: "new label", markerStart: "arrow" as const, revision: 2 };
      view.rerender(surface(metadataNodes, metadataEdge));
      await waitFor(() => expect(edge()?.textContent).toContain("new label"));
      expect(toolbar.style.transform).toBe(pointerPosition);

      const changedNodes = metadataNodes.map((node) => ({ ...node, geometry: {
        ...node.geometry,
        ...(change === "source move" && node.itemId === record.sourceItemId ? { x: node.geometry.x + 400, y: node.geometry.y + 200 } : {}),
        ...(change === "target resize" && node.itemId === record.targetItemId ? { width: node.geometry.width + 150, height: node.geometry.height + 100 } : {}),
      } }));
      const changedEdge = {
        ...metadataEdge,
        ...(change === "source handle" ? { sourceHandle: "bottom" as const } : {}),
        ...(change === "target item" ? { targetItemId: "item-attachment" } : {}),
      };
      view.rerender(surface(changedNodes, changedEdge));
      await waitFor(() => expect(toolbar.style.transform).not.toBe(pointerPosition));
      view.rerender(surface(metadataNodes, metadataEdge));
      await waitFor(() => expect(edge()?.textContent).toContain("new label"));
      expect(toolbar.style.transform).not.toBe(pointerPosition);
    },
  );

  it("keeps keyboard node, multi-edge, and empty selection synchronized", async () => {
    const snapshot = projectTestSnapshot();
    const edgeA = edgeRecord();
    const edgeB = edgeRecord({
      id: "edge-b",
      sourceHandle: "bottom",
      targetHandle: "top",
      markerEnd: "none",
      label: "backs",
    });
    const stableNodes = projectMapNodes(snapshot);
    const stableEdges = [edgeA, edgeB];
    const onSelect = vi.fn();
    const onEdgeSelect = vi.fn();
    const onGeometryCommit = vi.fn();

    function KeyboardSelectionHarness() {
      const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      const handleSelect = useCallback((itemId: string | null) => {
        onSelect(itemId);
        setSelectedItemId(itemId);
        if (itemId !== null) setSelectedEdgeId(null);
      }, []);
      const handleEdgeSelect = useCallback((edgeId: string | null) => {
        onEdgeSelect(edgeId);
        setSelectedEdgeId(edgeId);
        if (edgeId !== null) setSelectedItemId(null);
      }, []);
      return <ProjectMapSurface
        nodes={stableNodes}
        edges={stableEdges}
        selectedItemId={selectedItemId}
        selectedEdgeId={selectedEdgeId}
        onSelect={handleSelect}
        onEdgeSelect={handleEdgeSelect}
        onGeometryCommit={onGeometryCommit}
      />;
    }

    const { container } = render(<div style={{ width: 900, height: 700 }}><KeyboardSelectionHarness /></div>);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    const liveNoteNode = () => container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    const liveEdge = (edgeId: string) => container.querySelector<SVGGElement>(`.react-flow__edge[data-id="${edgeId}"]`)!;
    await waitFor(() => {
      expect(liveEdge("edge-a")).toBeTruthy();
      expect(liveEdge("edge-b")).toBeTruthy();
    });

    fireEvent.focus(liveNoteNode());
    fireEvent.keyDown(liveNoteNode(), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("item-note"));

    onSelect.mockClear();
    onEdgeSelect.mockClear();
    fireEvent.keyDown(liveNoteNode(), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    expect(onEdgeSelect).not.toHaveBeenCalledWith("edge-a");
    expect(onEdgeSelect).not.toHaveBeenCalledWith("edge-b");

    onSelect.mockClear();
    onEdgeSelect.mockClear();
    fireEvent.focus(liveEdge("edge-b"));
    fireEvent.keyDown(liveEdge("edge-b"), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-b"));
    await waitFor(() => expect(liveEdge("edge-b").classList.contains("selected")).toBe(true));

    onEdgeSelect.mockClear();
    fireEvent.focus(liveEdge("edge-a"));
    fireEvent.keyDown(liveEdge("edge-a"), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-a"));
    await waitFor(() => {
      expect(liveEdge("edge-a").classList.contains("selected")).toBe(true);
      expect(liveEdge("edge-b").classList.contains("selected")).toBe(false);
    });
    expect(onEdgeSelect).not.toHaveBeenLastCalledWith(null);

    onEdgeSelect.mockClear();
    fireEvent.focus(liveEdge("edge-b"));
    fireEvent.keyDown(liveEdge("edge-b"), { key: " ", code: "Space" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-b"));
    await waitFor(() => {
      expect(liveEdge("edge-b").classList.contains("selected")).toBe(true);
      expect(liveEdge("edge-a").classList.contains("selected")).toBe(false);
    });
    expect(onEdgeSelect).not.toHaveBeenLastCalledWith(null);

    onEdgeSelect.mockClear();
    fireEvent.keyDown(liveEdge("edge-b"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith(null));
    await waitFor(() => expect(liveEdge("edge-b").classList.contains("selected")).toBe(false));
  });


it("keeps edge selection and connection handles stable after local geometry moves before persistence", async () => {
  const snapshot = projectTestSnapshot();
  const edge = edgeRecord();
  const originalNodes = projectMapNodes(snapshot);
  const movedNodes = originalNodes.map((node) => node.itemId === "item-note"
    ? { ...node, geometry: { ...node.geometry, x: node.geometry.x + 96 } }
    : node);
  const onEdgeSelect = vi.fn();
  const { container, rerender } = render(<div style={{ width: 900, height: 700 }}>
    <ProjectMapSurface
      nodes={originalNodes}
      edges={[edge]}
      selectedItemId={null}
      selectedEdgeId={null}
      edgeInteractionDisabled={false}
      onSelect={() => undefined}
      onEdgeSelect={onEdgeSelect}
      onGeometryCommit={() => undefined}
    />
  </div>);

  await waitFor(() => expect(container.querySelectorAll(".project-edge-handle.connectable").length).toBe(8));
  rerender(<div style={{ width: 900, height: 700 }}>
    <ProjectMapSurface
      nodes={movedNodes}
      edges={[edge]}
      selectedItemId={null}
      selectedEdgeId={null}
      edgeInteractionDisabled={false}
      onSelect={() => undefined}
      onEdgeSelect={onEdgeSelect}
      onGeometryCommit={() => undefined}
    />
  </div>);

  await waitFor(() => expect(container.querySelectorAll(".project-edge-handle.connectable").length).toBe(8));
  const renderedEdge = await waitFor(() => {
    const candidate = container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]');
    expect(candidate).toBeTruthy();
    return candidate!;
  });
  fireEvent.click(renderedEdge);
  await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-a"));
});

  it("disables connection handles independently from node geometry interaction", async () => {
    const snapshot = projectTestSnapshot();
    const stableNodes = projectMapNodes(snapshot);
    const { container, rerender } = render(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={stableNodes}
        edgeInteractionDisabled
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);

    await waitFor(() => expect(container.querySelectorAll(".project-edge-handle").length).toBe(8));
    expect(container.querySelectorAll(".project-edge-handle.connectable").length).toBe(0);
    expect(container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')?.classList.contains("draggable")).toBe(true);

    rerender(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={stableNodes}
        edgeInteractionDisabled={false}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);
    await waitFor(() => expect(container.querySelectorAll(".project-edge-handle.connectable").length).toBe(8));
  });

  it("describes undirected, forward, reverse, and bidirectional edges accurately for keyboard users", async () => {
    const snapshot = projectTestSnapshot();
    const nodes = projectMapNodes(snapshot);
    const sourceTitle = nodes.find((node) => node.itemId === "item-note")!.title;
    const targetTitle = nodes.find((node) => node.itemId === "item-reference")!.title;
    const edges = [
      edgeRecord({ id: "edge-undirected", markerStart: "none", markerEnd: "none", label: null }),
      edgeRecord({ id: "edge-forward", markerStart: "none", markerEnd: "arrow", label: "feeds" }),
      edgeRecord({ id: "edge-reverse", markerStart: "arrow", markerEnd: "none", label: null }),
      edgeRecord({ id: "edge-bidirectional", markerStart: "arrow", markerEnd: "arrow", label: "coupled" }),
    ];
    const { container } = render(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={nodes}
        edges={edges}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);

    const aria = (edgeId: string) => container.querySelector<SVGGElement>(`.react-flow__edge[data-id="${edgeId}"]`)?.getAttribute("aria-label");
    await waitFor(() => expect(aria("edge-undirected")).toBe(`Undirected edge between ${sourceTitle} and ${targetTitle}`));
    expect(aria("edge-forward")).toBe(`Directed edge from ${sourceTitle} to ${targetTitle}; label: feeds`);
    expect(aria("edge-reverse")).toBe(`Directed edge from ${targetTitle} to ${sourceTitle}`);
    expect(aria("edge-bidirectional")).toBe(`Bidirectional edge between ${sourceTitle} and ${targetTitle}; label: coupled`);
  });

  it("renders four loose connection handles per node and an authoritative selectable Bezier edge", async () => {
    const snapshot = projectTestSnapshot();
    const edge = edgeRecord();
    const onSelect = vi.fn();
    const onEdgeSelect = vi.fn();
    const { container } = render(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)}
        edges={[edge]}
        selectedItemId={null}
        selectedEdgeId={null}
        onSelect={onSelect}
        onEdgeSelect={onEdgeSelect}
        onGeometryCommit={() => undefined}
      />
    </div>);

    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    expect(container.querySelectorAll(".project-edge-handle").length).toBe(8);
    for (const nodeId of ["item-note", "item-reference"]) {
      const node = container.querySelector(`.react-flow__node[data-id="${nodeId}"]`)!;
      for (const handle of ["top", "right", "bottom", "left"]) {
        expect(node.querySelector(`[data-handleid="${handle}"]`)).toBeTruthy();
      }
    }

    const noteNode = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    fireEvent.click(noteNode);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("item-note"));
    expect(onEdgeSelect).not.toHaveBeenCalledWith("edge-a");

    const renderedEdge = await waitFor(() => {
      const candidate = container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    expect(renderedEdge.textContent).toContain("feeds");
    expect(renderedEdge.querySelector(".react-flow__edge-path")).toBeTruthy();
    fireEvent.click(renderedEdge);
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-a"));
    expect(onEdgeSelect).toHaveBeenCalledWith("edge-a");
  });

  it("switches node, edge, node, and pane selection without controlled-selection feedback", async () => {
    const snapshot = projectTestSnapshot();
    const stableNodes = projectMapNodes(snapshot);
    const stableEdges = [edgeRecord()];
    const transitions: string[] = [];

    function ControlledClickHarness() {
      const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      const handleSelect = useCallback((itemId: string | null) => {
        transitions.push(`node:${itemId ?? "none"}`);
        if (transitions.length > 20) throw new Error("Project Map selection feedback loop");
        setSelectedItemId(itemId);
        if (itemId !== null) setSelectedEdgeId(null);
      }, []);
      const handleEdgeSelect = useCallback((edgeId: string | null) => {
        transitions.push(`edge:${edgeId ?? "none"}`);
        if (transitions.length > 20) throw new Error("Project Map selection feedback loop");
        setSelectedEdgeId(edgeId);
        if (edgeId !== null) setSelectedItemId(null);
      }, []);
      return <ProjectMapSurface
        nodes={stableNodes}
        edges={stableEdges}
        selectedItemId={selectedItemId}
        selectedEdgeId={selectedEdgeId}
        onSelect={handleSelect}
        onEdgeSelect={handleEdgeSelect}
        onGeometryCommit={() => undefined}
      />;
    }

    const { container } = render(<div style={{ width: 900, height: 700 }}><ControlledClickHarness /></div>);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    const liveNode = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
    const liveEdge = () => container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    const pane = () => container.querySelector<HTMLElement>(".react-flow__pane")!;
    await waitFor(() => expect(liveEdge()).toBeTruthy());

    fireEvent.click(liveNode("item-note"));
    await waitFor(() => expect(liveNode("item-note").classList.contains("selected")).toBe(true));
    transitions.length = 0;

    fireEvent.click(liveEdge());
    await waitFor(() => {
      expect(liveEdge().classList.contains("selected")).toBe(true);
      expect(liveNode("item-note").classList.contains("selected")).toBe(false);
    });
    expect(transitions).toContain("edge:edge-a");
    expect(transitions.length).toBeLessThanOrEqual(6);

    transitions.length = 0;
    fireEvent.click(liveNode("item-reference"));
    await waitFor(() => {
      expect(liveNode("item-reference").classList.contains("selected")).toBe(true);
      expect(liveEdge().classList.contains("selected")).toBe(false);
    });
    expect(transitions).toContain("node:item-reference");
    expect(transitions.length).toBeLessThanOrEqual(6);

    transitions.length = 0;
    fireEvent.click(pane());
    await waitFor(() => expect(liveNode("item-reference").classList.contains("selected")).toBe(false));
    expect(transitions).toContain("node:none");
    expect(transitions.length).toBeLessThanOrEqual(4);
  });


  it("closes the attachment menu when an already-selected node or edge is clicked without rewriting selection", async () => {
    const snapshot = projectTestSnapshot();
    const stableNodes = projectMapNodes(snapshot);
    const stableEdges = [edgeRecord()];
    const nodeSelections: Array<string | null> = [];
    const edgeSelections: Array<string | null> = [];

    function ControlledMenuHarness() {
      const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      const handleSelect = useCallback((itemId: string | null) => {
        nodeSelections.push(itemId);
        setSelectedItemId(itemId);
        if (itemId !== null) setSelectedEdgeId(null);
      }, []);
      const handleEdgeSelect = useCallback((edgeId: string | null) => {
        edgeSelections.push(edgeId);
        setSelectedEdgeId(edgeId);
        if (edgeId !== null) setSelectedItemId(null);
      }, []);
      return <ProjectMapSurface
        nodes={stableNodes}
        edges={stableEdges}
        selectedItemId={selectedItemId}
        selectedEdgeId={selectedEdgeId}
        onSelect={handleSelect}
        onEdgeSelect={handleEdgeSelect}
        onGeometryCommit={() => undefined}
        onAttachmentRequest={() => undefined}
      />;
    }

    const { container } = render(<div style={{ width: 900, height: 700 }}><ControlledMenuHarness /></div>);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    const node = () => container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    const edge = () => container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    const pane = () => container.querySelector<HTMLElement>(".react-flow__pane")!;
    const menu = () => container.querySelector<HTMLElement>('.project-map-context-menu[role="menu"]');
    await waitFor(() => expect(edge()).toBeTruthy());

    fireEvent.click(node());
    await waitFor(() => expect(node().classList.contains("selected")).toBe(true));
    const nodeSelectionCount = nodeSelections.length;

    fireEvent.contextMenu(pane(), { clientX: 120, clientY: 110 });
    await waitFor(() => expect(menu()).toBeTruthy());
    fireEvent.click(node());
    await waitFor(() => expect(menu()).toBeNull());
    expect(nodeSelections).toHaveLength(nodeSelectionCount);

    fireEvent.click(edge());
    await waitFor(() => expect(edge().classList.contains("selected")).toBe(true));
    const edgeSelectionCount = edgeSelections.length;

    fireEvent.contextMenu(pane(), { clientX: 160, clientY: 130 });
    await waitFor(() => expect(menu()).toBeTruthy());
    fireEvent.click(edge());
    await waitFor(() => expect(menu()).toBeNull());
    expect(edgeSelections).toHaveLength(edgeSelectionCount);
  });

  it("exposes reconnect anchors and edits a selected edge beside the canvas", async () => {
    const snapshot = projectTestSnapshot();
    const edge = edgeRecord();
    const reconnect = vi.fn();
    const changeEdit = vi.fn();
    const saveEdit = vi.fn();
    const editEdge = vi.fn();
    const noop = () => undefined;
    const commands = {
      createDisabled: false, selectAllDisabled: false, clearSelectionDisabled: false,
      copyDisabled: true, pasteDisabled: true, editDisabled: true, removeDisabled: true,
      edgeInspectDisabled: false, edgeEditDisabled: false, edgeDeleteDisabled: false, panelCommandsDisabled: false,
      alignmentDisabled: () => true, zOrderDisabled: () => true,
      inspectItem: noop, editItem: noop, copyItemLink: noop, copySelection: noop,
      pasteSelection: noop, selectAll: noop, clearSelection: noop, alignSelection: noop,
      changeZOrder: noop, removeItem: noop, inspectEdge: noop, editEdge, deleteEdge: noop,
      openReferences: noop, openInspector: noop,
    };
    const props = {
      nodes: projectMapNodes(snapshot), edges: [edge], selectedItemId: null, selectedEdgeId: edge.id,
      onSelect: noop, onGeometryCommit: noop, onEdgeReconnect: reconnect, contextCommands: commands,
    };
    const view = render(<div style={{ width: 900, height: 700 }}><ProjectMapSurface {...props} /></div>);
    await waitFor(() => expect(view.container.querySelectorAll(".react-flow__edgeupdater")).toHaveLength(2));
    fireEvent.click(view.getByRole("button", { name: "Edit label / direction" }));
    expect(editEdge).toHaveBeenCalledOnce();
    view.rerender(<div style={{ width: 900, height: 700 }}><ProjectMapSurface {...props}
      edgeInteractionDisabled
      edgeEditor={{ edgeId: edge.id, direction: "forward", label: "feeds", status: "editing", message: null }}
      onEdgeEditChange={changeEdit} onEdgeEditSave={saveEdit} onEdgeEditCancel={noop}
    /></div>);
    expect(view.container.querySelectorAll(".react-flow__edgeupdater")).toHaveLength(0);
    expect(view.getByRole("group", { name: "Edit selected edge" })).toBeTruthy();
    fireEvent.change(view.getByRole("textbox", { name: "Edge label" }), { target: { value: "measured by" } });
    fireEvent.click(view.getByRole("radio", { name: "Both directions" }));
    expect(changeEdit).toHaveBeenCalledWith("label", "measured by");
    expect(changeEdit).toHaveBeenCalledWith("direction", "bidirectional");
    fireEvent.keyDown(view.getByRole("textbox", { name: "Edge label" }), { key: "s", ctrlKey: true });
    expect(saveEdit).toHaveBeenCalledOnce();
  });

  it("shows only the edge toolbar when a newly selected edge retains its source card selection", async () => {
    const edge = edgeRecord();
    const props = {
      nodes: projectMapNodes(projectTestSnapshot()), edges: [edge],
      selectedItemId: "item-note", selectedItemIds: ["item-note"],
      onSelect: () => undefined, onGeometryCommit: () => undefined,
      contextCommands: availableContextCommands(),
    };
    const view = render(<div style={{ width: 900, height: 700 }}><ProjectMapSurface {...props} /></div>);
    await view.findByRole("toolbar", { name: "Selected card actions" });
    view.rerender(<div style={{ width: 900, height: 700 }}><ProjectMapSurface {...props} selectedEdgeId={edge.id} /></div>);
    await view.findByRole("toolbar", { name: "Selected edge actions" });
    expect(view.queryByRole("toolbar", { name: "Selected card actions" })).toBeNull();
    expect(view.queryByRole("button", { name: "More card actions" })).toBeNull();
    view.rerender(<div style={{ width: 900, height: 700 }}><ProjectMapSurface {...props} selectedEdgeId={null} /></div>);
    await view.findByRole("toolbar", { name: "Selected card actions" });
    expect(view.queryByRole("toolbar", { name: "Selected edge actions" })).toBeNull();
  });

  it.each(["editing", "error", "uncertain"] as const)(
    "dispatches button and Ctrl/Cmd+S through the supplied edge-save action in %s state",
    async (status) => {
      const edge = edgeRecord();
      const save = vi.fn();
      const view = render(<div style={{ width: 900, height: 700 }}><ProjectMapSurface
        nodes={projectMapNodes(projectTestSnapshot())} edges={[edge]}
        selectedItemId={null} selectedEdgeId={edge.id} edgeInteractionDisabled
        onSelect={() => undefined} onGeometryCommit={() => undefined}
        contextCommands={availableContextCommands()}
        edgeEditor={{ edgeId: edge.id, direction: "forward", label: "feeds", status, message: null }}
        onEdgeEditSave={save}
      /></div>);
      const saveButton = await view.findByRole("button", { name: status === "uncertain" ? "Retry exact save" : "Save edge" });
      expect(saveButton.hasAttribute("disabled")).toBe(false);
      const input = view.getByRole("textbox", { name: "Edge label" });
      expect(input.hasAttribute("disabled")).toBe(status === "uncertain");
      fireEvent.click(saveButton);
      expect(save).toHaveBeenCalledTimes(1);
      // An uncertain request remains immutable; its enabled retry button can own keyboard focus.
      const focusTarget = status === "uncertain" ? saveButton : input;
      focusTarget.focus();
      expect(document.activeElement).toBe(focusTarget);
      const escapedShortcut = vi.fn();
      document.addEventListener("keydown", escapedShortcut);
      try {
        for (const modifier of ["ctrlKey", "metaKey"] as const) {
          const event = new KeyboardEvent("keydown", { key: "s", [modifier]: true, bubbles: true, cancelable: true });
          fireEvent(document.activeElement!, event);
          expect(event.defaultPrevented).toBe(true);
        }
      } finally {
        document.removeEventListener("keydown", escapedShortcut);
      }
      expect(save).toHaveBeenCalledTimes(3);
      expect(escapedShortcut).not.toHaveBeenCalled();
    },
  );

  it("projects context-aware commands above panels with exact links, availability, and focus", async () => {
    const snapshot = projectTestSnapshot();
    const baseNodes = projectMapNodes(snapshot);
    const attachmentNode = {
      ...baseNodes[0],
      itemId: "item-attachment",
      placementId: "placement-attachment",
      kind: "attachment" as const,
      title: "attachment.pdf",
      subtitle: "application/pdf",
      excerpt: "Attachment caption",
      geometry: { ...baseNodes[0].geometry, x: 600, zIndex: 2 },
      createdSequence: 3,
      contentId: "content-attachment",
      markdownSource: null,
      attachmentCaption: "Attachment caption",
      attachmentSourceUrl: "https://example.com/source",
      mimeType: "application/pdf",
      attachmentByteSize: 42,
      fileUrl: "/api/projects/project-a/contents/content-attachment/file",
      openReferenceUrl: null,
    };
    const stableNodes = [...baseNodes, attachmentNode];
    const stableEdges = [edgeRecord()];
    const addMarkdown = vi.fn();
    const addAttachment = vi.fn();
    const inspectItem = vi.fn();
    const inspectEdge = vi.fn();
    const copyItemLink = vi.fn();
    const copySelection = vi.fn();
    const pasteSelection = vi.fn();
    const selectAll = vi.fn();
    const clearSelection = vi.fn();
    const alignSelection = vi.fn();
    const changeZOrder = vi.fn();
    const removeItem = vi.fn();
    const removeSelection = vi.fn();
    const editItem = vi.fn();
    const editEdge = vi.fn();
    const deleteEdge = vi.fn();
    const openReferences = vi.fn();
    const openInspector = vi.fn();

    function ContextMenuHarness() {
      const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      const [rejectEdgeSelection, setRejectEdgeSelection] = useState(false);
      const [removalDisabled, setRemovalDisabled] = useState(false);
      const selectedItemId = selectedItemIds.at(-1) ?? null;
      return <div className="project-desktop-workspace" style={{ width: 900, height: 700 }}>
        <button type="button" onClick={() => {
          setSelectedItemIds(["item-note", "item-reference"]);
          setSelectedEdgeId(null);
        }}>Select both for test</button>
        <button type="button" onClick={() => setRejectEdgeSelection(true)}>
          Reject edge selection for test
        </button>
        <button type="button" onClick={() => setRemovalDisabled(true)}>
          Disable card removal for test
        </button>
        <div className="project-map-panel">
          <ProjectMapSurface
            nodes={stableNodes}
            edges={stableEdges}
            selectedItemId={selectedItemId}
            selectedItemIds={selectedItemIds}
            selectedEdgeId={selectedEdgeId}
            onSelect={(itemId) => {
              setSelectedItemIds(itemId ? [itemId] : []);
              if (itemId) setSelectedEdgeId(null);
            }}
            onSelectionChange={(selection) => {
              setSelectedItemIds(selection.itemIds);
              if (selection.itemIds.length > 0) setSelectedEdgeId(null);
            }}
            onEdgeSelect={(edgeId) => {
              if (rejectEdgeSelection) return false;
              setSelectedEdgeId(edgeId);
              if (edgeId) setSelectedItemIds([]);
              return true;
            }}
            onGeometryCommit={() => undefined}
            onMarkdownCreateRequest={addMarkdown}
            onAttachmentRequest={addAttachment}
            contextCommands={{
              createDisabled: false,
              selectAllDisabled: false,
              clearSelectionDisabled: selectedItemIds.length === 0 && selectedEdgeId === null,
              copyDisabled: selectedItemIds.length === 0,
              pasteDisabled: false,
              editDisabled: false,
              removeDisabled: removalDisabled,
              edgeInspectDisabled: false,
              edgeEditDisabled: false,
              edgeDeleteDisabled: false,
              panelCommandsDisabled: false,
              alignmentDisabled: (alignment) => alignment === "left",
              zOrderDisabled: (action) => action === "bring-to-front",
              inspectItem,
              editItem,
              copyItemLink,
              copySelection,
              pasteSelection,
              selectAll,
              clearSelection,
              alignSelection,
              changeZOrder,
              removeItem,
              removeSelection,
              inspectEdge,
              editEdge,
              deleteEdge,
              openReferences,
              openInspector,
            }}
          />
        </div>
      </div>;
    }

    const view = render(<ContextMenuHarness />);
    const { container } = view;
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(3));
    const workspace = () => container.querySelector<HTMLElement>(".project-desktop-workspace")!;
    const canvas = () => container.querySelector<HTMLElement>("[data-testid='project-flow-canvas']")!;
    const pane = () => container.querySelector<HTMLElement>(".react-flow__pane")!;
    const note = () => container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    const attachment = () => container.querySelector<HTMLElement>('.react-flow__node[data-id="item-attachment"]')!;
    const edge = () => container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    const menu = () => container.querySelector<HTMLElement>('.project-map-context-menu[role="menu"]')!;
    await waitFor(() => expect(edge()).toBeTruthy());

    fireEvent.contextMenu(pane(), { clientX: 110, clientY: 120 });
    await waitFor(() => expect(view.getByRole("menu", { name: "Canvas actions" })).toBeTruthy());
    expect(menu().parentElement).toBe(workspace());
    expect(container.querySelector(".project-map-panel .project-map-context-menu")).toBeNull();
    expect(view.getByRole("menuitem", { name: "Add Markdown here" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Paste here" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Open References" })).toBeTruthy();
    fireEvent.click(view.getByRole("menuitem", { name: "Add Markdown here" }));
    expect(addMarkdown).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(canvas()));

    fireEvent.contextMenu(note(), { clientX: 210, clientY: 180 });
    await waitFor(() => expect(view.getByRole("menu", { name: "Occurrence actions" })).toBeTruthy());
    expect(view.getByRole("menuitem", { name: "Edit Markdown" })).toBeTruthy();
    fireEvent.click(view.getByRole("menuitem", { name: "Inspect occurrence" }));
    expect(inspectItem).toHaveBeenCalledWith("item-note");
    const moreCardActions = view.getByRole("button", { name: "More card actions" });
    fireEvent.click(moreCardActions);
    expect(view.getByRole("menu", { name: "Occurrence actions" })).toBeTruthy();
    fireEvent.keyDown(menu(), { key: "Delete" });
    expect(removeSelection).not.toHaveBeenCalled();
    fireEvent.keyDown(menu(), { key: "Escape" });

    fireEvent.contextMenu(attachment(), { clientX: 680, clientY: 180 });
    await waitFor(() => expect(view.getByRole("menu", { name: "Occurrence actions" })).toBeTruthy());
    expect(view.getByRole("menuitem", { name: "Open attachment" }).getAttribute("href"))
      .toBe("/api/projects/project-a/contents/content-attachment/file");
    expect(view.getByRole("menuitem", { name: "Open source URL" }).getAttribute("href"))
      .toBe("https://example.com/source");

    fireEvent.click(view.getByRole("button", { name: "Select both for test" }));
    await waitFor(() => expect(note().classList.contains("selected")).toBe(true));
    fireEvent.contextMenu(note(), { clientX: 250, clientY: 200 });
    await waitFor(() => expect(view.getByRole("menu", { name: "Selection actions" })).toBeTruthy());
    expect(view.queryByRole("menuitem", { name: "Align left" })).toBeNull();
    const alignMenu = view.getByRole("menuitem", { name: "Align" });
    alignMenu.focus();
    fireEvent.keyDown(alignMenu, { key: "ArrowRight" });
    expect(view.getByRole("menu", { name: "Align actions" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Align left" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(menu(), { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Align" })));
    fireEvent.click(view.getByRole("menuitem", { name: "Layer" }));
    expect(view.getByRole("menuitem", { name: "Bring to front" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(view.getByRole("menuitem", { name: "Back to actions" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Align" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Align right" }));
    expect(alignSelection).toHaveBeenCalledWith("right");
    await waitFor(() => expect(document.activeElement).toBe(canvas()));

    fireEvent.contextMenu(edge(), { clientX: 300, clientY: 220 });
    await waitFor(() => expect(view.getByRole("menu", { name: "Edge actions" })).toBeTruthy());
    expect(inspectEdge).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("menuitem", { name: "Inspect edge" }));
    expect(inspectEdge).toHaveBeenCalledWith("edge-a");

    fireEvent.contextMenu(pane(), { clientX: 150, clientY: 150 });
    await waitFor(() => expect(document.activeElement).toBe(
      view.getByRole("menuitem", { name: "Add Markdown here" }),
    ));
    fireEvent.keyDown(menu(), { key: "End" });
    expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Open Inspector" }));
    fireEvent.keyDown(menu(), { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".project-map-context-menu")).toBeNull());
    expect(document.activeElement).toBe(canvas());

    fireEvent.contextMenu(pane(), { clientX: 380, clientY: 300 });
    fireEvent.click(view.getByRole("menuitem", { name: "Paste here" }));
    expect(pasteSelection).toHaveBeenCalledWith({ x: expect.any(Number), y: expect.any(Number) });
    const pastePoint = pasteSelection.mock.calls[0][0];
    fireEvent.contextMenu(pane(), { clientX: 380, clientY: 300 });
    fireEvent.click(view.getByRole("menuitem", { name: "Add Markdown here" }));
    expect(addMarkdown).toHaveBeenLastCalledWith(pastePoint);

    fireEvent.click(view.getByRole("button", { name: "Select both for test" }));
    fireEvent.keyDown(attachment().querySelector("a")!, { key: "Backspace" });
    expect(removeSelection).not.toHaveBeenCalled();
    fireEvent.keyDown(note().querySelector("[data-project-card-content]")!, { key: "Backspace" });
    expect(removeSelection).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(canvas(), { key: "Delete" });
    expect(removeSelection).toHaveBeenCalledTimes(2);
    expect(removeItem).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Disable card removal for test" }));
    fireEvent.keyDown(note().querySelector("[data-project-card-content]")!, { key: "Delete" });
    fireEvent.keyDown(canvas(), { key: "Backspace" });
    expect(removeSelection).toHaveBeenCalledTimes(2);
    expect(removeItem).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Reject edge selection for test" }));
    await waitFor(() => expect(edge()).toBeTruthy());
    fireEvent.contextMenu(edge(), { clientX: 300, clientY: 220 });
    await waitFor(() => expect(container.querySelector(".project-map-context-menu")).toBeNull());
  });

  it("contains Ctrl/Cmd+A while an occurrence menu owns focus", async () => {
    const nodes = projectMapNodes(projectTestSnapshot());
    const onSelect = vi.fn();
    const view = render(<div className="project-desktop-workspace" style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={nodes}
        selectedItemId={null}
        onSelect={onSelect}
        onGeometryCommit={() => undefined}
      />
    </div>);
    const { container } = view;
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2));
    const reference = container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="item-reference"]',
    )!;

    fireEvent.contextMenu(reference, { clientX: 420, clientY: 180 });
    await waitFor(() => expect(view.getByRole("menu", { name: "Occurrence actions" })).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(
      view.getByRole("menuitem", { name: /Open source|Reference details/ }),
    ));

    const leakedSelectAll = vi.fn();
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") leakedSelectAll();
    };
    const shortcutEvents: KeyboardEvent[] = [];
    document.addEventListener("keydown", onDocumentKeyDown);
    try {
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        const event = new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA",
          bubbles: true,
          cancelable: true,
          ...modifier,
        });
        fireEvent(document.activeElement!, event);
        shortcutEvents.push(event);
      }
    } finally {
      document.removeEventListener("keydown", onDocumentKeyDown);
    }

    for (const event of shortcutEvents) expect(event.defaultPrevented).toBe(true);
    expect(leakedSelectAll).not.toHaveBeenCalled();
    expect(view.getByRole("menu", { name: "Occurrence actions" })).toBeTruthy();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("item-reference");
  });

  it("keeps selected and failed edge markers aligned with Project state tokens", async () => {
    const snapshot = projectTestSnapshot();
    const selectedEdge = edgeRecord();
    const { container } = render(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)}
        edges={[selectedEdge]}
        pendingEdge={{
          edgeId: "edge-conflict",
          sourceItemId: "item-note",
          targetItemId: "item-reference",
          sourceHandle: "bottom",
          targetHandle: "top",
          markerStart: "none",
          markerEnd: "arrow",
          label: "retry",
          status: "conflict",
        }}
        selectedItemId={null}
        selectedEdgeId={selectedEdge.id}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);

    const renderedEdge = (edgeId: string) => container.querySelector<SVGGElement>(
      `.react-flow__edge[data-id="${edgeId}"]`,
    );
    const markerColor = (edgeId: string) => {
      const edge = renderedEdge(edgeId);
      expect(edge).toBeTruthy();
      const markerReference = edge!.querySelector<SVGPathElement>(
        ".react-flow__edge-path",
      )?.getAttribute("marker-end");
      const markerId = markerReference?.match(/^url\('#(.+)'\)$/)?.[1];
      expect(markerId).toBeTruthy();
      const marker = document.getElementById(markerId!);
      expect(marker).toBeTruthy();
      const symbol = marker?.querySelector<SVGPolylineElement>(".arrowclosed");
      expect(symbol).toBeTruthy();
      return {
        stroke: symbol!.style.stroke,
        fill: symbol!.style.fill,
      };
    };

    await waitFor(() => expect(renderedEdge("edge-a")).toBeTruthy());
    await waitFor(() => expect(renderedEdge("edge-conflict")).toBeTruthy());
    expect(renderedEdge("edge-a")?.classList.contains("selected")).toBe(true);
    expect(renderedEdge("edge-conflict")?.classList.contains("project-edge-pending")).toBe(true);
    expect(renderedEdge("edge-conflict")?.classList.contains("conflict")).toBe(true);
    await waitFor(() => expect(markerColor("edge-a")).toEqual({
      stroke: "var(--accent)",
      fill: "var(--accent)",
    }));
    expect(markerColor("edge-conflict")).toEqual({
      stroke: "var(--danger)",
      fill: "var(--danger)",
    });
  });


});
