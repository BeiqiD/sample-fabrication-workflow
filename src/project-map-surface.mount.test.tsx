// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectMapSurface } from "./components/project/ProjectMapSurface";
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
});
