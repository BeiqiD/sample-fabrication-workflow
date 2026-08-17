// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectMapSurface } from "./components/project/ProjectMapSurface";
import type { ProjectItemSelection } from "./lib/project-canvas-productivity";
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

describe("real Project Map surface keyboard behavior", () => {
  beforeEach(() => {
    installReactFlowDomMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps Shift-click multi-selection controlled by the parent selection model", async () => {
    const onSelectionChange = vi.fn();
    const descriptors = projectMapNodes(projectTestSnapshot());
    function Harness() {
      const [selection, setSelection] = useState({
        itemIds: ["item-note"],
        primaryItemId: "item-note" as string | null,
      });
      return <ProjectMapSurface
        nodes={descriptors}
        selectedItemId={selection.primaryItemId}
        selectedItemIds={selection.itemIds}
        onSelect={() => undefined}
        onSelectionChange={(next) => {
          onSelectionChange(next);
          setSelection(next);
        }}
        onGeometryCommit={() => undefined}
      />;
    }

    const { container } = render(<div style={{ width: 800, height: 600 }}><Harness /></div>);
    const referenceNode = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-reference"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    fireEvent.keyDown(document, { key: "Shift", code: "ShiftLeft" });
    fireEvent.click(referenceNode, { shiftKey: true });
    fireEvent.keyUp(document, { key: "Shift", code: "ShiftLeft" });

    await waitFor(() => expect(onSelectionChange).toHaveBeenCalled());
    expect(onSelectionChange.mock.calls.at(-1)?.[0]).toEqual({
      itemIds: ["item-note", "item-reference"],
      primaryItemId: "item-reference",
    });
    await waitFor(() => {
      expect(container.querySelector('.react-flow__node[data-id="item-note"]')?.classList.contains("selected")).toBe(true);
      expect(referenceNode.classList.contains("selected")).toBe(true);
    });
  });

  it("restores authoritative draft selection when the parent rejects a Shift-click", async () => {
    const onSelectionChange = vi.fn((_selection: ProjectItemSelection) => false);
    const descriptors = projectMapNodes(projectTestSnapshot());
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={descriptors}
        markdownEditor={{
          itemId: "draft-markdown",
          value: "Draft",
          isNew: true,
          geometry: { x: 120, y: 160, width: 360, height: 220, zIndex: 2 },
          status: "editing",
          message: null,
        }}
        selectedItemId="draft-markdown"
        selectedItemIds={["draft-markdown"]}
        geometryInteractionDisabled
        onSelect={() => false}
        onSelectionChange={onSelectionChange}
        onGeometryCommit={() => undefined}
      />
    </div>);

    const draftNode = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>('.react-flow__node[data-id="draft-markdown"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    const referenceNode = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-reference"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    expect(draftNode.classList.contains("selected")).toBe(true);
    expect(draftNode.classList.contains("selectable")).toBe(false);

    fireEvent.keyDown(document, { key: "Shift", code: "ShiftLeft" });
    fireEvent.click(referenceNode, { shiftKey: true });
    fireEvent.keyUp(document, { key: "Shift", code: "ShiftLeft" });

    await waitFor(() => expect(onSelectionChange).toHaveBeenCalled());
    expect(onSelectionChange.mock.calls.at(-1)?.[0]).toEqual({
      itemIds: ["item-reference"],
      primaryItemId: "item-reference",
    });
    await waitFor(() => {
      expect(draftNode.classList.contains("selected")).toBe(true);
      expect(referenceNode.classList.contains("selected")).toBe(false);
    });
  });

  it("commits one grouped geometry history payload when arrow keys move multiple selected nodes", async () => {
    const onGeometryBatchCommit = vi.fn();
    const descriptors = projectMapNodes(projectTestSnapshot());
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={descriptors}
        selectedItemId="item-note"
        selectedItemIds={["item-reference", "item-note"]}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
        onGeometryBatchCommit={onGeometryBatchCommit}
      />
    </div>);

    const node = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    node.focus();
    fireEvent.keyDown(node, { key: "ArrowRight", code: "ArrowRight" });

    await waitFor(() => expect(onGeometryBatchCommit).toHaveBeenCalledTimes(1));
    const commands = onGeometryBatchCommit.mock.calls[0][0];
    expect(commands.map((command: { placementId: string }) => command.placementId).sort()).toEqual([
      "placement-note",
      "placement-reference",
    ]);
    for (const command of commands) {
      expect(command.after.x).toBeGreaterThan(command.before.x);
      expect(command.after.y).toBe(command.before.y);
    }
  });

  it("commits a geometry command when React Flow moves a selected node with an arrow key", async () => {
    const onGeometryCommit = vi.fn();
    const descriptors = projectMapNodes(projectTestSnapshot());
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={descriptors}
        selectedItemId="item-note"
        onSelect={() => undefined}
        onGeometryCommit={onGeometryCommit}
      />
    </div>);

    const node = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    node.focus();
    fireEvent.keyDown(node, { key: "ArrowRight", code: "ArrowRight" });

    await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
    const command = onGeometryCommit.mock.calls[0][0];
    expect(command.placementId).toBe("placement-note");
    expect(command.before).toMatchObject({ x: 20, y: 40, width: 250, height: 180, zIndex: 0 });
    expect(command.after.x).toBeGreaterThan(command.before.x);
    expect(command.after.y).toBe(command.before.y);
    expect(command.after.width).toBe(command.before.width);
    expect(command.after.height).toBe(command.before.height);
  });
  it("falls back to the attachment file card when a previewable image cannot decode", async () => {
    const snapshot = projectTestSnapshot();
    const actor = "user@example.com";
    const createdAt = "2026-08-11T08:00:00.000Z";
    snapshot.contents.push({
      id: "content-image",
      projectId: "project-a",
      contentType: "attachment",
      markdownSource: null,
      attachmentCaption: "Broken preview",
      attachmentSourceUrl: null,
      formatVersion: 1,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    });
    snapshot.attachments.push({
      projectContentId: "content-image",
      originalName: "broken.png",
      mimeType: "image/png",
      byteSize: 12,
      createdBy: actor,
      createdAt,
      fileUrl: "/api/projects/project-a/contents/content-image/file",
    });
    snapshot.items.push({
      id: "item-image",
      projectId: "project-a",
      itemType: "content",
      projectContentId: "content-image",
      referenceTargetId: null,
      createdSequence: 3,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    });
    snapshot.placements.push({
      id: "placement-image",
      projectItemId: "item-image",
      x: 600,
      y: 40,
      width: 360,
      height: 300,
      zIndex: 2,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
    });

    const { container } = render(<div style={{ width: 1000, height: 700 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);

    const image = await waitFor(() => {
      const candidate = container.querySelector<HTMLImageElement>("img.project-node-image");
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    fireEvent.error(image);
    await waitFor(() => expect(container.querySelector("img.project-node-image")).toBeNull());
    const fallback = container.querySelector<HTMLAnchorElement>(
      'a.project-node-open-reference[href="/api/projects/project-a/contents/content-image/file"]',
    );
    expect(fallback?.textContent).toContain("Open attachment");
  });


  it("reserves empty-pane double click for Markdown creation instead of viewport zoom", async () => {
    const onMarkdownCreateRequest = vi.fn();
    const descriptors = projectMapNodes(projectTestSnapshot());
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={descriptors}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
        onMarkdownCreateRequest={onMarkdownCreateRequest}
      />
    </div>);

    const pane = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>(".react-flow__pane");
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
    expect(viewport).toBeTruthy();
    const beforeTransform = viewport!.style.transform;

    fireEvent.doubleClick(pane, { clientX: 400, clientY: 300 });

    await waitFor(() => expect(onMarkdownCreateRequest).toHaveBeenCalledTimes(1));
    const point = onMarkdownCreateRequest.mock.calls[0][0];
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(viewport!.style.transform).toBe(beforeTransform);
  });

});
