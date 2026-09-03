// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => null,
}));

vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef(function ProjectMapSurfaceFixture(
      props: {
        selectedItemId?: string | null;
        focusedItemId?: string | null;
      },
      ref: React.ForwardedRef<{
        getViewportCenter: () => { x: number; y: number };
      }>,
    ) {
      React.useImperativeHandle(ref, () => ({
        getViewportCenter: () => ({ x: 400, y: 300 }),
      }));
      return <div
        data-testid="project-flow-canvas"
        data-selected-item-id={props.selectedItemId ?? ""}
        data-focused-item-id={props.focusedItemId ?? ""}
      >Map fixture</div>;
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

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function renderProjectPage(initialEntry: string) {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: [initialEntry] });
  return render(<RouterProvider router={router} />);
}

describe("mounted Project Inspector integration", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("mounts the authoritative Inspector through ProjectPage occurrence focus", async () => {
    const snapshot = projectTestSnapshot();
    fetchMock.mockResolvedValueOnce(await jsonResponse(snapshot));
    renderProjectPage("/projects/project-a?focus=item-reference");

    const map = await screen.findByTestId("project-flow-canvas");
    await waitFor(() => {
      expect(map.getAttribute("data-selected-item-id")).toBe("item-reference");
      expect(map.getAttribute("data-focused-item-id")).toBe("item-reference");
    });

    const inspector = screen.getByRole("complementary", { name: "Project Inspector" });
    expect(within(inspector).getByRole("heading", { level: 2, name: "Sample A" })).toBeTruthy();
    expect(within(inspector).getByText("Source & provenance", { selector: "summary" })).toBeTruthy();
    expect(within(inspector).getByText("sample:sample-a")).toBeTruthy();
    expect(within(inspector).getByRole("link", { name: "Open exact source" }).getAttribute("href"))
      .toBe("/samples/sample-a");
    expect(within(inspector).queryByText("The authoritative Project occurrence is unavailable."))
      .toBeNull();
  });
});
