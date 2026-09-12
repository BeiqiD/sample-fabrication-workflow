// @vitest-environment jsdom
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectMapSurface, type ProjectMapContextCommands } from "./components/project/ProjectMapSurface";
import type { ProjectItemSelection } from "./lib/project-canvas-productivity";
import { projectMapNodes } from "./lib/project-map-model";
import {
  projectTestSnapshot,
  projectTestSnapshotWithAttachment,
} from "./project-test-fixture";

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

function dispatchCanvasMouse(
  target: EventTarget,
  type: "mousedown" | "mousemove" | "mouseup",
  init: MouseEventInit,
) {
  const view = document.defaultView!;
  const MouseEventConstructor = (view as unknown as typeof globalThis).MouseEvent;
  const event = new MouseEventConstructor(type, { ...init, bubbles: true, cancelable: true });
  Object.defineProperty(event, "view", { value: view });
  act(() => { target.dispatchEvent(event); });
}

function dragCanvasTarget(target: Element) {
  dispatchCanvasMouse(target, "mousedown", { button: 0, buttons: 1, clientX: 100, clientY: 100 });
  dispatchCanvasMouse(window, "mousemove", { buttons: 1, clientX: 110, clientY: 110 });
  dispatchCanvasMouse(window, "mousemove", { buttons: 1, clientX: 180, clientY: 170 });
  dispatchCanvasMouse(window, "mouseup", { button: 0, buttons: 0, clientX: 180, clientY: 170 });
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

async function renderRealProjectPage(fetchMock: typeof fetch) {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query.includes("min-width"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })));
  const { ProjectPage } = await import("./pages/ProjectPage");
  const router = createMemoryRouter([{
    path: "/projects/:projectId", element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<div style={{ width: 1000, height: 700 }}><RouterProvider router={router} /></div>);
}

function dispatchCanvasKey(target: HTMLElement, key: string, modifier?: "ctrlKey" | "metaKey") {
  const event = new KeyboardEvent("keydown", {
    key, ...(modifier ? { [modifier]: true } : {}), bubbles: true, cancelable: true,
  });
  fireEvent(target, event);
  return event;
}

describe("real Project Map surface keyboard behavior", () => {
  beforeEach(() => {
    installReactFlowDomMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders each persisted and pending kind once at the minimum node width", async () => {
    const descriptors = projectMapNodes(projectTestSnapshotWithAttachment());
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={descriptors}
        pendingReference={{
          localId: "pending-reference",
          target: { type: "execution_image", id: "pending-image" },
          preview: {
            title: "Pending reference",
            subtitle: "Execution image",
            excerpt: null,
            referenceUrl: "/references/execution_image/r1_pending-image",
            openSourceUrl: null,
          },
          geometry: { x: 20, y: 260, width: 180, height: 160, zIndex: 3 },
          status: "uncertain",
          message: null,
        }}
        pendingAttachment={{
          localId: "pending-attachment",
          filename: "pending.bin",
          mimeType: "application/octet-stream",
          geometry: { x: 220, y: 260, width: 180, height: 160, zIndex: 4 },
          status: "uncertain",
          message: null,
        }}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);

    const nodeFor = async (itemId: string) => waitFor(() => {
      const node = container.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${itemId}"] .project-map-node`,
      );
      expect(node).toBeTruthy();
      return node!;
    });
    const labelFor = async (itemId: string) => (
      await nodeFor(itemId)
    ).querySelector<HTMLElement>("header span")?.textContent;

    expect(await labelFor("item-note")).toBe("Project Markdown");
    expect(await labelFor("item-reference")).toBe("Reference");
    expect(await labelFor("item-attachment")).toBe("Project attachment");
    expect(await labelFor("pending-reference")).toBe("Reference");
    expect(await labelFor("pending-attachment")).toBe("Project attachment");

    const markdownNode = await nodeFor("item-note");
    for (const itemId of ["item-note", "item-reference", "item-attachment"]) {
      expect((await nodeFor(itemId)).querySelector("header small")).toBeNull();
    }
    expect(within(markdownNode).getAllByText("Project Markdown", { exact: true })).toHaveLength(1);
    expect(markdownNode.querySelector(".project-node-subtitle")).toBeNull();
    expect(markdownNode.closest(".react-flow__node")?.getAttribute("aria-label"))
      .toBe("Project Markdown: Design note");

    for (const itemId of ["item-attachment", "pending-reference", "pending-attachment"]) {
      const minimumWidthNode = await nodeFor(itemId);
      expect(minimumWidthNode.closest<HTMLElement>(".react-flow__node")?.style.width)
        .toBe("180px");
    }
    for (const itemId of ["pending-reference", "pending-attachment"]) {
      expect((await nodeFor(itemId)).querySelector("header small")?.textContent)
        .toBe("Outcome uncertain");
    }
  });


  it("renders complete Markdown math in a scrollable card without moving the node on reading keys", async () => {
    const snapshot = projectTestSnapshot();
    snapshot.contents[0].markdownSource = String.raw`# Research note

` + "A long observation. ".repeat(30) + String.raw`

\[
\begin{pmatrix} a & b \\ c & d \end{pmatrix}
\]

The ratio is $\frac{1}{1+x_0^2}$.

[Source](https://example.com/research)`;
    const onGeometryCommit = vi.fn();
    const onMarkdownEditRequest = vi.fn();
    const inspectItem = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)}
        selectedItemId="item-note"
        onSelect={() => undefined}
        onGeometryCommit={onGeometryCommit}
        onMarkdownEditRequest={onMarkdownEditRequest}
        contextCommands={{ ...availableContextCommands(), inspectItem }}
      />
    </div>);
    const note = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(candidate).toBeTruthy();
      expect(candidate!.querySelector("mtable")).not.toBeNull();
      return candidate!;
    });
    expect(note.querySelector("mfrac")).not.toBeNull();
    expect(within(note).getAllByRole("heading", { name: "Research note" })).toHaveLength(1);
    expect(note.querySelector(".project-node-excerpt")).toBeNull();
    const body = within(note).getByRole("region", { name: "Markdown content" });
    body.focus();
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(body, { key: "ArrowRight" });
    fireEvent.keyDown(body, { key: "PageDown" });
    expect(onGeometryCommit).not.toHaveBeenCalled();
    const link = within(body).getByRole("link", { name: "Source" });
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.doubleClick(link);
    expect(inspectItem).not.toHaveBeenCalled();
    expect(onMarkdownEditRequest).not.toHaveBeenCalled();
    for (const target of [body, within(body).getByRole("heading", { name: "Research note" }), note.querySelector("mfrac")!, note.querySelector("header")!]) {
      inspectItem.mockClear();
      fireEvent.doubleClick(target);
      expect(inspectItem).toHaveBeenCalledExactlyOnceWith("item-note");
      expect(onMarkdownEditRequest).not.toHaveBeenCalled();
    }
  });

  it.each([
    { label: "blank Markdown card area", itemId: "item-note", selector: ".project-map-node", placementId: "placement-note" },
    { label: "rendered Markdown paragraph", itemId: "item-note", selector: ".project-node-markdown p", placementId: "placement-note" },
    { label: "reference excerpt", itemId: "item-reference", selector: ".project-node-excerpt", placementId: "placement-reference" },
    { label: "attachment image", itemId: "item-attachment", selector: ".project-node-image", placementId: "placement-attachment" },
  ])("moves a card from its $label and commits one geometry command", async ({ itemId, selector, placementId }) => {
    const snapshot = projectTestSnapshotWithAttachment();
    snapshot.attachments[0].mimeType = "image/png";
    const onGeometryCommit = vi.fn();
    const onMarkdownEditRequest = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={onGeometryCommit}
        onMarkdownEditRequest={onMarkdownEditRequest}
      />
    </div>);
    const target = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${itemId}"] ${selector}`);
      expect(element).toBeTruthy();
      return element!;
    });
    if (target instanceof HTMLImageElement) expect(target.draggable).toBe(false);
    dragCanvasTarget(target);
    await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
    const command = onGeometryCommit.mock.calls[0][0];
    expect(command.placementId).toBe(placementId);
    expect(command.after.x).not.toBe(command.before.x);
    expect(command.after.y).not.toBe(command.before.y);
    expect(command.after.width).toBe(command.before.width);
    expect(command.after.height).toBe(command.before.height);
    expect(onMarkdownEditRequest).not.toHaveBeenCalled();
  });

  it("renders a reference's complete math excerpt while keeping formula gestures and nested links distinct", async () => {
    const snapshot = projectTestSnapshot();
    const source = snapshot.references[0].resolution.source!;
    source.excerptFormat = "markdown";
    source.excerpt = String.raw`First paragraph of the measurement.

\[
\frac{\int_0^L \alpha(x)\,dx}{1+\beta^2}
\]

The complete explanation follows the equation.

[**Calibration source**](https://example.com/calibration)`;
    const onGeometryCommit = vi.fn();
    const inspectItem = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={onGeometryCommit}
        contextCommands={{ ...availableContextCommands(), inspectItem }}
      />
    </div>);
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-reference"] .project-map-node');
      expect(element?.querySelector("math mfrac")).toBeTruthy();
      return element!;
    });
    expect(within(card).getByText("First paragraph of the measurement.")).toBeTruthy();
    expect(within(card).getByText("The complete explanation follows the equation.")).toBeTruthy();
    const fraction = card.querySelector("math mfrac")!;
    dragCanvasTarget(fraction);
    await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
    const command = onGeometryCommit.mock.calls[0][0];
    expect(command.placementId).toBe("placement-reference");
    expect(command.after.x).not.toBe(command.before.x);
    expect(command.after.y).not.toBe(command.before.y);
    fireEvent.doubleClick(fraction);
    expect(inspectItem).toHaveBeenCalledExactlyOnceWith("item-reference");

    onGeometryCommit.mockClear();
    inspectItem.mockClear();
    const link = within(card).getByRole("link", { name: "Calibration source" });
    const nestedLabel = within(link).getByText("Calibration source");
    dragCanvasTarget(nestedLabel);
    fireEvent.doubleClick(nestedLabel);
    expect(onGeometryCommit).not.toHaveBeenCalled();
    expect(inspectItem).not.toHaveBeenCalled();
    expect(link.getAttribute("href")).toBe("https://example.com/calibration");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("keeps a plain reference excerpt literal rather than interpreting Markdown or HTML", async () => {
    const snapshot = projectTestSnapshot();
    const source = snapshot.references[0].resolution.source!;
    source.excerptFormat = "plain";
    source.excerpt = "Plain $x^2$ with <b>literal brackets</b>.";
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)} selectedItemId={null}
        onSelect={() => undefined} onGeometryCommit={() => undefined}
      />
    </div>);
    const text = await within(container).findByText(source.excerpt);
    expect(text.closest(".project-node-excerpt")).toBeTruthy();
    expect(text.querySelector("math, b")).toBeNull();
  });

  it("selects rendered Markdown with one click without editing or moving it", async () => {
    const onSelect = vi.fn();
    const onGeometryCommit = vi.fn();
    const onMarkdownEditRequest = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(projectTestSnapshot())}
        selectedItemId={null}
        onSelect={onSelect}
        onGeometryCommit={onGeometryCommit}
        onMarkdownEditRequest={onMarkdownEditRequest}
      />
    </div>);
    const body = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"] .project-node-markdown p');
      expect(element).toBeTruthy();
      return element!;
    });
    fireEvent.click(body);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("item-note");
    expect(onGeometryCommit).not.toHaveBeenCalled();
    expect(onMarkdownEditRequest).not.toHaveBeenCalled();
  });

  it("leaves rendered links interactive without dragging or opening the Markdown editor", async () => {
    const snapshot = projectTestSnapshot();
    snapshot.contents[0].markdownSource = "[**Research source**](https://example.com/research)";
    const onGeometryCommit = vi.fn();
    const onMarkdownEditRequest = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={onGeometryCommit}
        onMarkdownEditRequest={onMarkdownEditRequest}
      />
    </div>);
    const link = await within(container).findByRole("link", { name: "Research source" });
    const nestedLabel = within(link).getByText("Research source");
    dragCanvasTarget(nestedLabel);
    fireEvent.doubleClick(nestedLabel);
    expect(onGeometryCommit).not.toHaveBeenCalled();
    expect(onMarkdownEditRequest).not.toHaveBeenCalled();
    expect(link.getAttribute("href")).toBe("https://example.com/research");
  });

  it.each([
    { itemId: "item-note", kind: "Markdown", linkName: null, href: null },
    { itemId: "item-reference", kind: "Reference", linkName: "Open source", href: "/samples/sample-a" },
    { itemId: "item-attachment", kind: "attachment", linkName: "Open attachment", href: "/api/projects/project-a/contents/content-attachment/file" },
  ])("opens $kind Details on card double-click, respecting links and disabled panel commands", async ({ itemId, linkName, href }) => {
    const descriptors = projectMapNodes(projectTestSnapshotWithAttachment());
    const inspectItem = vi.fn();
    const onGeometryCommit = vi.fn();
    const onMarkdownEditRequest = vi.fn();
    const contextCommands = { ...availableContextCommands(), inspectItem };
    const surface = (panelCommandsDisabled: boolean) => <div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={descriptors}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={onGeometryCommit}
        onMarkdownEditRequest={onMarkdownEditRequest}
        contextCommands={{ ...contextCommands, panelCommandsDisabled }}
      />
    </div>;
    const { container, rerender } = render(surface(false));
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${itemId}"] .project-map-node`);
      expect(element).toBeTruthy();
      return element!;
    });
    if (linkName) {
      const link = within(card).getByRole("link", { name: linkName });
      dragCanvasTarget(link);
      fireEvent.doubleClick(link);
      expect(link.getAttribute("href")).toBe(href);
    }
    expect(inspectItem).not.toHaveBeenCalled();
    expect(onGeometryCommit).not.toHaveBeenCalled();
    for (const target of [card, card.querySelector("header")!, card.querySelector("h2, .project-node-markdown p")!]) {
      fireEvent.doubleClick(target);
      expect(inspectItem).toHaveBeenCalledExactlyOnceWith(itemId);
      inspectItem.mockClear();
    }
    expect(onMarkdownEditRequest).not.toHaveBeenCalled();
    rerender(surface(true));
    fireEvent.doubleClick(card);
    fireEvent.doubleClick(card.querySelector("h2, .project-node-markdown p")!);
    expect(inspectItem).not.toHaveBeenCalled();
    expect(onMarkdownEditRequest).not.toHaveBeenCalled();
  });

  it("keeps an open Markdown editor interactive without reopening or moving its card", async () => {
    const onMarkdownEditRequest = vi.fn();
    const onGeometryCommit = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(projectTestSnapshot())}
        selectedItemId="item-note"
        markdownEditor={{
          itemId: "item-note",
          value: "Continue editing this note.",
          isNew: false,
          geometry: { x: 20, y: 40, width: 250, height: 180, zIndex: 0 },
          status: "editing",
          message: null,
        }}
        onSelect={() => undefined}
        onGeometryCommit={onGeometryCommit}
        onMarkdownEditRequest={onMarkdownEditRequest}
      />
    </div>);
    const editor = await within(container).findByRole("textbox", { name: "Edit Project Markdown" });
    const card = editor.closest<HTMLElement>(".project-map-node")!;
    dragCanvasTarget(editor);
    for (const target of [editor, card, card.querySelector("header")!]) fireEvent.doubleClick(target);
    expect(onMarkdownEditRequest).not.toHaveBeenCalled();
    expect(onGeometryCommit).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe("Continue editing this note.");
    expect(editor.isConnected).toBe(true);
  });

  it("copies and removes the selected card from focused Markdown while blocking both commands during unsaved movement", async () => {
    const snapshot = projectTestSnapshot();
    const fetchMock = vi.fn<typeof fetch>(async (path, init) => {
      if (init?.method === "PATCH") {
        expect(String(path)).toBe("/api/projects/project-a/placements/placement-note");
        const input = JSON.parse(String(init.body));
        const placement = snapshot.placements.find((candidate) => candidate.id === "placement-note")!;
        expect(input.expectedRevision).toBe(placement.revision);
        Object.assign(placement, input.geometry, { revision: placement.revision + 1 });
        return new Response(JSON.stringify({ value: placement, replayed: false }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "DELETE") {
        expect(String(path)).toBe("/api/projects/project-a/items/item-note");
        const input = JSON.parse(String(init.body));
        expect(input).toMatchObject({ expectedItemRevision: 1, expectedContentRevision: 1 });
        const item = snapshot.items.find((candidate) => candidate.id === "item-note")!;
        const content = snapshot.contents[0];
        Object.assign(item, { revision: 2, deletedAt: "2026-09-13T10:00:00Z", deletedBy: item.updatedBy, deletionOperationId: input.operationId });
        Object.assign(content, { revision: 2, deletedAt: item.deletedAt, deletedBy: item.deletedBy });
        return new Response(JSON.stringify({
          project: snapshot.project, item, content, attachment: null,
          placement: snapshot.placements.find((placement) => placement.projectItemId === item.id), replayed: false,
        }), { headers: { "content-type": "application/json" } });
      }
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(JSON.stringify(snapshot), { headers: { "content-type": "application/json" } });
    });
    const { container } = await renderRealProjectPage(fetchMock);
    const body = await screen.findByRole("region", { name: "Markdown content" });
    await within(body).findByRole("heading", { name: "Design note" });
    fireEvent.click(body);
    body.focus();
    expect(document.activeElement).toBe(body);
    dragCanvasTarget(within(body).getByText("Preserve the occurrence identity."));
    await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Unsaved"));
    for (const modifier of ["ctrlKey", "metaKey"] as const) {
      expect(dispatchCanvasKey(body, "c", modifier).defaultPrevented).toBe(false);
    }
    expect(dispatchCanvasKey(body, "Delete").defaultPrevented).toBe(false);
    expect(screen.queryByText("1 copied")).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved"));
    body.focus();
    for (const modifier of ["ctrlKey", "metaKey"] as const) {
      expect(dispatchCanvasKey(body, "c", modifier).defaultPrevented).toBe(true);
      expect(await screen.findByText("1 copied")).toBeTruthy();
    }
    expect(dispatchCanvasKey(body, "Delete").defaultPrevented).toBe(true);
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="item-note"]')).toBeNull());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(container.querySelector('.react-flow__node[data-id="item-reference"]')).not.toBeNull();
  });

  it.each(["Inspector", "Reading"] as const)("keeps native %s rich-text shortcuts outside the Canvas command path", async (surface) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(projectTestSnapshot()), {
      headers: { "content-type": "application/json" },
    }));
    await renderRealProjectPage(fetchMock);
    const mapBody = await screen.findByRole("region", { name: "Markdown content" });
    await within(mapBody).findByRole("heading", { name: "Design note" });
    fireEvent.click(mapBody);
    fireEvent.click(screen.getByRole("button", { name: surface }));
    const region = await screen.findByRole("region", {
      name: surface === "Inspector" ? "Inspector Markdown content" : "Project Reading",
    });
    const paragraph = await within(region).findByText("Preserve the occurrence identity.");
    if (surface === "Inspector") region.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    for (const modifier of ["ctrlKey", "metaKey"] as const) {
      for (const key of ["a", "c", "v", "z", "y"]) {
        expect(dispatchCanvasKey(paragraph, key, modifier).defaultPrevented).toBe(false);
      }
    }
    expect(dispatchCanvasKey(paragraph, "Delete").defaultPrevented).toBe(false);
    expect(selection.toString()).toBe("Preserve the occurrence identity.");
    expect(screen.queryByText("1 copied")).toBeNull();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    selection.removeAllRanges();
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
    expect(draftNode.querySelector("header small")?.textContent).toBe("draft");
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

  it("renders and clears transient alignment guides through a real drag lifecycle", async () => {
    const descriptors = projectMapNodes(projectTestSnapshot());
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={descriptors}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);

    const note = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    expect(container.querySelector('[data-testid="project-alignment-guide-horizontal"]')).toBeNull();

    const dispatchMouse = (
      target: EventTarget,
      type: "mousedown" | "mousemove" | "mouseup",
      init: MouseEventInit,
    ) => {
      const view = document.defaultView!;
      const MouseEventConstructor = (
        view as unknown as typeof globalThis
      ).MouseEvent;
      const event = new MouseEventConstructor(type, {
        ...init,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "view", { value: view });
      target.dispatchEvent(event);
    };

    dispatchMouse(note.querySelector("header")!, "mousedown", {
      button: 0,
      buttons: 1,
      clientX: 100,
      clientY: 100,
    });
    dispatchMouse(document.defaultView!, "mousemove", {
      buttons: 1,
      clientX: 102,
      clientY: 102,
    });
    dispatchMouse(document.defaultView!, "mousemove", {
      buttons: 1,
      clientX: 103,
      clientY: 103,
    });

    await waitFor(() => {
      expect(container.querySelector(
        '[data-testid="project-alignment-guide-horizontal"]',
      )).toBeTruthy();
    });

    dispatchMouse(document.defaultView!, "mouseup", {
      button: 0,
      buttons: 0,
      clientX: 103,
      clientY: 103,
    });
    await waitFor(() => {
      expect(container.querySelector(
        '[data-testid="project-alignment-guide-horizontal"]',
      )).toBeNull();
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

    const canvas = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>("[data-testid=project-flow-canvas]");
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    const zoomIn = container.querySelector<HTMLButtonElement>(".react-flow__controls-zoomin");
    expect(zoomIn).toBeTruthy();
    for (let index = 0; index < 8; index += 1) fireEvent.click(zoomIn!);
    await waitFor(() => expect(canvas.dataset.projectMapDetail).toBe("full"));

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
    await waitFor(() => {
      expect(viewport!.style.transform).not.toBe("translate(0px,0px) scale(1)");
    });
    const beforeTransform = viewport!.style.transform;

    fireEvent.doubleClick(pane, { clientX: 400, clientY: 300 });

    await waitFor(() => expect(onMarkdownCreateRequest).toHaveBeenCalledTimes(1));
    const point = onMarkdownCreateRequest.mock.calls[0][0];
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(viewport!.style.transform).toBe(beforeTransform);
  });
  it("presents outcome-uncertain Markdown feedback as warning in the dense Map editor", async () => {
    const snapshot = projectTestSnapshot();
    const { container } = render(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)}
        markdownEditor={{
          itemId: "item-note",
          value: "# Design note",
          isNew: false,
          geometry: null,
          status: "uncertain",
          message: "The response was lost before confirmation.",
        }}
        selectedItemId="item-note"
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
        onMarkdownChange={() => undefined}
        onMarkdownSave={() => undefined}
        onMarkdownCancel={() => undefined}
      />
    </div>);

    const feedback = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>(
        '[data-project-editor-status="uncertain"]',
      );
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    expect(feedback.getAttribute("role")).toBe("status");
    expect(feedback.classList.contains("warning")).toBe(true);
    expect(feedback.classList.contains("danger")).toBe(false);
    expect(feedback.closest(".project-markdown-editor")).not.toBeNull();
  });


});
