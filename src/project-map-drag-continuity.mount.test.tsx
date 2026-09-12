// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => null }));

class TestResizeObserver {
  private timers = new Set<number>();
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe(target: Element) {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      this.callback([{
        target,
        contentRect: { width: (target as HTMLElement).offsetWidth, height: (target as HTMLElement).offsetHeight },
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }, 0);
    this.timers.add(timer);
  }
  unobserve() {}
  disconnect() { for (const timer of this.timers) window.clearTimeout(timer); this.timers.clear(); }
}

function dispatchMouse(target: EventTarget, type: "mousedown" | "mousemove" | "mouseup", x: number, y: number) {
  const event = new MouseEvent(type, { button: 0, buttons: type === "mouseup" ? 0 : 1,
    clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(event, "view", { value: document.defaultView });
  act(() => { target.dispatchEvent(event); });
}

function response(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Project Map drag continuity during a real layout acknowledgement", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
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
      offsetWidth: { configurable: true, get() { return /^\d+(?:\.\d+)?px$/.test(this.style.width) ? Number.parseFloat(this.style.width) : 800; } },
      offsetHeight: { configurable: true, get() { return /^\d+(?:\.\d+)?px$/.test(this.style.height) ? Number.parseFloat(this.style.height) : 600; } },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { x: 0, y: 0, left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight,
        width: this.offsetWidth, height: this.offsetHeight, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true, value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    });
  });
  afterEach(() => { cleanup(); fetchMock.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("keeps the live drag position when an earlier card save completes before mouseup", async () => {
    const snapshot = projectTestSnapshot();
    let acknowledgeFirst!: () => void;
    let patchCount = 0;
    fetchMock.mockImplementation((_path, init) => {
      if (init?.method !== "PATCH") return Promise.resolve(response(snapshot));
      const placementId = String(_path).split("/").at(-1);
      const input = JSON.parse(String(init.body));
      const baseline = snapshot.placements.find((placement) => placement.id === placementId)!;
      const result = { value: { ...baseline, ...input.geometry, revision: baseline.revision + 1 }, replayed: false };
      patchCount += 1;
      if (patchCount === 1) return new Promise<Response>((resolve) => { acknowledgeFirst = () => resolve(response(result)); });
      return Promise.resolve(response(result));
    });
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
      initialEntries: ["/projects/project-a"],
    });
    const { container } = render(<RouterProvider router={router} />);
    const reference = await waitFor(() => {
      const value = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-reference"]');
      expect(value).toBeTruthy();
      return value!;
    });
    const note = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    await waitFor(() => expect(reference.style.visibility).not.toBe("hidden"));

    // A real first drag records a semantic command, then its PATCH remains pending.
    dispatchMouse(reference.querySelector("header")!, "mousedown", 200, 100);
    dispatchMouse(window, "mousemove", 210, 100);
    dispatchMouse(window, "mousemove", 240, 100);
    dispatchMouse(window, "mouseup", 240, 100);
    await waitFor(() => expect(screen.getByText("Unsaved")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchCount).toBe(1));

    const initialNoteTransform = note.style.transform;
    dispatchMouse(note.querySelector("header")!, "mousedown", 100, 120);
    dispatchMouse(window, "mousemove", 110, 120);
    dispatchMouse(window, "mousemove", 160, 150);
    await waitFor(() => expect(note.style.transform).not.toBe(initialNoteTransform));
    const draggedNoteTransform = note.style.transform;
    expect(note.classList.contains("dragging")).toBe(true);

    await act(async () => { acknowledgeFirst(); });
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const transformAfterAcknowledgement = note.style.transform;
    const draggingAfterAcknowledgement = note.classList.contains("dragging");

    // Release without an extra mousemove: the final command must use the live drag.
    dispatchMouse(window, "mouseup", 160, 150);
    await waitFor(() => expect(screen.getByText("Unsaved")).toBeTruthy());
    expect(note.style.transform).toBe(draggedNoteTransform);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchCount).toBe(2));
    const [, notePatch] = fetchMock.mock.calls.find(([path, init]) => (
      String(path).endsWith("/placement-note") && init?.method === "PATCH"
    ))!;
    const savedGeometry = JSON.parse(String(notePatch?.body)).geometry;
    expect(savedGeometry.x).toBeGreaterThan(20);
    expect(savedGeometry.y).toBeGreaterThan(40);
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(note.style.transform).toBe(initialNoteTransform));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(note.style.transform).toBe(draggedNoteTransform));

    // Acknowledging A must not snap B back or remove its active-drag state.
    expect({ transform: transformAfterAcknowledgement, dragging: draggingAfterAcknowledgement })
      .toEqual({ transform: draggedNoteTransform, dragging: true });
  });
});
