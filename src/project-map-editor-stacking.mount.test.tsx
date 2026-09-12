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

  it.each(["Save Markdown", "Cancel"] as const)("double-click opens Inspector alongside the focused card editor through %s", async (finish) => {
    const snapshot = overlappingSnapshot();
    const fetchMock = vi.fn<typeof fetch>(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return new Response(JSON.stringify(snapshot));
      if (String(path).endsWith("/contents/content-note/markdown") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ value: { ...snapshot.contents[0],
          markdownSource: JSON.parse(String(init.body)).markdownSource, revision: 2 }, replayed: false }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
      initialEntries: ["/projects/project-a"],
    });
    const { container } = render(<RouterProvider router={router} />);
    const note = await flowCard(container, "item-note");
    fireEvent.click(note);
    expect(screen.queryByRole("textbox", { name: "Edit Project Markdown" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    fireEvent.doubleClick(note, { button: 0 });
    const input = await screen.findByRole("textbox", { name: "Edit Project Markdown" }) as HTMLTextAreaElement;
    expect(input.closest(".react-flow__node")).toBe(note);
    const inspector = screen.getByRole("complementary", { name: "Project Inspector" });
    expect(within(inspector).queryByRole("textbox")).toBeNull();
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(document.activeElement).toBe(input);
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
    expect((within(note).getByRole("button", { name: "Resize card" }) as HTMLButtonElement).disabled).toBe(false);
    const draft = "# 双击编辑\n\nThe existing card owns this draft.";
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.doubleClick(input, { button: 0 });
    expect(screen.getByRole("textbox", { name: "Edit Project Markdown" })).toBe(input);
    expect(input.value).toBe(draft);
    fireEvent.click(within(note).getByRole("button", { name: finish }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit Project Markdown" })).toBeNull());
    expect(screen.getByRole("complementary", { name: "Project Inspector" })).toBeTruthy();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
    expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved");
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method);
    expect(writes).toHaveLength(finish === "Save Markdown" ? 1 : 0);
    if (finish === "Save Markdown") expect(JSON.parse(String(writes[0][1]?.body)).markdownSource).toBe(draft);
  });

  it("keeps a newer card edit focused when an older References focus request completes", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("min-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const snapshot = overlappingSnapshot();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path) => {
      if (String(path) === "/api/projects/project-a") return new Response(JSON.stringify(snapshot));
      if (String(path) === "/api/references/children") return new Response(JSON.stringify({
        parent: snapshot.references[0].resolution, parentEligible: false, children: [], truncated: false,
      }));
      throw new Error(`Unexpected request: ${path}`);
    }));
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
      initialEntries: ["/projects/project-a"],
    });
    const { container } = render(<RouterProvider router={router} />);
    const note = await flowCard(container, "item-note");
    fireEvent.click(note);
    let previousReferenceFocus: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementationOnce((callback) => {
      previousReferenceFocus = callback;
      return 0;
    });
    fireEvent.click(screen.getByRole("button", { name: "References" }));
    expect(previousReferenceFocus).toBeDefined();
    fireEvent.doubleClick(note, { button: 0 });
    const input = await screen.findByRole("textbox", { name: "Edit Project Markdown" });
    expect(screen.getByRole("complementary", { name: "Reference search and placement" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Project Inspector" })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    act(() => previousReferenceFocus!(performance.now()));
    expect(document.activeElement).toBe(input);
  });

  it.each(["before", "after"] as const)("does not rewrite the native IME range when final input arrives %s compositionend", async (finalInputOrder) => {
    const snapshot = overlappingSnapshot();
    const fetchMock = vi.fn<typeof fetch>(async (path, init) => {
      const response = (value: unknown) => new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
      if (String(path) === "/api/projects/project-a") return response(snapshot);
      if (String(path).endsWith("/contents/content-note/markdown")) {
        return response({ value: { ...snapshot.contents[0],
          markdownSource: JSON.parse(String(init?.body)).markdownSource, revision: 2 }, replayed: false });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
      initialEntries: ["/projects/project-a"],
    });
    const { container } = render(<RouterProvider router={router} />);
    const note = await flowCard(container, "item-note");
    fireEvent.click(note);
    fireEvent.click(within(await screen.findByRole("toolbar", { name: "Selected card actions" }))
      .getByRole("button", { name: "Edit" }));
    const input = await screen.findByRole("textbox", { name: "Edit Project Markdown" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "前文  后文" } });
    input.focus();

    // Native typing bypasses React's value tracker. Record script writes as well
    // as the final value: a write of the old value followed by the new one can
    // look correct after act(), but already destroyed the browser's IME range.
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
    const trackedValue = Object.getOwnPropertyDescriptor(input, "value")!;
    const scriptWrites: string[] = [];
    Object.defineProperty(input, "value", {
      ...trackedValue,
      set(value: string) {
        if (nativeValue.get!.call(this) !== value) scriptWrites.push(value);
        trackedValue.set!.call(this, value);
      },
    });
    const nativeInput = (text: string, isComposing: boolean) => {
      nativeValue.set!.call(input, `前文 ${text} 后文`);
      input.setSelectionRange(3 + text.length, 3 + text.length);
      fireEvent.input(input, { inputType: "insertCompositionText", data: text, isComposing });
      expect(input.value).toBe(`前文 ${text} 后文`);
      expect(scriptWrites).toEqual([]);
      expect(input.selectionStart).toBe(3 + text.length);
    };
    fireEvent.compositionStart(input);
    for (const text of ["s", "sh", "shi", "shi'z", "shi'zhe", "shi'zhe'yang"]) {
      nativeInput(text, true);
      expect(screen.getByRole("status", { name: "Project save status" }).textContent).toContain("Unsaved Markdown");
    }
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("textbox", { name: "Edit Project Markdown" })).toBe(input);
    if (finalInputOrder === "before") nativeInput("是这样的", true);
    else {
      nativeValue.set!.call(input, "前文 是这样的 后文");
      input.setSelectionRange(7, 7);
    }
    fireEvent.compositionEnd(input, { data: "是这样的" });
    if (finalInputOrder === "after") nativeInput("是这样的", false);
    expect(scriptWrites).toEqual([]);
    expect(input.value).toBe("前文 是这样的 后文");

    fireEvent.click(within(note).getByRole("button", { name: "Expand editor" }));
    const expanded = screen.getByRole("dialog", { name: "Expanded Markdown editor" });
    expect((within(expanded).getByRole("textbox") as HTMLTextAreaElement).value).toBe("前文 是这样的 后文");
    fireEvent.click(within(expanded).getByRole("button", { name: "Collapse editor" }));
    fireEvent.click(within(note).getByRole("tab", { name: "Preview" }));
    expect(within(note).getByLabelText("Markdown preview").textContent).toContain("前文 是这样的 后文");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved"));
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body)).markdownSource).toBe("前文 是这样的 后文");
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
    fireEvent.click(note);
    const actions = await screen.findByRole("toolbar", { name: "Selected card actions" });
    fireEvent.click(within(actions).getByRole("button", { name: "Edit" }));
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
