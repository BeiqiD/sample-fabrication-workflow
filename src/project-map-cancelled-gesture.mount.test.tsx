// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ProjectPage } from "./pages/ProjectPage";
import { ProjectMapSurface } from "./components/project/ProjectMapSurface";
import { projectMapNodes } from "./lib/project-map-model";
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

function mouse(target: EventTarget, type: "mousedown" | "mousemove" | "mouseup", x: number, y: number) {
  const event = new MouseEvent(type, {
    button: 0, buttons: type === "mouseup" ? 0 : 1, clientX: x, clientY: y,
    bubbles: true, cancelable: true,
  });
  Object.defineProperty(event, "view", { value: document.defaultView });
  act(() => { target.dispatchEvent(event); });
}

function touchPoint(target: EventTarget, identifier: number, x: number, y: number): Touch {
  return {
    identifier, target, clientX: x, clientY: y, pageX: x, pageY: y,
    screenX: x, screenY: y, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1,
  };
}

function touch(target: EventTarget, type: "touchstart" | "touchmove" | "touchend", x: number, y: number) {
  const point = touchPoint(target, 1, x, y);
  const event = new TouchEvent(type, {
    touches: type === "touchend" ? [] : [point], changedTouches: [point],
    bubbles: true, cancelable: true,
  });
  act(() => { target.dispatchEvent(event); });
}

describe("Project Map cancelled pointer gestures", () => {
  let originalWidth: PropertyDescriptor | undefined;
  let originalHeight: PropertyDescriptor | undefined;
  let originalTouchPoints: PropertyDescriptor | undefined;
  let originalBBox: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 2 });
    originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("DOMMatrixReadOnly", class {
      m22: number;
      constructor(transform = "") { this.m22 = Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1); }
    });
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
      [navigator, "maxTouchPoints", originalTouchPoints],
      [SVGElement.prototype, "getBBox", originalBBox],
    ] as const) {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    }
  });

  it.each(["second-touch", "touchcancel"] as const)(
    "restores a %s drag and permits the next keyboard move", async (scenario) => {
      const onGeometryCommit = vi.fn();
      const { container } = render(<div style={{ width: 800, height: 600 }}>
        <ProjectMapSurface nodes={projectMapNodes(projectTestSnapshot())} selectedItemId="item-note"
          onSelect={() => undefined} onGeometryCommit={onGeometryCommit} />
      </div>);
      const card = await waitFor(() => {
        const value = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
        expect(value).toBeTruthy();
        expect(value.style.visibility).not.toBe("hidden");
        return value;
      });
      const target = card.querySelector("header")!;
      const initialTransform = card.style.transform;
      touch(target, "touchstart", 100, 100);
      touch(target, "touchmove", 110, 110);
      touch(target, "touchmove", 170, 170);
      expect(card.style.transform).not.toBe(initialTransform);
      expect(card.classList.contains("dragging")).toBe(true);
      const point = touchPoint(target, 1, 170, 170);
      if (scenario === "second-touch") {
        const second = touchPoint(target, 2, 220, 220);
        act(() => { target.dispatchEvent(new TouchEvent("touchmove", {
          touches: [point, second], changedTouches: [point, second], bubbles: true, cancelable: true,
        })); });
        touch(target, "touchend", 170, 170);
      } else {
        act(() => { target.dispatchEvent(new TouchEvent("touchcancel", {
          touches: [], changedTouches: [point], bubbles: true, cancelable: true,
        })); });
      }
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
      expect(card.style.transform).toBe(initialTransform);
      expect(card.classList.contains("dragging")).toBe(false);
      expect(onGeometryCommit).not.toHaveBeenCalled();
      fireEvent.keyDown(card, { key: "ArrowRight", code: "ArrowRight" });
      await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
      expect(onGeometryCommit.mock.calls[0][0]).toMatchObject({ before: { x: 20, y: 40 }, after: { x: 25, y: 40 } });
    },
  );

  it.each([false, true])("cleans a lock interrupted drag (unlock before release: %s)", async (unlockBeforeRelease) => {
    const onGeometryCommit = vi.fn();
    const descriptors = projectMapNodes(projectTestSnapshot());
    const surface = (disabled: boolean) => <div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface nodes={descriptors} selectedItemId="item-note"
        onSelect={() => undefined} onGeometryCommit={onGeometryCommit}
        geometryInteractionDisabled={disabled} />
    </div>;
    const { container, rerender } = render(surface(false));
    const card = await waitFor(() => {
      const value = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
      expect(value).toBeTruthy();
      expect(value.style.visibility).not.toBe("hidden");
      return value;
    });
    const initialTransform = card.style.transform;
    mouse(card.querySelector("header")!, "mousedown", 100, 100);
    mouse(window, "mousemove", 110, 110);
    mouse(window, "mousemove", 170, 170);
    expect(card.style.transform).not.toBe(initialTransform);
    rerender(surface(true));
    if (unlockBeforeRelease) {
      rerender(surface(false));
      mouse(window, "mousemove", 210, 210);
    }
    mouse(window, "mouseup", 210, 210);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    rerender(surface(false));
    expect(card.style.transform).toBe(initialTransform);
    expect(onGeometryCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
    expect(onGeometryCommit.mock.calls[0][0]).toMatchObject({ before: { x: 20, y: 40 }, after: { x: 25, y: 40 } });
  });

  it.each(["click", "lock", "unlock-before-release"] as const)(
    "releases resize bookkeeping after %s without committing cancelled dimensions", async (scenario) => {
      const onGeometryCommit = vi.fn();
      const descriptors = projectMapNodes(projectTestSnapshot());
      const surface = (disabled: boolean) => <div style={{ width: 800, height: 600 }}>
        <ProjectMapSurface nodes={descriptors} selectedItemId="item-note"
          onSelect={() => undefined} onGeometryCommit={onGeometryCommit}
          geometryInteractionDisabled={disabled} />
      </div>;
      const { container, rerender } = render(surface(false));
      const card = await waitFor(() => {
        const value = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
        expect(value).toBeTruthy();
        expect(value.style.visibility).not.toBe("hidden");
        return value;
      });
      await waitFor(() => expect(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)
        .not.toMatch(/^translate\(0px,\s*0px\)/));
      const initialTransform = card.style.transform;
      const control = within(card).getByRole("button", { name: "Resize card" });
      expect(control.closest(".react-flow__resize-control.bottom.right.handle")).toBeTruthy();
      mouse(control, "mousedown", 100, 100);
      if (scenario !== "click") {
        mouse(window, "mousemove", 110, 110);
        mouse(window, "mousemove", 150, 150);
        expect(card.style.width).not.toBe("250px");
        rerender(surface(true));
        expect(within(card).queryByRole("button", { name: "Resize card" })).toBeNull();
        if (scenario === "unlock-before-release") {
          rerender(surface(false));
          mouse(window, "mousemove", 170, 170);
        }
      }
      mouse(window, "mouseup", scenario === "click" ? 100 : 170, scenario === "click" ? 100 : 170);
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
      rerender(surface(false));
      expect(onGeometryCommit).not.toHaveBeenCalled();
      expect(card.style.transform).toBe(initialTransform);
      expect(card.style.width).toBe("250px");
      expect(card.style.height).toBe("180px");
      fireEvent.keyDown(card, { key: "ArrowRight", code: "ArrowRight" });
      await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
      expect(onGeometryCommit.mock.calls[0][0]).toMatchObject({
        before: { x: 20, y: 40, width: 250, height: 180 },
        after: { x: 25, y: 40, width: 250, height: 180 },
      });
    },
  );

  it.each(["deleted-and-restored", "replaced"] as const)(
    "does not carry an old drag into a %s placement", async (scenario) => {
      const onGeometryCommit = vi.fn();
      const descriptors = projectMapNodes(projectTestSnapshot());
      const surface = (nodes: typeof descriptors) => <div style={{ width: 800, height: 600 }}>
        <ProjectMapSurface nodes={nodes} selectedItemId="item-note"
          onSelect={() => undefined} onGeometryCommit={onGeometryCommit} />
      </div>;
      const { container, rerender } = render(surface(descriptors));
      const first = await waitFor(() => {
        const value = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
        expect(value).toBeTruthy();
        expect(value.style.visibility).not.toBe("hidden");
        return value;
      });
      mouse(first.querySelector("header")!, "mousedown", 100, 100);
      mouse(window, "mousemove", 110, 110);
      mouse(window, "mousemove", 170, 170);
      const replacements = descriptors.map((descriptor) => descriptor.itemId !== "item-note" ? descriptor : {
        ...descriptor,
        placementId: scenario === "replaced" ? "placement-replacement" : descriptor.placementId,
        geometry: { ...descriptor.geometry, x: 400, y: 100 },
      });
      if (scenario === "deleted-and-restored") rerender(surface(descriptors.filter((node) => node.itemId !== "item-note")));
      rerender(surface(replacements));
      const card = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
      mouse(window, "mousemove", 210, 210);
      mouse(window, "mouseup", 210, 210);
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
      expect(card.style.transform).toBe("translate(400px,100px)");
      expect(onGeometryCommit).not.toHaveBeenCalled();
      fireEvent.keyDown(card, { key: "ArrowRight", code: "ArrowRight" });
      await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
      expect(onGeometryCommit.mock.calls[0][0]).toMatchObject({
        placementId: scenario === "replaced" ? "placement-replacement" : "placement-note",
        before: { x: 400, y: 100 }, after: { x: 405, y: 100 },
      });
    },
  );

  it("releases a Page drag when the Markdown editor locks the workspace", async () => {
    const snapshot = projectTestSnapshot();
    const fetchMock = vi.fn<typeof fetch>(async (_path, init) => {
      if (init?.method === "PATCH") {
        const input = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ value: { ...snapshot.placements[0], ...input.geometry, revision: 2 }, replayed: false }));
      }
      return new Response(JSON.stringify(snapshot));
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
    const card = await waitFor(() => {
      const value = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
      expect(value).toBeTruthy();
      expect(value.style.visibility).not.toBe("hidden");
      return value;
    });
    const initialTransform = card.style.transform;
    mouse(card.querySelector("header")!, "mousedown", 100, 100);
    mouse(window, "mousemove", 110, 110);
    mouse(window, "mousemove", 170, 170);
    expect(card.style.transform).not.toBe(initialTransform);
    // A keyboard/assistive activation can open Edit while the pointer is held.
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected card actions" })).getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Edit Project Markdown" });
    expect(card.style.transform).toBe(initialTransform);
    mouse(window, "mouseup", 170, 170);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit Project Markdown" })).toBeNull());
    fireEvent.keyDown(card, { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Unsaved"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    const [, request] = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(request?.body)).geometry).toMatchObject({ x: 25, y: 40, width: 250, height: 180 });
  });

});
