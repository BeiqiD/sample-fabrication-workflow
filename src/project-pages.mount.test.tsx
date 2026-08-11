// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../shared/project-api";
import { ProjectWorkspacePage } from "./pages/ProjectWorkspacePage";
import { ProjectsPage } from "./pages/ProjectsPage";

function projectSnapshot(): ProjectSnapshot {
  return {
    schemaVersion: 1,
    project: { id: "project-a", title: "Project A", revision: 2, nextCreatedSequence: 2, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, deletedBy: null },
    contents: [], attachments: [], edges: [],
    items: [{ id: "item-a", projectId: "project-a", itemType: "reference", projectContentId: null, referenceTargetId: "registry-a", createdSequence: 1, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, deletedBy: null }],
    placements: [{ id: "placement-a", projectItemId: "item-a", x: 0, y: 0, width: 240, height: 140, zIndex: 0, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z" }],
    references: [{ registryId: "registry-a", resolution: { target: { type: "sample", id: "sample-a" }, resolution: "resolved", source: { title: "Sample A", subtitle: "Stored sample", excerpt: "Reference excerpt", kind: "sample", state: "active", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, archivedAt: null }, contexts: [], destination: { referenceUrl: "/references/sample/sample-a", mode: "source", openSourceUrl: "/samples/sample-a", contextOpenSourceUrls: [] } } }],
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }));
}

describe("Project pages", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists Projects and creates one through the authoritative Project API", async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse({ projects: [{ id: "project-a", title: "Existing Project", revision: 1, nextCreatedSequence: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, deletedBy: null }] }))
      .mockImplementationOnce(() => jsonResponse({ project: { id: "project-test-uuid" }, replayed: false }, 201));

    render(<MemoryRouter initialEntries={["/projects"]}>
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<p>Opened Project</p>} />
      </Routes>
    </MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Existing Project" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Project title"), { target: { value: "  New Project  " } });
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      id: "project-test-uuid",
      title: "New Project",
      operationId: "project-create-test-uuid",
    });
    expect(await screen.findByText("Opened Project")).toBeTruthy();
  });

  it("defaults narrow viewports to a deterministic read-only occurrence projection", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      media: "(min-width: 901px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    fetchMock.mockImplementation(() => jsonResponse(projectSnapshot()));

    render(<MemoryRouter initialEntries={["/projects/project-a"]}>
      <Routes><Route path="/projects/:projectId" element={<ProjectWorkspacePage />} /></Routes>
    </MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Project A" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Project read-only mobile projection" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sample A" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Project Map" })).toBeNull();
  });
});
