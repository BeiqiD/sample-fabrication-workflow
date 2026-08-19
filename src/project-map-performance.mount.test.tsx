// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord } from "../shared/project-api";
import { ProjectMapSurface } from "./components/project/ProjectMapSurface";
import type { ProjectNodeDescriptor } from "./lib/project-map-model";
import { projectMapNodes } from "./lib/project-map-model";
import { projectTestSnapshot } from "./project-test-fixture";

function contentRect(target: Element): DOMRectReadOnly {
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
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    window.setTimeout(() => this.callback([{
      target,
      contentRect: contentRect(target),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver), 0);
  }
  unobserve() {}
  disconnect() {}
}

class TestDOMMatrixReadOnly {
  m22: number;
  constructor(transform = "") {
    const scale = transform.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale === undefined ? 1 : Number(scale);
  }
}

function installDomMocks() {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", TestDOMMatrixReadOnly);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get() { return Number.parseFloat(this.style.height) || 1; },
    },
    offsetWidth: {
      configurable: true,
      get() { return Number.parseFloat(this.style.width) || 1; },
    },
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
}

function descriptors(count: number): ProjectNodeDescriptor[] {
  return Array.from({ length: count }, (_, index) => ({
    itemId: `item-${index}`,
    placementId: `placement-${index}`,
    kind: index % 3 === 0 ? "attachment" : index % 3 === 1 ? "reference" : "markdown",
    title: `Node ${index}`,
    subtitle: `Context ${index}`,
    excerpt: `Detailed content ${index} that is intentionally omitted outside full detail.`,
    geometry: {
      x: (index % 25) * 320,
      y: Math.floor(index / 25) * 230,
      width: 260,
      height: 170,
      zIndex: index,
    },
    createdSequence: index + 1,
    contentId: index % 3 === 1 ? null : `content-${index}`,
    markdownSource: index % 3 === 2 ? `# Node ${index}` : null,
    attachmentCaption: index % 3 === 0 ? `Image ${index}` : null,
    attachmentSourceUrl: null,
    mimeType: index % 3 === 0 ? "image/png" : null,
    attachmentByteSize: index % 3 === 0 ? 100 : null,
    fileUrl: index % 3 === 0 ? `/api/test/image-${index}.png` : null,
    openReferenceUrl: index % 3 === 1 ? `/references/${index}` : null,
  }));
}

function trackedDescriptors(count: number, excerptReads: number[]): ProjectNodeDescriptor[] {
  return descriptors(count).map((descriptor, index) => {
    const excerpt = descriptor.excerpt;
    return Object.defineProperty({ ...descriptor }, "excerpt", {
      configurable: true,
      enumerable: true,
      get() {
        excerptReads[index] += 1;
        return excerpt;
      },
    });
  });
}

function fitViewFullDescriptors(count: number): ProjectNodeDescriptor[] {
  return descriptors(count).map((descriptor, index) => ({
    ...descriptor,
    geometry: {
      ...descriptor.geometry,
      x: (index % 20) * 2,
      y: Math.floor(index / 20) * 2,
    },
  }));
}

function edges(nodeCount: number, edgeCount: number): ProjectEdgeRecord[] {
  return Array.from({ length: edgeCount }, (_, index) => {
    const source = index % nodeCount;
    let target = (index * 7 + 1) % nodeCount;
    if (target === source) target = (target + 1) % nodeCount;
    return {
      id: `edge-${index}`,
      projectId: "project-performance",
      sourceItemId: `item-${source}`,
      targetItemId: `item-${target}`,
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: `Relation ${index}`,
      revision: 1,
      createdBy: "test@example.com",
      updatedBy: "test@example.com",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      deletedAt: null,
      deletedBy: null,
    };
  });
}

describe("Project Map representative-scale contract", () => {
  beforeEach(installDomMocks);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps ordinary maps at full detail across viewport zoom", async () => {
    const { container } = render(<div style={{ width: 900, height: 650 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(projectTestSnapshot())}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);
    const canvas = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>("[data-testid=project-flow-canvas]");
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    await waitFor(() => expect(canvas.dataset.projectMapDetail).toBe("full"));
    expect(canvas.dataset.projectMapScale).toBe("ordinary");
    expect(container.querySelector(".project-node-excerpt")).toBeTruthy();
    expect(container.querySelector(".project-edge-handle")?.classList.contains("contextual-hidden")).toBe(false);

    const zoomOut = container.querySelector<HTMLButtonElement>(".react-flow__controls-zoomout");
    expect(zoomOut).toBeTruthy();
    for (let index = 0; index < 12; index += 1) fireEvent.click(zoomOut!);
    await waitFor(() => expect(canvas.dataset.projectMapDetail).toBe("full"));
    expect(container.querySelector(".project-node-excerpt")).toBeTruthy();
    expect(container.querySelector(".project-edge-handle")?.classList.contains("contextual-hidden")).toBe(false);
  }, 10_000);

  it("preserves untouched node renders when parent callback identities change during selection", async () => {
    const excerptReads = Array.from({ length: 50 }, () => 0);
    const nodes = trackedDescriptors(50, excerptReads);
    const onSelect = vi.fn((_itemId: string | null) => undefined);
    const onGeometryCommit = vi.fn();

    function Harness() {
      const [selection, setSelection] = useState<{
        itemIds: string[];
        primaryItemId: string | null;
      }>({ itemIds: [], primaryItemId: null });
      return <ProjectMapSurface
        nodes={nodes}
        selectedItemId={selection.primaryItemId}
        selectedItemIds={selection.itemIds}
        onSelect={onSelect}
        onSelectionChange={(next) => {
          setSelection({
            itemIds: [...next.itemIds],
            primaryItemId: next.primaryItemId,
          });
        }}
        onGeometryCommit={onGeometryCommit}
        onMarkdownSave={() => undefined}
        onMarkdownCancel={() => undefined}
      />;
    }

    const { container } = render(<div style={{ width: 1200, height: 800 }}><Harness /></div>);
    await waitFor(() => expect(
      container.querySelectorAll(".react-flow__node-projectItem"),
    ).toHaveLength(50));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    excerptReads.fill(0);

    const selectedNode = container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="item-0"]',
    );
    expect(selectedNode).toBeTruthy();
    fireEvent.click(selectedNode!);
    await waitFor(() => expect(selectedNode!.classList.contains("selected")).toBe(true));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(excerptReads[0]).toBeGreaterThan(0);
    expect(excerptReads.slice(1).every((count) => count === 0)).toBe(true);
  }, 20_000);

  it("synchronizes target detail with a full-threshold initial fitView", async () => {
    const { container } = render(<div style={{ width: 1200, height: 800 }}>
      <ProjectMapSurface
        nodes={fitViewFullDescriptors(200)}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);
    const canvas = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>("[data-testid=project-flow-canvas]");
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    expect(canvas.dataset.projectMapScale).toBe("target");
    await waitFor(() => expect(canvas.dataset.projectMapDetail).toBe("full"));
    expect(container.querySelector(".project-node-excerpt")).toBeTruthy();
    expect(container.querySelector(".project-edge-handle")?.classList.contains("contextual-hidden")).toBe(false);
  }, 20_000);

  it("mounts the 250-node and 400-edge target with visible-element rendering", async () => {
    const { container } = render(<div style={{ width: 1200, height: 800 }}>
      <ProjectMapSurface
        nodes={descriptors(250)}
        edges={edges(250, 400)}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);
    const canvas = await waitFor(() => container.querySelector<HTMLElement>("[data-testid=project-flow-canvas]"));
    expect(canvas?.dataset.projectMapScale).toBe("target");
    expect(canvas?.dataset.projectMapCulling).toBe("visible-elements");
    expect(canvas?.dataset.projectMapNodeCount).toBe("250");
    expect(canvas?.dataset.projectMapEdgeCount).toBe("400");
    expect(container.querySelector(".project-node-excerpt")).toBeNull();

    const zoomIn = container.querySelector<HTMLButtonElement>(".react-flow__controls-zoomin");
    const zoomOut = container.querySelector<HTMLButtonElement>(".react-flow__controls-zoomout");
    expect(zoomIn).toBeTruthy();
    expect(zoomOut).toBeTruthy();
    for (let index = 0; index < 12; index += 1) fireEvent.click(zoomIn!);
    await waitFor(() => expect(canvas?.dataset.projectMapDetail).toBe("full"));
    for (let index = 0; index < 12; index += 1) fireEvent.click(zoomOut!);
    await waitFor(() => expect(canvas?.dataset.projectMapDetail).toBe("overview"));
  }, 20_000);

  it("mounts the 500-node and 800-edge envelope without eager rich previews", async () => {
    const { container } = render(<div style={{ width: 1200, height: 800 }}>
      <ProjectMapSurface
        nodes={descriptors(500)}
        edges={edges(500, 800)}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);
    const canvas = await waitFor(() => container.querySelector<HTMLElement>("[data-testid=project-flow-canvas]"));
    expect(canvas?.dataset.projectMapScale).toBe("envelope");
    expect(canvas?.dataset.projectMapCulling).toBe("visible-elements");
    expect(canvas?.dataset.projectMapDetail).not.toBe("full");
    expect(container.querySelector("img.project-node-image")).toBeNull();
  }, 20_000);
});
