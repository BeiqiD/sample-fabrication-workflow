// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

function matchMedia(matches: boolean) {
  return vi.fn(() => ({
    matches,
    media: "(min-width: 860px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("mounted mobile Project occurrence projection", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("matchMedia", matchMedia(false));
    fetchMock.mockResolvedValue(new Response(JSON.stringify(projectTestSnapshot()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("defaults to the deterministic Reading projection without initializing the Map", async () => {
    renderProjectPage();

    expect(await screen.findByRole("heading", { name: "Topological laser" })).toBeTruthy();
    expect(screen.getByText("Reading")).toBeTruthy();
    expect(screen.queryByTestId("project-flow-canvas")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
      .toEqual(["Design note", "Sample A"]);
    expect(document.querySelector(".project-reading-markdown-source")?.textContent).toBe("# Design note\n\nPreserve the occurrence identity.");
    expect(screen.getByRole("button", { name: "Edit Markdown" })).toBeTruthy();
    expect(screen.queryByText("Add references")).toBeNull();
    expect(screen.queryByText("Add attachment")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-a");
  });

  it("keeps source navigation explicit on a reference occurrence", async () => {
    renderProjectPage();

    const link = await screen.findByRole("link", { name: "Open reference" });
    expect(link.getAttribute("href")).toBe("/references/sample/r1_sample-a");
  });
});
