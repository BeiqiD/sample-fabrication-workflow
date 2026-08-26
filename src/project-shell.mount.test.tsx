// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "./pages/ProjectsPage";

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function renderProjectsPage() {
  const router = createMemoryRouter([{
    path: "/projects",
    element: <ProjectsPage />,
  }, {
    path: "/projects/:projectId",
    element: <p>Opened Project</p>,
  }], { initialEntries: ["/projects"] });
  return render(<RouterProvider router={router} />);
}

describe("Phase 5A1 Project directory shell", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps load failure distinct from a confirmed empty directory and retries in place", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("Project directory is temporarily unavailable"))
      .mockImplementationOnce(() => jsonResponse({ projects: [] }));

    renderProjectsPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Projects could not be loaded");
    expect(alert.textContent).toContain("Project directory is temporarily unavailable");
    expect(screen.queryByText("No Projects yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry loading Projects" }));

    expect(await screen.findByText("No Projects yet")).toBeTruthy();
    expect(screen.queryByText("Projects could not be loaded")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps Project creation errors local to one unambiguous open form", async () => {
    fetchMock.mockImplementation((_path, init) => (
      init?.method === "POST"
        ? jsonResponse({ error: "Project creation is temporarily unavailable" }, 503)
        : jsonResponse({ projects: [] })
    ));

    renderProjectsPage();
    await screen.findByText("No Projects yet");

    fireEvent.click(screen.getByRole("button", { name: "Create first Project" }));
    const form = screen.getByRole("form", { name: "Create Project" });
    const closeButton = screen.getByRole("button", { name: "Close new Project form" });
    const createButton = within(form).getByRole("button", { name: "Create Project" });
    expect(screen.queryByRole("button", { name: "Create first Project" })).toBeNull();
    expect(closeButton.getAttribute("aria-expanded")).toBe("true");
    expect(closeButton.classList.contains("primary")).toBe(false);
    expect(createButton.classList.contains("primary")).toBe(true);
    const primaryButtons = screen.getAllByRole("button").filter((button) => button.classList.contains("primary"));
    expect(primaryButtons).toHaveLength(1);
    expect(primaryButtons[0]).toBe(createButton);

    fireEvent.change(within(form).getByLabelText("Project title"), {
      target: { value: "Topological laser fabrication" },
    });
    fireEvent.click(createButton);

    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain("Project creation is temporarily unavailable");
    expect(screen.queryByText("Projects could not be loaded")).toBeNull();
    expect(screen.getByText("No Projects yet")).toBeTruthy();

    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Create Project" })).toBeNull());
    expect(screen.getByRole("button", { name: "New Project" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Create first Project" })).toBeTruthy();
  });

  it("renders loaded Projects as an explicit list without empty-state copy", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({
      projects: [{
        id: "project-a",
        title: "A deliberately long Project title for shell hierarchy verification",
        revision: 4,
        createdAt: "2026-08-25T08:00:00.000Z",
        createdBy: "user@example.com",
        updatedAt: "2026-08-26T06:00:00.000Z",
        updatedBy: "user@example.com",
        deletedAt: null,
        deletedBy: null,
        lastOperationId: "operation-list-fixture",
      }],
    }));

    renderProjectsPage();

    const directory = await screen.findByRole("list", { name: "Active Projects" });
    expect(within(directory).getAllByRole("listitem")).toHaveLength(1);
    expect(within(directory).getByRole("link", {
      name: /A deliberately long Project title for shell hierarchy verification/,
    })).toBeTruthy();
    expect(screen.getByText("1 Project")).toBeTruthy();
    expect(screen.queryByText("No Projects yet")).toBeNull();
  });
});
