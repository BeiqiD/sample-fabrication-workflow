// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

  it("renders a deterministic read-only occurrence projection without initializing the Map", async () => {
    render(<MemoryRouter initialEntries={["/projects/project-a"]}>
      <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>
    </MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Topological laser" })).toBeTruthy();
    expect(screen.getByText("Read-only occurrence view")).toBeTruthy();
    expect(screen.queryByTestId("project-flow-canvas")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
      .toEqual(["Design note", "Sample A"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-a");
  });

  it("keeps source navigation explicit on a reference occurrence", async () => {
    render(<MemoryRouter initialEntries={["/projects/project-a"]}>
      <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>
    </MemoryRouter>);

    const link = await screen.findByRole("link", { name: "Open reference" });
    expect(link.getAttribute("href")).toBe("/references/sample/r1_sample-a");
  });
});
