// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let originalPointLookup: PropertyDescriptor | undefined;
  let originalBBox: PropertyDescriptor | undefined;
  beforeEach(() => {
    pointTarget = null;
    originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
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
      [document, "elementFromPoint", originalPointLookup],
      [SVGElement.prototype, "getBBox", originalBBox],
    ] as const) {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    }
  });

  it("resizes through the real bottom-right control and commits dimensions without moving the card", async () => {
    const onGeometryCommit = vi.fn();
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface nodes={projectMapNodes(projectTestSnapshot())}
        selectedItemId="item-note" onSelect={() => undefined} onGeometryCommit={onGeometryCommit} />
    </div>);
    const control = await waitFor(() => {
      const value = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"] .react-flow__resize-control.bottom.right.handle');
      expect(value).toBeTruthy();
      expect(value!.closest<HTMLElement>(".react-flow__node")!.style.visibility).not.toBe("hidden");
      return value!;
    });
    // The initial fit is asynchronous; begin resizing after its viewport update.
    await waitFor(() => expect(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)
      .not.toMatch(/^translate\(0px,\s*0px\)/));
    mouse(control, "mousedown", 300, 250);
    mouse(window, "mousemove", 310, 260);
    mouse(window, "mousemove", 360, 290);
    mouse(window, "mouseup", 360, 290);
    await waitFor(() => expect(onGeometryCommit).toHaveBeenCalledTimes(1));
    expect(onGeometryCommit.mock.calls[0][0]).toMatchObject({
      placementId: "placement-note",
      before: { x: 20, y: 40, width: 250, height: 180 },
      after: { x: 20, y: 40, width: 310, height: 220 },
    });
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
