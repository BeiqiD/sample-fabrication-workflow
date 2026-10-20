// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectMapSurface, type ProjectMapSurfaceHandle } from "./components/project/ProjectMapSurface";
import {
  PROJECT_REFERENCE_DRAG_MIME,
  type ProjectReferenceDragPayload,
} from "./lib/project-reference-placement";
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

class TestDataTransfer {
  effectAllowed = "copy";
  dropEffect = "none";
  types = [PROJECT_REFERENCE_DRAG_MIME];
  private readonly value: string;

  constructor(payload: ProjectReferenceDragPayload) {
    this.value = JSON.stringify(payload);
  }

  getData(type: string) {
    return type === PROJECT_REFERENCE_DRAG_MIME ? this.value : "";
  }

  setData() {}
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

function dispatchDrop(
  target: HTMLElement,
  payload: ProjectReferenceDragPayload,
  clientX: number,
  clientY: number,
) {
  const dataTransfer = new TestDataTransfer(payload) as unknown as DataTransfer;
  const dragOver = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(dragOver, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(dragOver);
  const drop = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(drop);
}

describe("real Project Map reference drop", () => {
  beforeEach(installReactFlowDomMocks);

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses the same live React Flow coordinate transform for an exact drop and viewport center", async () => {
    const onReferenceDrop = vi.fn();
    const ref = createRef<ProjectMapSurfaceHandle>();
    const payload: ProjectReferenceDragPayload = {
      version: 1,
      target: { type: "sample", id: "sample-drop" },
      preview: {
        title: "Dropped sample",
        subtitle: null,
        excerpt: null,
        referenceUrl: "/references/sample/sample-drop",
        openSourceUrl: "/samples/sample-drop",
      },
    };
    const { container, getByTestId } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        ref={ref}
        nodes={projectMapNodes(projectTestSnapshot())}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
        onReferenceDrop={onReferenceDrop}
      />
    </div>);

    await waitFor(() => expect(ref.current).toBeTruthy());
    const canvas = getByTestId("project-flow-canvas");
    const flow = container.querySelector<HTMLElement>(".react-flow");
    const rect = {
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      top: 20,
      right: 810,
      bottom: 620,
      left: 10,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect);
    if (flow) vi.spyOn(flow, "getBoundingClientRect").mockReturnValue(rect);

    const center = ref.current!.getViewportCenter();
    expect(center).toBeTruthy();
    dispatchDrop(canvas, payload, 410, 320);

    await waitFor(() => expect(onReferenceDrop).toHaveBeenCalledTimes(1));
    const [receivedPayload, point] = onReferenceDrop.mock.calls[0];
    expect(receivedPayload).toEqual(payload);
    expect(point.x).toBeCloseTo(center!.x, 5);
    expect(point.y).toBeCloseTo(center!.y, 5);
  });
});
