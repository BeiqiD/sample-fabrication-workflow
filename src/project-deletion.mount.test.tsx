
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => <div /> }));
vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((_props, ref) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      return <div>Project Map fixture</div>;
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

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }, {
    path: "/projects",
    element: <div>Projects destination</div>,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("Project lifecycle UI", () => {
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

  it("moves a Project to trash and exact-retries the same lifecycle request after an uncertain outcome", async () => {
    const snapshot = projectTestSnapshot();
    let deleteCount = 0;
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === "/api/projects/project-a" && init?.method === "DELETE") {
        deleteCount += 1;
        if (deleteCount === 1) return jsonResponse({ error: "Temporary Project deletion failure" }, 503);
        return jsonResponse({
          project: {
            ...snapshot.project,
            revision: snapshot.project.revision + 1,
            deletedAt: "2026-08-14T08:00:00.000Z",
            deletedBy: "user@example.com",
          },
          replayed: true,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Project Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    expect(await screen.findByRole("alertdialog", { name: "Move Project to trash" })).toBeTruthy();
    expect(screen.getByText(/can be restored later/)).toBeTruthy();
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Type the Project title to confirm"), {
      target: { value: snapshot.project.title },
    });
    const dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    expect(await screen.findByText("Temporary Project deletion failure")).toBeTruthy();
    const firstDelete = fetchMock.mock.calls[1];
    expect(firstDelete[0]).toBe("/api/projects/project-a");
    expect(firstDelete[1]?.method).toBe("DELETE");
    const firstBody = JSON.parse(String(firstDelete[1]?.body));
    expect(firstBody.expectedRevision).toBe(snapshot.project.revision);
    expect(firstBody.operationId).toMatch(/^operation-/);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry exact move" }));
    await screen.findByText("Projects destination");
    const secondBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(secondBody).toEqual(firstBody);
  });
});
