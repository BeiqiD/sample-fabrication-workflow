// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord } from "../shared/project-api";
import { ProjectMapSurface } from "./components/project/ProjectMapSurface";
import { projectMapNodes } from "./lib/project-map-model";
import { projectTestSnapshot } from "./project-test-fixture";

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

describe("real Project edge surface", () => {
  beforeEach(() => {
    installReactFlowDomMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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
    const editItem = vi.fn();
    const editEdge = vi.fn();
    const deleteEdge = vi.fn();
    const openReferences = vi.fn();
    const openInspector = vi.fn();

    function ContextMenuHarness() {
      const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      const [rejectEdgeSelection, setRejectEdgeSelection] = useState(false);
      const selectedItemId = selectedItemIds.at(-1) ?? null;
      return <div className="project-desktop-workspace" style={{ width: 900, height: 700 }}>
        <button type="button" onClick={() => {
          setSelectedItemIds(["item-note", "item-reference"]);
          setSelectedEdgeId(null);
        }}>Select both for test</button>
        <button type="button" onClick={() => setRejectEdgeSelection(true)}>
          Reject edge selection for test
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
              removeDisabled: false,
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
    expect(view.getByRole("menuitem", { name: "Paste copied selection" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Open References" })).toBeTruthy();
    fireEvent.click(view.getByRole("menuitem", { name: "Add Markdown here" }));
    expect(addMarkdown).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(canvas()));

    fireEvent.contextMenu(note(), { clientX: 210, clientY: 180 });
    await waitFor(() => expect(view.getByRole("menu", { name: "Occurrence actions" })).toBeTruthy());
    expect(view.getByRole("menuitem", { name: "Edit Markdown" })).toBeTruthy();
    fireEvent.click(view.getByRole("menuitem", { name: "Inspect occurrence" }));
    expect(inspectItem).toHaveBeenCalledWith("item-note");

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
    expect(view.getByRole("menuitem", { name: "Align left" }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("menuitem", { name: "Bring to front" }).hasAttribute("disabled")).toBe(true);
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

    fireEvent.click(view.getByRole("button", { name: "Reject edge selection for test" }));
    await waitFor(() => expect(edge()).toBeTruthy());
    fireEvent.contextMenu(edge(), { clientX: 300, clientY: 220 });
    await waitFor(() => expect(container.querySelector(".project-map-context-menu")).toBeNull());
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
