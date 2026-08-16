// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((props: {
      nodes: Array<{ itemId: string }>;
      selectedItemId?: string | null;
      focusedItemId?: string | null;
      onSelect: (itemId: string | null) => void;
    }, ref: React.ForwardedRef<{ getViewportCenter: () => { x: number; y: number } }>) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      return <div
        data-testid="project-flow-canvas"
        data-selected-item-id={props.selectedItemId ?? ""}
        data-focused-item-id={props.focusedItemId ?? ""}
      >
        {props.nodes.map((node) => <button
          key={node.itemId}
          type="button"
          onClick={() => props.onSelect(node.itemId)}
        >Select {node.itemId}</button>)}
      </div>;
    }),
  };
});

function desktopMatchMedia() {
  return vi.fn(() => ({
    matches: true,
    media: "(min-width: 860px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("mounted Project stable-link copy identity", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const clipboardWriteText = vi.fn(async (_value: string): Promise<void> => undefined);

  beforeEach(() => {
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    clipboardWriteText.mockReset();
    vi.unstubAllGlobals();
  });

  async function selectOccurrence(itemId: string) {
    fireEvent.click(await screen.findByRole("button", { name: `Select ${itemId}` }));
    await waitFor(() => expect(screen.getByTestId("project-flow-canvas").getAttribute("data-selected-item-id"))
      .toBe(itemId));
  }

  it.each(["resolve", "reject"] as const)(
    "ignores a delayed clipboard %s after another occurrence is selected",
    async (outcome) => {
      const pending = deferred<void>();
      fetchMock.mockResolvedValueOnce(await jsonResponse(projectTestSnapshot()));
      clipboardWriteText.mockImplementationOnce(() => pending.promise);
      renderProjectPage();

      await selectOccurrence("item-note");
      fireEvent.click(screen.getByRole("button", { name: "Copy stable link" }));
      await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith(
        `${window.location.origin}/projects/project-a?focus=item-note`,
      ));

      await selectOccurrence("item-reference");
      await act(async () => {
        if (outcome === "resolve") pending.resolve(undefined);
        else pending.reject(new Error("denied"));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Copy stable link" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Stable link copied" })).toBeNull();
        expect(screen.queryByText("Clipboard access was unavailable; the link was not copied.")).toBeNull();
      });
    },
  );

  it("keeps the latest copy result when an older request settles afterward", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    fetchMock.mockResolvedValueOnce(await jsonResponse(projectTestSnapshot()));
    clipboardWriteText
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    renderProjectPage();

    await selectOccurrence("item-note");
    fireEvent.click(screen.getByRole("button", { name: "Copy stable link" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy stable link" }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(undefined);
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Stable link copied" })).toBeTruthy();

    await act(async () => {
      first.reject(new Error("late denial"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stable link copied" })).toBeTruthy();
      expect(screen.queryByText("Clipboard access was unavailable; the link was not copied.")).toBeNull();
    });
  });
});
