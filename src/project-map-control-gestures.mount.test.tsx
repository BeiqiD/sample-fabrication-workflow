// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ProjectMapSurface } from "./components/project/ProjectMapSurface";
import { projectMapNodes } from "./lib/project-map-model";
import type { ProjectMapMarkdownEditorState } from "./lib/project-owned-content";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot, projectTestSnapshotWithAttachment } from "./project-test-fixture";

class TestResizeObserver {
  private callback: ResizeObserverCallback;
  private timers = new Set<number>();
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe(target: Element) {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      this.callback([{
        target, contentRect: target.getBoundingClientRect(),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }, 0);
    this.timers.add(timer);
  }
  unobserve() {}
  disconnect() { for (const timer of this.timers) window.clearTimeout(timer); this.timers.clear(); }
}

function mouse(target: EventTarget, type: "mousedown" | "mousemove" | "mouseup", x: number, y: number) {
  const event = new MouseEvent(type, {
    button: 0, buttons: type === "mouseup" ? 0 : 1, clientX: x, clientY: y,
    bubbles: true, cancelable: true,
  });
  Object.defineProperty(event, "view", { value: document.defaultView });
  act(() => { target.dispatchEvent(event); });
}

function touch(target: EventTarget, type: "touchstart" | "touchmove" | "touchend", x: number, y: number) {
  const point = { identifier: 1, clientX: x, clientY: y, target } as Touch;
  const event = new TouchEvent(type, {
    touches: type === "touchend" ? [] : [point], changedTouches: [point],
    bubbles: true, cancelable: true,
  });
  act(() => { target.dispatchEvent(event); });
}

describe("Project Map native card controls", () => {
  let pointTarget: Element | null;
  let originalWidth: PropertyDescriptor | undefined;
  let originalHeight: PropertyDescriptor | undefined;
  let originalTouchPoints: PropertyDescriptor | undefined;
  let originalPointLookup: PropertyDescriptor | undefined;
  let originalBBox: PropertyDescriptor | undefined;
  beforeEach(() => {
    pointTarget = null;
    originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 2 });
    originalPointLookup = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("DOMMatrixReadOnly", class {
      m22: number;
      constructor(transform = "") { this.m22 = Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1); }
    });
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: { configurable: true, get() {
        return this.classList.contains("react-flow__handle") ? 10
          : /^\d+(?:\.\d+)?px$/.test(this.style.width) ? Math.round(Number.parseFloat(this.style.width)) : 800;
      } },
      offsetHeight: { configurable: true, get() {
        return this.classList.contains("react-flow__handle") ? 10
          : /^\d+(?:\.\d+)?px$/.test(this.style.height) ? Math.round(Number.parseFloat(this.style.height)) : 600;
      } },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { x: 0, y: 0, left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight,
        width: this.offsetWidth, height: this.offsetHeight, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => pointTarget });
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true, value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [target, key, original] of [
      [HTMLElement.prototype, "offsetWidth", originalWidth],
      [HTMLElement.prototype, "offsetHeight", originalHeight],
      [navigator, "maxTouchPoints", originalTouchPoints],
      [document, "elementFromPoint", originalPointLookup],
      [SVGElement.prototype, "getBBox", originalBBox],
    ] as const) {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    }
  });

  it.each([
    ["mouse", "none"], ["touch", "none"],
    ["mouse", "another"], ["touch", "another"],
    ["mouse", "secondary"], ["touch", "secondary"],
    ["mouse", "primary"], ["touch", "primary"],
  ] as const)("resizes from the corner with %s when selection is %s, without selecting or moving cards", async (input, selection) => {
    const onGeometryCommit = vi.fn();
    const onGeometryBatchCommit = vi.fn();
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    const nodes = projectMapNodes(projectTestSnapshot());
    const selectedItemId = selection === "none" ? null : selection === "primary" ? "item-note" : "item-reference";
    const selectedItemIds = selection === "secondary" ? ["item-reference", "item-note"] : selectedItemId ? [selectedItemId] : [];
    const surface = (refresh = false) => <div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface nodes={nodes} selectedItemId={selectedItemId} selectedItemIds={selectedItemIds}
        onSelect={onSelect} onSelectionChange={onSelectionChange} onGeometryBatchCommit={onGeometryBatchCommit}
        onGeometryCommit={refresh ? (command) => { onGeometryCommit(command); } : onGeometryCommit} />
    </div>;
    const { container, rerender } = render(surface());
    const card = await waitFor(() => {
      const value = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(value).toBeTruthy();
      expect(value!.style.visibility).not.toBe("hidden");
      return value!;
    });
    const control = within(card).getByRole("button", { name: "Resize card" });
    const otherCard = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-reference"]')!;
    // The initial fit is asynchronous; begin resizing after its viewport update.
    await waitFor(() => expect(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)
      .not.toMatch(/^translate\(0px,\s*0px\)/));
    const otherStyle = otherCard.getAttribute("style");
    const initialSelection = [...container.querySelectorAll(".react-flow__node.selected")].map((node) => node.getAttribute("data-id"));
    if (input === "mouse") {
      mouse(control, "mousedown", 300, 250);
      mouse(window, "mousemove", 310, 260);
      mouse(window, "mousemove", 360, 290);
      mouse(window, "mouseup", 360, 290);
    } else {
      touch(control, "touchstart", 300, 250);
      touch(control, "touchmove", 310, 260);
      expect(card.style.width).toBe("260px");
      // A parent refresh must not replace D3's active touch listeners between moves.
      rerender(surface(true));
      expect(within(card).getByRole("button", { name: "Resize card" })).toBe(control);
      touch(control, "touchmove", 360, 290);
      expect(card.style.width).toBe("310px");
      touch(control, "touchend", 360, 290);
    }
    await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
    expect(onGeometryCommit.mock.calls[0][0]).toMatchObject({
      placementId: "placement-note",
      before: { x: 20, y: 40, width: 250, height: 180, zIndex: 0 },
      after: { x: 20, y: 40, width: 310, height: 220, zIndex: 0 },
    });
    expect(card.style.transform).toBe("translate(20px,40px)");
    expect(otherCard.getAttribute("style")).toBe(otherStyle);
    expect([...container.querySelectorAll(".react-flow__node.selected")].map((node) => node.getAttribute("data-id")))
      .toEqual(initialSelection);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onGeometryBatchCommit).not.toHaveBeenCalled();
  });

  it("shows one corner per saved card and requires explicit permission to resize an editor", async () => {
    const nodes = projectMapNodes(projectTestSnapshotWithAttachment());
    const onGeometryCommit = vi.fn();
    const surface = (selectedItemId: string | null, disabled = false, editor: ProjectMapMarkdownEditorState | null = null) =>
      <div style={{ width: 800, height: 600 }}>
        <ProjectMapSurface nodes={nodes} selectedItemId={selectedItemId}
          selectedItemIds={selectedItemId ? ["item-note", "item-reference"] : []}
          geometryInteractionDisabled={disabled} markdownEditor={editor}
          onSelect={() => undefined} onGeometryCommit={onGeometryCommit} />
      </div>;
    const { container, rerender } = render(surface(null));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Resize card" })).toHaveLength(3));
    const expectSavedCardGrips = () => {
      for (const node of container.querySelectorAll<HTMLElement>(".react-flow__node")) {
        const grip = within(node).getByRole("button", { name: "Resize card" });
        expect(node.querySelectorAll(".react-flow__resize-control")).toHaveLength(1);
        expect(grip.closest(".react-flow__resize-control.bottom.right.handle")).toBeTruthy();
      }
      expect(container.querySelector(".react-flow__resize-control.line")).toBeNull();
    };
    expectSavedCardGrips();
    rerender(surface("item-note"));
    expectSavedCardGrips();
    rerender(surface("item-reference"));
    expectSavedCardGrips();
    rerender(surface(null));
    expectSavedCardGrips();
    rerender(surface("item-note", true));
    expect(screen.queryByRole("button", { name: "Resize card" })).toBeNull();
    // Editor resize requires explicit scoped permission even without a global geometry lock.
    rerender(surface("item-note", false, {
      itemId: "item-note", value: "# Draft", isNew: false,
      geometry: null, status: "editing", message: null,
    }));
    const editingCard = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    expect(within(editingCard).queryByRole("button", { name: "Resize card" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Resize card" })).toHaveLength(2);
    rerender(surface("item-note"));
    expectSavedCardGrips();
    expect(onGeometryCommit).not.toHaveBeenCalled();
  });

  it("never implicitly offers resizing for pending references, attachments, or new Markdown drafts", async () => {
    const nodes = projectMapNodes(projectTestSnapshot());
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface nodes={nodes} selectedItemId={null}
        onSelect={() => undefined} onGeometryCommit={vi.fn()}
        pendingReference={{
          localId: "pending-reference", target: { type: "sample", id: "sample-b" },
          preview: { title: "Pending sample", subtitle: null, excerpt: null,
            referenceUrl: "/references/sample/r1_sample-b", openSourceUrl: null },
          geometry: { x: 0, y: 250, width: 300, height: 180, zIndex: 2 }, status: "placing", message: null,
        }}
        pendingAttachment={{ localId: "pending-attachment", filename: "Pending.pdf", mimeType: "application/pdf",
          geometry: { x: 350, y: 250, width: 300, height: 180, zIndex: 3 }, status: "uploading", message: null }}
        markdownEditor={{ itemId: "new-note", value: "# Draft", isNew: true,
          geometry: { x: 0, y: 500, width: 300, height: 180, zIndex: 4 }, status: "editing", message: null }} />
    </div>);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node")).toHaveLength(5));
    for (const id of ["pending-reference", "pending-attachment", "new-note"]) {
      const card = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
      expect(within(card).queryByRole("button", { name: "Resize card" })).toBeNull();
    }
    expect(screen.getAllByRole("button", { name: "Resize card" })).toHaveLength(2);
  });

  it.each([
    ["ArrowRight", false, 255, 180], ["ArrowLeft", false, 245, 180],
    ["ArrowDown", false, 250, 185], ["ArrowUp", false, 250, 175],
    ["ArrowRight", true, 270, 180], ["ArrowLeft", true, 230, 180],
    ["ArrowDown", true, 250, 200], ["ArrowUp", true, 250, 160],
  ] as const)("resizes an unselected card with %s (Shift: %s) without changing selection or bubbling the key", async (key, shiftKey, width, height) => {
    const onGeometryCommit = vi.fn();
    const onOuterKeyDown = vi.fn();
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }} onKeyDown={onOuterKeyDown}>
      <ProjectMapSurface nodes={projectMapNodes(projectTestSnapshot())}
        selectedItemId="item-reference" onSelect={onSelect} onSelectionChange={onSelectionChange}
        onGeometryCommit={onGeometryCommit} />
    </div>);
    const grip = await waitFor(() => {
      const note = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
      expect(note).toBeTruthy();
      return within(note).getByRole("button", { name: "Resize card" });
    });
    const card = grip.closest<HTMLElement>(".react-flow__node")!;
    await waitFor(() => expect(card.style.visibility).not.toBe("hidden"));
    const initialTransform = card.style.transform;
    act(() => { grip.focus(); });
    fireEvent.keyDown(grip, { key, code: key, shiftKey });
    await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
    expect(onGeometryCommit.mock.calls[0][0]).toEqual({
      placementId: "placement-note",
      before: { x: 20, y: 40, width: 250, height: 180, zIndex: 0 },
      after: { x: 20, y: 40, width, height, zIndex: 0 },
    });
    expect(onOuterKeyDown).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(card.classList.contains("selected")).toBe(false);
    expect(container.querySelector<HTMLElement>('.react-flow__node[data-id="item-reference"]')!.classList.contains("selected")).toBe(true);
    expect(card.style.transform).toBe(initialTransform);
    expect(card.querySelectorAll(".react-flow__resize-control")).toHaveLength(1);
  });

  it.each([
    ["ArrowLeft", 185, 180, 180, 180],
    ["ArrowUp", 250, 115, 250, 110],
    ["ArrowRight", 1_195, 180, 1_200, 180],
    ["ArrowDown", 250, 995, 250, 1_000],
  ] as const)("clamps %s resizing at the card limit without an extra history command", async (key, width, height, nextWidth, nextHeight) => {
    const nodes = projectMapNodes(projectTestSnapshot()).map((node) => node.itemId !== "item-note" ? node : {
      ...node, geometry: { ...node.geometry, width, height },
    });
    const onGeometryCommit = vi.fn();
    const surface = (currentNodes: typeof nodes) => <div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface nodes={currentNodes} selectedItemId="item-note"
        onSelect={() => undefined} onGeometryCommit={onGeometryCommit} />
    </div>;
    const { container, rerender } = render(surface(nodes));
    const grip = await waitFor(() => {
      const note = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
      expect(note).toBeTruthy();
      return within(note).getByRole("button", { name: "Resize card" });
    });
    fireEvent.keyDown(grip, { key, code: key, shiftKey: true });
    await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
    const command = onGeometryCommit.mock.calls[0][0];
    expect(command).toEqual({
      placementId: "placement-note",
      before: { x: 20, y: 40, width, height, zIndex: 0 },
      after: { x: 20, y: 40, width: nextWidth, height: nextHeight, zIndex: 0 },
    });
    rerender(surface(nodes.map((node) => node.itemId !== "item-note" ? node : { ...node, geometry: command.after })));
    fireEvent.keyDown(within(container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!).getByRole("button", { name: "Resize card" }), { key, code: key, shiftKey: true });
    expect(onGeometryCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps grip activation and modifier arrows from selecting, editing, or moving the card", async () => {
    const onGeometryCommit = vi.fn();
    const onSelect = vi.fn();
    const onMarkdownEditRequest = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface nodes={projectMapNodes(projectTestSnapshot())}
        selectedItemId="item-reference" onSelect={onSelect} onGeometryCommit={onGeometryCommit}
        onMarkdownEditRequest={onMarkdownEditRequest} />
    </div>);
    const grip = await waitFor(() => {
      const note = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
      expect(note).toBeTruthy();
      return within(note).getByRole("button", { name: "Resize card" });
    });
    const card = grip.closest<HTMLElement>(".react-flow__node")!;
    await waitFor(() => expect(card.style.visibility).not.toBe("hidden"));
    act(() => { grip.focus(); });
    fireEvent.click(grip);
    fireEvent.doubleClick(grip);
    for (const modifier of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(fireEvent.keyDown(grip, { key: "ArrowRight", code: "ArrowRight", ...modifier })).toBe(true);
    }
    fireEvent.keyDown(grip, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(grip, { key: " ", code: "Space" });
    expect(onGeometryCommit).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onMarkdownEditRequest).not.toHaveBeenCalled();
    expect(card.style.transform).toBe("translate(20px,40px)");
    expect(card.querySelectorAll(".react-flow__resize-control")).toHaveLength(1);
  });

  it("saves resizing an unselected card through the real Page and restores dimensions with Undo and Redo", async () => {
    const snapshot = projectTestSnapshot();
    let placement = snapshot.placements.find((candidate) => candidate.id === "placement-note")!;
    const fetchMock = vi.fn<typeof fetch>(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return new Response(JSON.stringify(snapshot));
      if (String(path) === "/api/projects/project-a/placements/placement-note" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body));
        placement = { ...placement, ...input.geometry, revision: placement.revision + 1 };
        return new Response(JSON.stringify({ value: placement, replayed: false }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true, media: "(min-width: 860px)", onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
      initialEntries: ["/projects/project-a"],
    });
    const { container } = render(<RouterProvider router={router} />);
    const note = await waitFor(() => {
      const card = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(card).toBeTruthy();
      expect(card!.style.visibility).not.toBe("hidden");
      return card!;
    });
    const reference = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-reference"]')!;
    fireEvent.click(reference.querySelector("header")!);
    const referenceStyle = reference.getAttribute("style");
    expect(reference.classList.contains("selected")).toBe(true);
    expect(note.classList.contains("selected")).toBe(false);
    const grip = await within(note).findByRole("button", { name: "Resize card" });
    act(() => { grip.focus(); });
    fireEvent.keyDown(grip, { key: "ArrowRight", code: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(note.style.width).toBe("270px"));
    fireEvent.keyDown(grip, { key: "ArrowDown", code: "ArrowDown" });
    await waitFor(() => expect(note.style.height).toBe("185px"));
    expect(note.style.transform).toBe("translate(20px,40px)");
    expect(reference.getAttribute("style")).toBe(referenceStyle);
    expect(reference.classList.contains("selected")).toBe(true);
    expect(note.classList.contains("selected")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved"));
    const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1]?.body)).geometry).toEqual({ x: 20, y: 40, width: 270, height: 185, zIndex: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(note.style.height).toBe("180px"));
    expect(note.style.width).toBe("270px");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(note.style.width).toBe("250px"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved"));
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1][1]?.body)).geometry).toEqual({ x: 20, y: 40, width: 250, height: 180, zIndex: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(note.style.height).toBe("185px"));
    expect(note.style.width).toBe("270px");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved"));
    expect(writes()).toHaveLength(3);
    expect(JSON.parse(String(writes()[2][1]?.body)).geometry).toEqual({ x: 20, y: 40, width: 270, height: 185, zIndex: 0 });
  });

  it.each([
    ["surface", "Save Markdown", false], ["surface", "Cancel", false],
    ["inspector", "Save Markdown", false], ["inspector", "Cancel", false],
    ["surface", "Cancel", true],
  ] as const)("keeps a dirty %s note during native resize and preserves placement history after %s (fractional: %s)", async (host, finish, fractional) => {
    const snapshot = projectTestSnapshot();
    const beforeWidth = fractional ? 250.5 : 250;
    const beforeHeight = fractional ? 180.25 : 180;
    const afterWidth = Math.round(beforeWidth) + 60;
    const afterHeight = Math.round(beforeHeight) + 40;
    Object.assign(snapshot.placements.find((entry) => entry.id === "placement-note")!, { width: beforeWidth, height: beforeHeight });
    let placement = snapshot.placements.find((entry) => entry.id === "placement-note")!;
    const content = snapshot.contents.find((entry) => entry.id === "content-note")!;
    const fetchMock = vi.fn<typeof fetch>(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return new Response(JSON.stringify(snapshot));
      if (String(path) === "/api/projects/project-a/placements/placement-note" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body));
        placement = { ...placement, ...input.geometry, revision: placement.revision + 1 };
        return new Response(JSON.stringify({ value: placement, replayed: false }));
      }
      if (String(path) === "/api/projects/project-a/contents/content-note/markdown" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ value: { ...content, markdownSource: input.markdownSource, revision: content.revision + 1 }, replayed: false }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], { initialEntries: ["/projects/project-a"] });
    const { container } = render(<RouterProvider router={router} />);
    const note = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(node).toBeTruthy();
      expect(node!.style.visibility).not.toBe("hidden");
      return node!;
    });
    await waitFor(() => expect(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)
      .not.toMatch(/^translate\(0px,\s*0px\)/));
    if (host === "inspector") {
      fireEvent.click(note);
      fireEvent.click(within(await screen.findByRole("toolbar", { name: "Selected card actions" }))
        .getByRole("button", { name: "Details" }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    } else {
      fireEvent.click(note);
      fireEvent.click(within(await screen.findByRole("toolbar", { name: "Selected card actions" })).getByRole("button", { name: "Edit" }));
    }
    const editorLabel = host === "inspector" ? "Inspector Markdown editor" : "Edit Project Markdown";
    const field = await screen.findByRole("textbox", { name: editorLabel });
    fireEvent.change(field, { target: { value: "# Resized draft" } });
    const grip = within(note).getByRole("button", { name: "Resize card" });
    const reference = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-reference"]')!;
    expect(within(reference).queryByRole("button", { name: "Resize card" })).toBeNull();
    mouse(grip, "mousedown", 300, 250);
    mouse(window, "mousemove", 310, 260);
    expect(note.style.width).toBe(`${Math.round(beforeWidth) + 10}px`);
    expect((screen.getByRole("button", { name: "Save Markdown" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(field, { key: "s", code: "KeyS", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: editorLabel })).toBe(field);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    // Typing forces a parent projection update while XYFlow keeps the same active resizer.
    fireEvent.change(field, { target: { value: "# Resized draft, still editing" } });
    expect(within(note).getByRole("button", { name: "Resize card" })).toBe(grip);
    mouse(window, "mousemove", 360, 290);
    expect(note.style.width).toBe(`${afterWidth}px`);
    mouse(window, "mouseup", 360, 290);
    await waitFor(() => expect((screen.getByRole("button", { name: "Save Markdown" }) as HTMLButtonElement).disabled).toBe(false));
    expect((field as HTMLTextAreaElement).value).toBe("# Resized draft, still editing");
    expect(note.style.height).toBe(`${afterHeight}px`);
    expect(note.style.transform).toBe("translate(20px,40px)");
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: finish }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: editorLabel })).toBeNull());
    expect(note.style.width).toBe(`${afterWidth}px`);
    expect(note.style.height).toBe(`${afterHeight}px`);
    expect(note.style.zIndex).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved"));
    const placementWrites = () => fetchMock.mock.calls.filter(([path, init]) => String(path).includes("/placements/") && init?.method === "PATCH");
    expect(JSON.parse(String(placementWrites()[0][1]?.body)).geometry).toEqual({ x: 20, y: 40, width: afterWidth, height: afterHeight, zIndex: 0 });
    const contentWrites = fetchMock.mock.calls.filter(([path, init]) => String(path).includes("/contents/") && init?.method === "PATCH");
    expect(contentWrites).toHaveLength(finish === "Save Markdown" ? 1 : 0);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(note.style.width).toBe(`${beforeWidth}px`));
    expect(note.style.height).toBe(`${beforeHeight}px`);
    expect(note.textContent).toContain(finish === "Save Markdown" ? "Resized draft, still editing" : "Preserve the occurrence identity.");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(note.style.width).toBe(`${afterWidth}px`));
    expect(note.style.height).toBe(`${afterHeight}px`);
  });

  it.each(["Save Markdown", "Cancel"] as const)("keeps new-note resize local until %s without phantom placements or Undo", async (finish) => {
    const snapshot = projectTestSnapshot();
    let created: Record<string, any> | null = null;
    const fetchMock = vi.fn<typeof fetch>(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return new Response(JSON.stringify(snapshot));
      if (String(path) === "/api/projects/project-a/items/markdown" && init?.method === "POST") {
        const input = JSON.parse(String(init.body));
        created = input;
        return new Response(JSON.stringify({
          project: { ...snapshot.project, revision: snapshot.project.revision + 1, nextCreatedSequence: snapshot.project.nextCreatedSequence + 1 },
          item: { ...snapshot.items[0], id: input.itemId, projectContentId: input.contentId, createdSequence: snapshot.project.nextCreatedSequence },
          content: { ...snapshot.contents[0], id: input.contentId, markdownSource: input.markdownSource },
          placement: { ...snapshot.placements[0], id: input.placementId, projectItemId: input.itemId, ...input.geometry },
          attachment: null, replayed: false,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], { initialEntries: ["/projects/project-a"] });
    const { container } = render(<RouterProvider router={router} />);
    await screen.findByRole("button", { name: "Add" });
    // Adding at the center needs XYFlow's initialized viewport. The toolbar
    // renders before the lazy Map has an instance; an earlier click correctly
    // asks the user to retry and does not create a draft to resize.
    await waitFor(() => {
      const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
      expect(viewport).toBeTruthy();
      expect(viewport!.style.transform).not.toMatch(/^translate\(0px,\s*0px\)/);
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Note / Markdown" }));
    const field = await screen.findByRole("textbox", { name: "New Project Markdown" });
    const note = field.closest<HTMLElement>(".react-flow__node")!;
    fireEvent.change(field, { target: { value: "# Local resized draft" } });
    await waitFor(() => expect(note.style.visibility).not.toBe("hidden"));
    const initialTransform = note.style.transform;
    const grip = within(note).getByRole("button", { name: "Resize card" });
    fireEvent.keyDown(grip, { key: "ArrowRight", code: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(note.style.width).toBe("380px"));
    mouse(grip, "mousedown", 300, 250);
    mouse(window, "mousemove", 340, 280);
    mouse(window, "mouseup", 340, 280);
    await waitFor(() => expect(note.style.width).toBe("420px"));
    expect(note.style.height).toBe("250px");
    expect(note.style.transform).toBe(initialTransform);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    expect((field as HTMLTextAreaElement).value).toBe("# Local resized draft");
    fireEvent.click(screen.getByRole("button", { name: finish }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New Project Markdown" })).toBeNull());
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    if (finish === "Save Markdown") {
      expect(created).toMatchObject({ geometry: { width: 420, height: 250 }, markdownSource: "# Local resized draft" });
      expect(container.querySelectorAll(".react-flow__node")).toHaveLength(3);
      expect(note.style.width).toBe("420px");
    } else {
      expect(created).toBeNull();
      expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
    }
    expect(fetchMock.mock.calls.filter(([path]) => String(path).includes("/placements/"))).toHaveLength(0);
  });

  it.each(["saved", "new draft"] as const)("uses precise fractional %s geometry as the resize command's before value", async (kind) => {
    const geometry = { x: 20.25, y: 40.5, width: 250.5, height: 180.25, zIndex: 0 };
    const nodes = projectMapNodes(projectTestSnapshot()).map((node) => node.itemId === "item-note" ? { ...node, geometry } : node);
    const editor: ProjectMapMarkdownEditorState | null = kind === "new draft" ? {
      itemId: "draft-fractional", value: "# Fractional draft", isNew: true, geometry, status: "editing", message: null,
    } : null;
    const commit = vi.fn();
    const { container } = render(<ProjectMapSurface nodes={nodes} markdownEditor={editor}
      markdownResizeItemId={editor?.itemId} geometryInteractionDisabled={Boolean(editor)}
      selectedItemId={null} onSelect={() => undefined} onGeometryCommit={commit} onMarkdownResizeCommit={commit} />);
    const note = await waitFor(() => {
      const card = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${editor?.itemId ?? "item-note"}"]`)!;
      expect(card).toBeTruthy();
      expect(card.style.visibility).not.toBe("hidden");
      return card;
    });
    await waitFor(() => expect(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)
      .not.toMatch(/^translate\(0px,\s*0px\)/));
    // offsetWidth/offsetHeight are integers in a browser even with fractional CSS sizes.
    expect(note.offsetWidth).toBe(251);
    expect(note.offsetHeight).toBe(180);
    const grip = within(note).getByRole("button", { name: "Resize card" });
    mouse(grip, "mousedown", 300, 250);
    mouse(window, "mousemove", 360, 290);
    mouse(window, "mouseup", 360, 290);
    expect(commit).toHaveBeenCalledExactlyOnceWith({
      placementId: editor?.itemId ?? "placement-note",
      before: geometry,
      after: { ...geometry, width: 311, height: 220 },
    });
  });

  it("preserves a clean editor and live touch resize across a placement ACK, then locks an uncertain content save", async () => {
    const snapshot = projectTestSnapshot();
    let placement = snapshot.placements.find((entry) => entry.id === "placement-note")!;
    let acknowledgePlacement: (() => void) | undefined;
    let rejectMarkdown: (() => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return new Response(JSON.stringify(snapshot));
      if (String(path).endsWith("/placements/placement-note") && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body));
        if (!acknowledgePlacement) await new Promise<void>((resolve) => { acknowledgePlacement = resolve; });
        placement = { ...placement, ...input.geometry, revision: placement.revision + 1 };
        return new Response(JSON.stringify({ value: placement, replayed: false }));
      }
      if (String(path).endsWith("/contents/content-note/markdown") && init?.method === "PATCH") {
        await new Promise<void>((resolve) => { rejectMarkdown = resolve; });
        return new Response(JSON.stringify({ error: "Save response was lost" }), { status: 503 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], { initialEntries: ["/projects/project-a"] });
    const { container } = render(<RouterProvider router={router} />);
    const note = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(node).toBeTruthy();
      expect(node!.style.visibility).not.toBe("hidden");
      return node!;
    });
    // Selection and touch resizing start after onInit's queued initial fit.
    await waitFor(() => expect(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)
      .not.toMatch(/^translate\(0px,\s*0px\)/));
    fireEvent.click(note);
    fireEvent.click(within(await screen.findByRole("toolbar", { name: "Selected card actions" })).getByRole("button", { name: "Edit" }));
    const field = await screen.findByRole("textbox", { name: "Edit Project Markdown" });
    const grip = within(note).getByRole("button", { name: "Resize card" });
    // A clean note must stay in its editor when the triangle's padding is touched.
    const control = grip.closest(".project-node-resize-handle")!;
    touch(control, "touchstart", 300, 250);
    touch(control, "touchmove", 320, 260);
    touch(control, "touchend", 320, 260);
    expect(screen.getByRole("textbox", { name: "Edit Project Markdown" })).toBe(field);
    await waitFor(() => expect(note.style.width).toBe("270px"));
    await waitFor(() => expect(acknowledgePlacement).toBeTypeOf("function"), { timeout: 2_500 });
    touch(control, "touchstart", 300, 250);
    touch(control, "touchmove", 310, 260);
    expect(note.style.width).toBe("280px");
    await act(async () => { acknowledgePlacement!(); });
    expect(note.style.width).toBe("280px");
    expect(screen.getByRole("textbox", { name: "Edit Project Markdown" })).toBe(field);
    expect((screen.getByRole("button", { name: "Save Markdown" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "# Draft survives the earlier ACK" } });
    touch(control, "touchmove", 340, 280);
    touch(control, "touchend", 340, 280);
    await waitFor(() => expect(note.style.width).toBe("310px"));
    expect(note.style.height).toBe("220px");
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
    await waitFor(() => expect(rejectMarkdown).toBeTypeOf("function"));
    expect(within(note).queryByRole("button", { name: "Resize card" })).toBeNull();
    await act(async () => { rejectMarkdown!(); });
    await screen.findByRole("button", { name: "Retry exact save" });
    expect(within(note).queryByRole("button", { name: "Resize card" })).toBeNull();
    expect((field as HTMLTextAreaElement).value).toBe("# Draft survives the earlier ACK");
    expect(note.style.width).toBe("310px");
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["blur", "pointercancel", "touchcancel", "unmount", "owner removed"] as const)("releases the editor resize lock after %s without committing an unfinished size", async (interruption) => {
    const onActiveChange = vi.fn();
    const onCommit = vi.fn();
    const nodes = projectMapNodes(projectTestSnapshot());
    const editor: ProjectMapMarkdownEditorState = {
      itemId: "item-note", value: "# Retained draft", isNew: false, geometry: null, status: "editing", message: null,
    };
    const surface = (hasOwner = true) => <ProjectMapSurface
      nodes={hasOwner ? nodes : nodes.filter((node) => node.itemId !== editor.itemId)}
      markdownEditor={hasOwner ? editor : null} markdownResizeItemId={hasOwner ? editor.itemId : null}
      geometryInteractionDisabled selectedItemId="item-note" onSelect={() => undefined}
      onGeometryCommit={onCommit} onMarkdownResizeCommit={onCommit} onMarkdownResizeActiveChange={onActiveChange} />;
    const { container, rerender, unmount } = render(surface());
    const grip = await screen.findByRole("button", { name: "Resize card" });
    const note = grip.closest<HTMLElement>(".react-flow__node")!;
    await waitFor(() => expect(note.style.visibility).not.toBe("hidden"));
    await waitFor(() => expect(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)
      .not.toMatch(/^translate\(0px,\s*0px\)/));
    if (interruption === "touchcancel") {
      touch(grip, "touchstart", 300, 250);
      touch(grip, "touchmove", 320, 280);
    } else {
      mouse(grip, "mousedown", 300, 250);
      mouse(window, "mousemove", 320, 280);
    }
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    expect(note.style.width).toBe("270px");
    if (interruption === "unmount") unmount();
    else if (interruption === "owner removed") rerender(surface(false));
    else if (interruption === "touchcancel") act(() => { grip.dispatchEvent(new TouchEvent("touchcancel", { bubbles: true, touches: [], changedTouches: [] })); });
    else fireEvent(window, new Event(interruption));
    await waitFor(() => expect(onActiveChange).toHaveBeenLastCalledWith(false));
    mouse(window, "mouseup", 320, 280);
    expect(onCommit).not.toHaveBeenCalled();
    if (!["unmount", "owner removed"].includes(interruption)) {
      expect(note.style.width).toBe("250px");
      expect((await screen.findByRole("textbox", { name: "Edit Project Markdown" }) as HTMLTextAreaElement).value).toBe("# Retained draft");
    }
  });

  it.each(["mouse", "touch"] as const)("starts and completes a %s connection without dragging either card", async (input) => {
    const onEdgeConnect = vi.fn();
    const onGeometryCommit = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface nodes={projectMapNodes(projectTestSnapshot())}
        selectedItemId="item-note" onSelect={() => undefined}
        onGeometryCommit={onGeometryCommit} onEdgeConnect={onEdgeConnect} />
    </div>);
    const start = await waitFor(() => {
      const value = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"] .react-flow__handle[data-handleid="right"]');
      expect(value).toBeTruthy();
      expect(value!.closest<HTMLElement>(".react-flow__node")!.style.visibility).not.toBe("hidden");
      return value!;
    });
    const end = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-reference"] .react-flow__handle[data-handleid="left"]')!;
    pointTarget = null;
    if (input === "mouse") {
      mouse(start, "mousedown", 300, 250);
      mouse(document, "mousemove", 360, 280);
    } else {
      touch(start, "touchstart", 300, 250);
      touch(document, "touchmove", 360, 280);
    }
    await waitFor(() => expect(container.querySelector(".react-flow__connection-path")).toBeTruthy());
    pointTarget = end;
    if (input === "mouse") {
      mouse(document, "mousemove", 410, 300);
      mouse(document, "mouseup", 410, 300);
    } else {
      touch(document, "touchmove", 410, 300);
      touch(document, "touchend", 410, 300);
    }
    await waitFor(() => expect(onEdgeConnect).toHaveBeenCalledExactlyOnceWith({
      sourceItemId: "item-note", targetItemId: "item-reference", sourceHandle: "right", targetHandle: "left",
    }));
    expect(onGeometryCommit).not.toHaveBeenCalled();
    expect(container.querySelector(".react-flow__connection-path")).toBeNull();
  });
});
