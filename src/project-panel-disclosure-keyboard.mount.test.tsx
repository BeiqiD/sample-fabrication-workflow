// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

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

const fetchMock = vi.fn<typeof fetch>();
let originalWidth: PropertyDescriptor | undefined;
let originalHeight: PropertyDescriptor | undefined;
let originalBBox: PropertyDescriptor | undefined;

beforeEach(() => {
  originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get() { return Number.parseFloat(this.style.width) || 800; } },
    offsetHeight: { configurable: true, get() { return Number.parseFloat(this.style.height) || 600; } },
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true, value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { x: 0, y: 0, left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight,
      width: this.offsetWidth, height: this.offsetHeight, toJSON: () => ({}),
    } as DOMRect;
  });
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", class {
    m22: number;
    constructor(transform = "") { this.m22 = Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1); }
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  const snapshot = projectTestSnapshot();
  const reference = snapshot.references[0].resolution;
  reference.contexts = [{ segments: [{
    type: "sample", id: "sample-a", label: "Sample A", deletedAt: null, archivedAt: null,
  }] }];
  fetchMock.mockImplementation(async (path, init) => {
    if (String(path) === "/api/projects/project-a" && !init?.method) return new Response(JSON.stringify(snapshot));
    if (String(path) === "/api/references/children") return new Response(JSON.stringify({
      parent: reference, parentEligible: true, truncated: false,
      children: [{ ...reference, target: { type: "comment", id: "comment-space" },
        source: { ...reference.source, title: "Space activation fixture", kind: "comment" },
      }],
    }));
    throw new Error(`Unexpected request: ${String(path)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup(); fetchMock.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [target, key, original] of [
    [HTMLElement.prototype, "offsetWidth", originalWidth],
    [HTMLElement.prototype, "offsetHeight", originalHeight],
    [SVGElement.prototype, "getBBox", originalBBox],
  ] as const) {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  }
});

function key(target: Element, type: "keydown" | "keyup", key: string, code: string) {
  const event = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
  fireEvent(target, event);
  return event;
}

describe("Project panel disclosures beside the real Map", () => {
  it.each(["Inspector", "References"] as const)("keeps native Space activation in %s without changing Canvas selection or geometry", async (kind) => {
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
      initialEntries: ["/projects/project-a?focus=item-note"],
    });
    const { container } = render(<RouterProvider router={router} />);
    const note = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(node?.classList.contains("selected")).toBe(true);
      expect(node!.style.visibility).not.toBe("hidden");
      return node!;
    });
    await waitFor(() => expect(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)
      .not.toMatch(/^translate\(0px,\s*0px\)/));
    fireEvent.click(screen.getByRole("button", { name: kind }));
    const panel = screen.getByRole("complementary", {
      name: kind === "Inspector" ? "Project Inspector" : "Reference search and placement",
    });
    const summary = kind === "Inspector"
      ? within(panel).getByText("Details", { selector: "summary" })
      : await within(panel).findByLabelText("More about Space activation fixture");
    const details = summary.parentElement as HTMLDetailsElement;
    const geometry = [note.style.transform, note.style.width, note.style.height];
    summary.focus();
    expect(details.open).toBe(false);
    const down = key(summary, "keydown", " ", "Space");
    expect(down.defaultPrevented).toBe(false);
    expect(details.open).toBe(false); // Keydown must not implement its own toggle.
    key(summary, "keyup", " ", "Space");
    // jsdom does not synthesize keyboard activation; deliver the native click
    // that the browser generates after an uncancelled Space key sequence.
    fireEvent.click(summary, { detail: 0 });
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect(note.classList.contains("selected")).toBe(true);
    expect(container.querySelectorAll(".react-flow__node.selected")).toHaveLength(1);
    expect([note.style.transform, note.style.width, note.style.height]).toEqual(geometry);
    expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved");

    const enter = key(summary, "keydown", "Enter", "Enter");
    expect(enter.defaultPrevented).toBe(false);
    fireEvent.click(summary, { detail: 0 });
    key(summary, "keyup", "Enter", "Enter");
    expect(details.open).toBe(false);
    // Canvas Space keeps its existing pan ownership outside the panel boundary.
    const canvas = container.querySelector(".react-flow__pane")!;
    expect(key(canvas, "keydown", " ", "Space").defaultPrevented).toBe(true);
    key(canvas, "keyup", " ", "Space");
    expect(fetchMock.mock.calls.filter(([path, init]) => String(path).startsWith("/api/projects/") && init?.method)).toHaveLength(0);
  });
});
