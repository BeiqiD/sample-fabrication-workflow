// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PROJECT_MAP_Z_INDEX_ABS } from "../shared/project-types";
import { ProjectMapSurface } from "./components/project/ProjectMapSurface";
import { projectMapNodes } from "./lib/project-map-model";
import type { ProjectMapMarkdownEditorState } from "./lib/project-owned-content";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

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

function overlappingSnapshot() {
  const snapshot = projectTestSnapshot();
  Object.assign(snapshot.placements.find((placement) => placement.projectItemId === "item-note")!, {
    x: 20, y: 40, width: 360, height: 340, zIndex: 1,
  });
  Object.assign(snapshot.placements.find((placement) => placement.projectItemId === "item-reference")!, {
    x: 100, y: 220, width: 300, height: 200, zIndex: 3,
  });
  return snapshot;
}

async function flowCard(container: HTMLElement, itemId: string) {
  return waitFor(() => {
    const card = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${itemId}"]`)!;
    expect(card).toBeTruthy();
    expect(card.style.visibility).not.toBe("hidden");
    return card;
  });
}

describe("Project Map editor stacking", () => {
  let originalWidth: PropertyDescriptor | undefined;
  let originalHeight: PropertyDescriptor | undefined;
  let originalBBox: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("DOMMatrixReadOnly", class {
      m22: number;
      constructor(transform = "") { this.m22 = Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1); }
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true, media: "(min-width: 860px)", onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: { configurable: true, get() {
        return this.classList.contains("react-flow__handle") ? 10
          : /^\d+(?:\.\d+)?px$/.test(this.style.width) ? Number.parseFloat(this.style.width) : 800;
      } },
      offsetHeight: { configurable: true, get() {
        return this.classList.contains("react-flow__handle") ? 10
          : /^\d+(?:\.\d+)?px$/.test(this.style.height) ? Number.parseFloat(this.style.height) : 600;
      } },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { x: 0, y: 0, left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight,
        width: this.offsetWidth, height: this.offsetHeight, toJSON: () => ({}) } as DOMRect;
    });
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
      [SVGElement.prototype, "getBBox", originalBBox],
    ] as const) {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    }
  });

  it.each(["cancel", "save"] as const)("raises the actual editor until %s without persisting its visual layer", async (action) => {
    const snapshot = overlappingSnapshot();
    let completeMarkdownSave: (() => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (path, init) => {
      const response = (value: unknown) => new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
      if (String(path) === "/api/projects/project-a") return response(snapshot);
      if (String(path).endsWith("/contents/content-note/markdown")) {
        await new Promise<void>((resolve) => { completeMarkdownSave = resolve; });
        return response({ value: { ...snapshot.contents[0],
          markdownSource: JSON.parse(String(init?.body)).markdownSource, revision: 2 }, replayed: false });
      }
      if (String(path).endsWith("/placements/placement-note")) {
        return response({ value: { ...snapshot.placements.find((placement) => placement.id === "placement-note"),
          ...JSON.parse(String(init?.body)).geometry, revision: 2 }, replayed: false });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
      initialEntries: ["/projects/project-a"],
    });
    const { container } = render(<RouterProvider router={router} />);
    const note = await flowCard(container, "item-note");
    const reference = await flowCard(container, "item-reference");
    expect(note.style.zIndex).toBe("1");
    expect(reference.style.zIndex).toBe("3");
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.doubleClick(note.querySelector("header")!);
    const textbox = await screen.findByRole("textbox", { name: "Edit Project Markdown" });
    // These are the actual ReactFlow node wrappers, the sibling stacking contexts in the browser.
    expect(Number(getComputedStyle(note).zIndex)).toBeGreaterThan(Number(getComputedStyle(reference).zIndex));
    expect(reference.style.zIndex).toBe("3");
    expect(note.classList.contains("draggable")).toBe(false);
    fireEvent.change(textbox, { target: { value: "# Accessible overlapping editor" } });
    fireEvent.click(within(note).getByRole("button", { name: "Expand editor" }));
    const expanded = screen.getByRole("dialog", { name: "Expanded Markdown editor" });
    expect(note.contains(expanded)).toBe(false);
    fireEvent.click(within(expanded).getByRole("button", { name: "Collapse editor" }));
    expect(Number(note.style.zIndex)).toBeGreaterThan(Number(reference.style.zIndex));
    fireEvent.click(within(note).getByRole("button", { name: action === "save" ? "Save Markdown" : "Cancel" }));
    if (action === "save") {
      await waitFor(() => expect(completeMarkdownSave).toBeTypeOf("function"));
      expect(Number(note.style.zIndex)).toBeGreaterThan(Number(reference.style.zIndex));
      expect(within(note).queryByRole("button", { name: "Cancel" })).toBeNull();
      await act(async () => { completeMarkdownSave!(); });
    }
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit Project Markdown" })).toBeNull());
    expect(note.style.zIndex).toBe("1");
    expect(reference.style.zIndex).toBe("3");
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(action === "save" ? 1 : 0);
    if (action === "save") {
      expect(String(writes[0][0])).toBe("/api/projects/project-a/contents/content-note/markdown");
      expect(JSON.parse(String(writes[0][1]?.body))).not.toHaveProperty("geometry");
    }
    // The next real geometry mutation must still use the user's saved layer, not the editor layer.
    fireEvent.keyDown(note, { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Unsaved"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => String(path).includes("/placements/"))).toHaveLength(1));
    const [, request] = fetchMock.mock.calls.find(([path]) => String(path).includes("/placements/"))!;
    expect(JSON.parse(String(request?.body)).geometry).toEqual({ x: 25, y: 40, width: 360, height: 340, zIndex: 1 });
  });

  it.each([false, true])("keeps an editor above pending cards without changing their layers (new draft: %s)", async (isNew) => {
    const nodes = projectMapNodes(overlappingSnapshot());
    const geometry = { x: 20, y: 40, width: 360, height: 340, zIndex: -2 };
    const editor: ProjectMapMarkdownEditorState = {
      itemId: isNew ? "draft-note" : "item-note", value: "# Draft", isNew,
      geometry: isNew ? geometry : null, status: "editing", message: null,
    };
    const onGeometryCommit = vi.fn();
    const onGeometryBatchCommit = vi.fn();
    const pendingReference = {
      localId: "pending-reference", target: { type: "sample" as const, id: "sample-b" },
      preview: { title: "Pending sample", subtitle: null, excerpt: null, referenceUrl: "/references/sample/b", openSourceUrl: null },
      geometry: { ...geometry, zIndex: MAX_PROJECT_MAP_Z_INDEX_ABS - 1 }, status: "placing" as const, message: null,
    };
    const pendingAttachment = {
      localId: "pending-attachment", filename: "result.pdf", mimeType: "application/pdf",
      geometry: { ...geometry, zIndex: MAX_PROJECT_MAP_Z_INDEX_ABS }, status: "uploading" as const, message: null,
    };
    const originalNodes = structuredClone(nodes);
    const surface = (activeEditor: ProjectMapMarkdownEditorState | null) => <div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface nodes={nodes} selectedItemId={editor.itemId}
        markdownEditor={activeEditor} pendingReference={pendingReference} pendingAttachment={pendingAttachment}
        geometryInteractionDisabled onSelect={() => undefined}
        onGeometryCommit={onGeometryCommit} onGeometryBatchCommit={onGeometryBatchCommit} />
    </div>;
    const { container, rerender } = render(surface(editor));
    const note = await flowCard(container, editor.itemId);
    const pendingReferenceCard = await flowCard(container, pendingReference.localId);
    const pendingAttachmentCard = await flowCard(container, pendingAttachment.localId);
    expect(Number(note.style.zIndex)).toBeGreaterThan(Number(pendingReferenceCard.style.zIndex));
    expect(Number(note.style.zIndex)).toBeGreaterThan(Number(pendingAttachmentCard.style.zIndex));
    expect(pendingReferenceCard.style.zIndex).toBe(String(pendingReference.geometry.zIndex));
    expect(pendingAttachmentCard.style.zIndex).toBe(String(pendingAttachment.geometry.zIndex));
    expect(note.classList.contains("draggable")).toBe(false);
    expect(nodes).toEqual(originalNodes);
    expect(editor.geometry).toEqual(isNew ? geometry : null);
    rerender(surface(null));
    if (isNew) expect(container.querySelector('.react-flow__node[data-id="draft-note"]')).toBeNull();
    else expect(note.style.zIndex).toBe("1");
    expect(onGeometryCommit).not.toHaveBeenCalled();
    expect(onGeometryBatchCommit).not.toHaveBeenCalled();
  });
});
