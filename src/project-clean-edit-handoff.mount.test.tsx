// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshotWithAttachment } from "./project-test-fixture";

// Keep the real ProjectPage, ProjectMapSurface, ReactFlow and XYDrag listeners.
// Only layout measurements are supplied because jsdom has no layout engine.
class TestResizeObserver {
  private timers = new Set<number>();
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      this.callback([{ target, contentRect: target.getBoundingClientRect(),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }, 0);
    this.timers.add(timer);
  }
  unobserve() {}
  disconnect() { for (const timer of this.timers) window.clearTimeout(timer); this.timers.clear(); }
}

function mouse(target: EventTarget, type: "mousedown" | "mousemove" | "mouseup", x = 350, y = 100) {
  const event = new MouseEvent(type, { button: 0, buttons: type === "mouseup" ? 0 : 1,
    clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(event, "view", { value: document.defaultView });
  act(() => { target.dispatchEvent(event); });
}

function touch(target: EventTarget, type: "touchstart" | "touchmove" | "touchend", x: number, y: number) {
  const point = { identifier: 1, clientX: x, clientY: y, target } as Touch;
  const event = new TouchEvent(type, { touches: type === "touchend" ? [] : [point],
    changedTouches: [point], bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
}

function fixture() {
  const snapshot = projectTestSnapshotWithAttachment();
  snapshot.edges = [{ id: "edge-a", projectId: "project-a", sourceItemId: "item-note", targetItemId: "item-reference",
    sourceHandle: "right", targetHandle: "left", markerStart: "none", markerEnd: "arrow", label: "Feeds", revision: 1,
    createdBy: "user@example.com", updatedBy: "user@example.com", createdAt: snapshot.project.createdAt,
    updatedAt: snapshot.project.updatedAt, deletedAt: null, deletedBy: null }];
  return snapshot;
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn<typeof fetch>();
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");

function activeFocusDescription() {
  const active = document.activeElement;
  return `Active focus: ${JSON.stringify({ tag: active?.tagName, label: active?.getAttribute("aria-label"),
    class: active?.getAttribute("class"), text: active?.textContent?.slice(0, 100) })}`;
}

async function page() {
  const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
    initialEntries: ["/projects/project-a"],
  });
  const view = render(<RouterProvider router={router} />);
  await waitFor(() => {
    const nodes = view.container.querySelectorAll<HTMLElement>(".react-flow__node");
    expect(nodes.length).toBe(3);
    for (const node of nodes) expect(node.style.visibility).not.toBe("hidden");
    expect(view.container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)
      .not.toMatch(/^translate\(0px,\s*0px\)/);
  });
  return {
    ...view,
    card: (id: string) => view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!,
    canvas: view.container.querySelector<HTMLElement>(".project-flow-canvas")!,
    pane: view.container.querySelector<HTMLElement>(".react-flow__pane")!,
  };
}

async function inspectorEditor(view: Awaited<ReturnType<typeof page>>, kind = "markdown") {
  const itemId = kind === "attachment" ? "item-attachment" : "item-note";
  if (kind === "edge") fireEvent.click(view.container.querySelector('.react-flow__edge[data-id="edge-a"]')!);
  else fireEvent.click(view.card(itemId).querySelector("header")!);
  const toggle = screen.getByRole("button", { name: "Inspector" });
  if (toggle.getAttribute("aria-pressed") !== "true") fireEvent.click(toggle);
  const panel = screen.getByRole("complementary", { name: "Project Inspector" });
  const edit = within(panel).getByRole("button", { name: kind === "edge" ? "Edit edge" : kind === "attachment" ? "Edit metadata" : "Edit Markdown" });
  act(() => { edit.focus(); });
  fireEvent.click(edit);
  const field = await within(panel).findByLabelText(kind === "edge" ? "Label" : kind === "attachment" ? "Caption" : "Inspector Markdown editor");
  return { panel, field };
}

function dragOtherCard(view: Awaited<ReturnType<typeof page>>, input: "mouse" | "touch") {
  const header = view.card("item-reference").querySelector("header")!;
  if (input === "mouse") {
    mouse(header, "mousedown");
    mouse(window, "mousemove", 360, 110);
    mouse(window, "mousemove", 410, 140);
    mouse(window, "mouseup", 410, 140);
  } else {
    touch(header, "touchstart", 350, 100);
    touch(header, "touchmove", 360, 110);
    touch(header, "touchmove", 410, 140);
    touch(header, "touchend", 410, 140);
  }
}

async function assertFirstDragAndHistory(view: Awaited<ReturnType<typeof page>>, fieldLabel: string, input: "mouse" | "touch") {
  const noteTransform = view.card("item-note").style.transform;
  const reference = view.card("item-reference");
  const before = reference.style.transform;
  dragOtherCard(view, input);
  await waitFor(() => expect(screen.queryByLabelText(fieldLabel)).toBeNull());
  expect(reference.style.transform).not.toBe(before);
  const after = reference.style.transform;
  expect(view.card("item-note").style.transform).toBe(noteTransform);
  expect(reference.classList.contains("selected")).toBe(true);
  expect(view.card("item-note").classList.contains("selected")).toBe(false);
  expect(writes()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(reference.style.transform).toBe(before));
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  await waitFor(() => expect(reference.style.transform).toBe(after));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved"));
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toBe("/api/projects/project-a/placements/placement-reference");
  const geometry = JSON.parse(String(writes()[0][1]?.body)).geometry;
  expect(after).toBe(`translate(${geometry.x}px,${geometry.y}px)`);
  expect(geometry).toMatchObject({ width: 240, height: 150, zIndex: 1 });
}

describe("clean editor handoff into native Canvas gestures", () => {
  let originals: [object, string, PropertyDescriptor | undefined][];
  beforeAll(async () => { await import("./components/project/ProjectMarkdownEditor"); });
  beforeEach(() => {
    originals = ([
      [HTMLElement.prototype, "offsetWidth"], [HTMLElement.prototype, "offsetHeight"],
      [navigator, "maxTouchPoints"], [document, "elementFromPoint"], [SVGElement.prototype, "getBBox"],
    ] as const).map(([target, key]) => [target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 2 });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("DOMMatrixReadOnly", class {
      m22: number;
      constructor(transform = "") { this.m22 = Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1); }
    });
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: { configurable: true, get() { return this.classList.contains("react-flow__handle") ? 10
        : /^\d+(?:\.\d+)?px$/.test(this.style.width) ? Number.parseFloat(this.style.width) : 800; } },
      offsetHeight: { configurable: true, get() { return this.classList.contains("react-flow__handle") ? 10
        : /^\d+(?:\.\d+)?px$/.test(this.style.height) ? Number.parseFloat(this.style.height) : 600; } },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { x: 0, y: 0, left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight,
        width: this.offsetWidth, height: this.offsetHeight, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
    Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 0, height: 0 }) });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(min-width: 860px)", media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const snapshot = fixture();
    fetchMock.mockImplementation(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return response(snapshot);
      if (String(path) === "/api/projects/project-a/placements/placement-reference" && init?.method === "PATCH") {
        const placement = snapshot.placements.find((value) => value.id === "placement-reference")!;
        Object.assign(placement, JSON.parse(String(init.body)).geometry, { revision: placement.revision + 1 });
        return response({ value: placement, replayed: false });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [target, key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  });

  it.each(["mouse", "touch"] as const)("hands an unchanged Inspector note directly to the first %s drag, with geometry history and persistence", async (input) => {
    const view = await page();
    await inspectorEditor(view);
    await assertFirstDragAndHistory(view, "Inspector Markdown editor", input);
  });

  it("hands an unchanged inline note directly to the first drag of another card", async () => {
    const view = await page();
    fireEvent.click(view.card("item-note").querySelector("header")!);
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected card actions" })).getByRole("button", { name: "Edit" }));
    await screen.findByLabelText("Edit Project Markdown");
    await assertFirstDragAndHistory(view, "Edit Project Markdown", "mouse");
  });

  it.each(["attachment", "edge"])("hands an unchanged %s editor to the first outside card click without a second click or focus return", async (kind) => {
    const view = await page();
    const { field } = await inspectorEditor(view, kind);
    const reference = view.card("item-reference");
    const header = reference.querySelector("header")!;
    mouse(header, "mousedown");
    mouse(window, "mouseup");
    fireEvent.click(header);
    await waitFor(() => expect(field.isConnected).toBe(false));
    expect(reference.classList.contains("selected")).toBe(true);
    expect(view.container.querySelector(".react-flow__edge.selected")).toBeNull();
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
    expect(view.canvas.contains(document.activeElement), activeFocusDescription()).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("invalidates a pending Inspector opening focus frame when a clean edge editor hands focus back to Canvas", async () => {
    const view = await page();
    // Initial ReactFlow fitting is complete. Hold subsequent frames to model
    // rapid Inspector → Edit → Canvas actions before the opening focus runs.
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 100_000;
    const originalCancelFrame = window.cancelAnimationFrame.bind(window);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      if (!frames.delete(id)) originalCancelFrame(id);
    });
    const { field } = await inspectorEditor(view, "edge");
    const openingFrames = [...frames.entries()];
    expect(openingFrames.length).toBeGreaterThan(0);
    const header = view.card("item-reference").querySelector("header")!;
    mouse(header, "mousedown");
    mouse(window, "mouseup");
    fireEvent.click(header);
    expect(field.isConnected).toBe(false);
    expect(view.canvas.contains(document.activeElement), activeFocusDescription()).toBe(true);
    act(() => {
      for (const [id, callback] of openingFrames) {
        if (frames.delete(id)) callback(performance.now());
      }
    });
    expect(view.canvas.contains(document.activeElement), activeFocusDescription()).toBe(true);
    expect(view.card("item-reference").classList.contains("selected")).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("hands an unchanged Markdown editor to the first click on an existing edge without losing its SVG target", async () => {
    const view = await page();
    const { panel, field } = await inspectorEditor(view);
    const edge = view.container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    const path = edge.querySelector(".react-flow__edge-interaction")!;
    mouse(path, "mousedown", 290, 120);
    expect(path.isConnected).toBe(true);
    mouse(window, "mouseup", 290, 120);
    fireEvent.click(path);
    await waitFor(() => expect(field.isConnected).toBe(false));
    expect(edge.classList.contains("selected")).toBe(true);
    expect(view.container.querySelector(".react-flow__node.selected")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Edit edge" })).toBeTruthy();
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
    expect(view.canvas.contains(document.activeElement), activeFocusDescription()).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("exits on the blank pane and keeps focus in Canvas while retaining internal editor interactions", async () => {
    const view = await page();
    const { panel, field } = await inspectorEditor(view);
    mouse(field, "mousedown");
    mouse(field, "mouseup");
    fireEvent.click(field);
    expect(within(panel).getByLabelText("Inspector Markdown editor")).toBe(field);
    mouse(view.pane, "mousedown", 700, 450);
    mouse(window, "mouseup", 700, 450);
    fireEvent.click(view.pane);
    await waitFor(() => expect(field.isConnected).toBe(false));
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
    expect(document.activeElement).toBe(view.canvas);
    expect(view.container.querySelector(".react-flow__node.selected")).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it("keeps the inline editor, its text selection and Preview controls active on internal pointer gestures", async () => {
    const view = await page();
    fireEvent.click(view.card("item-note").querySelector("header")!);
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected card actions" })).getByRole("button", { name: "Edit" }));
    const field = await screen.findByLabelText("Edit Project Markdown") as HTMLTextAreaElement;
    mouse(field, "mousedown");
    field.setSelectionRange(2, 8);
    mouse(field, "mouseup");
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(8);
    const preview = screen.getByRole("tab", { name: "Preview" });
    mouse(preview, "mousedown");
    mouse(preview, "mouseup");
    fireEvent.click(preview);
    expect(preview.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it.each(["dirty", "saving", "uncertain", "conflict"] as const)("preserves a %s editor and blocks native drag and outside selection", async (status) => {
    const snapshot = fixture();
    let pendingSave: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(async (_path, init) => !init?.method ? response(snapshot)
      : new Promise<Response>((resolve) => { pendingSave = resolve; }));
    const view = await page();
    const { field, panel } = await inspectorEditor(view);
    const draft = status === "dirty" ? "# Keep my local work" : snapshot.contents[0].markdownSource!;
    if (status === "dirty") fireEvent.change(field, { target: { value: draft } });
    else {
      // Even an unchanged payload must remain locked once a save is unresolved.
      fireEvent.click(within(panel).getByRole("button", { name: "Save Markdown" }));
      await waitFor(() => expect(pendingSave).toBeTypeOf("function"));
      if (status !== "saving") {
        await act(async () => { pendingSave!(response({ error: "Save not confirmed" }, status === "conflict" ? 409 : 503)); });
        await within(panel).findByText("Save not confirmed");
      }
    }
    const reference = view.card("item-reference");
    const before = reference.style.transform;
    dragOtherCard(view, "mouse");
    fireEvent.click(reference.querySelector("header")!);
    expect(within(panel).getByLabelText("Inspector Markdown editor")).toBe(field);
    expect((field as HTMLTextAreaElement).value).toBe(draft);
    expect(reference.style.transform).toBe(before);
    expect(reference.classList.contains("selected")).toBe(false);
    expect(view.card("item-note").classList.contains("selected")).toBe(true);
    expect(writes()).toHaveLength(status === "dirty" ? 0 : 1);
  });

  it.each(["attachment", "edge"])("treats a changed %s secondary field as dirty and hands off after its exact saved value is restored", async (kind) => {
    const view = await page();
    const { field, panel } = await inspectorEditor(view, kind);
    if (kind === "attachment") fireEvent.change(within(panel).getByLabelText("Source URL"), { target: { value: "https://example.com/evidence" } });
    else fireEvent.click(within(panel).getByRole("radio", { name: "Both directions" }));
    const reference = view.card("item-reference");
    const before = reference.style.transform;
    dragOtherCard(view, "mouse");
    fireEvent.click(reference.querySelector("header")!);
    expect(field.isConnected).toBe(true);
    expect(reference.style.transform).toBe(before);
    expect(reference.classList.contains("selected")).toBe(false);
    // D3 removes its mouseup click-suppression listener with setTimeout(0).
    // Start the next independent user action after that timer queue, rather
    // than a paint callback that may run before the listener is removed.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    if (kind === "attachment") fireEvent.change(within(panel).getByLabelText("Source URL"), { target: { value: "" } });
    else {
      const forward = within(panel).getByRole("radio", { name: "Source to target" });
      fireEvent.click(forward);
      expect(forward.getAttribute("aria-checked")).toBe("true");
    }
    dragOtherCard(view, "mouse");
    await waitFor(() => expect(field.isConnected).toBe(false));
    expect(reference.style.transform).not.toBe(before);
    expect(reference.classList.contains("selected")).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("does not implicitly discard a new empty note on the first outside drag", async () => {
    const view = await page();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Note / Markdown" }));
    const field = await screen.findByLabelText("New Project Markdown");
    const before = view.card("item-reference").style.transform;
    dragOtherCard(view, "mouse");
    fireEvent.click(view.card("item-reference").querySelector("header")!);
    expect(screen.getByLabelText("New Project Markdown")).toBe(field);
    expect(view.card("item-reference").style.transform).toBe(before);
    expect(writes()).toHaveLength(0);
  });
});
