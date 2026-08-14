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

});
