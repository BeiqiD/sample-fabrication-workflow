
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  return { router, view: render(<RouterProvider router={router} />) };
}

function openProjectActions() {
  const trigger = screen.getByRole("button", { name: "Project actions" });
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  return screen.getByRole("button", { name: "Move to trash" });
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

  it("owns the desktop Map viewport and releases document scrolling for Reading", async () => {
    const snapshot = projectTestSnapshot();
    fetchMock.mockImplementationOnce(() => jsonResponse(snapshot));

    const { view } = renderProjectPage();
    await screen.findByText("Project Map fixture");

    const page = document.querySelector(".project-page");
    const header = document.querySelector(".project-workspace-header");
    expect(page?.classList.contains("desktop")).toBe(true);
    expect(page?.classList.contains("map")).toBe(true);
    expect(document.documentElement.classList.contains("project-map-viewport")).toBe(true);
    expect(header).toBeTruthy();
    expect(within(header as HTMLElement).getByRole("heading", {
      level: 1,
      name: snapshot.project.title,
    }).getAttribute("title")).toBe(snapshot.project.title);
    expect(within(header as HTMLElement).queryByText("Project workspace")).toBeNull();

    const projectActions = screen.getByRole("button", { name: "Project actions" });
    expect(projectActions.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Move to trash" })).toBeNull();
    fireEvent.click(projectActions);
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(projectActions.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Move to trash" })).toBeNull();
    expect(document.activeElement).toBe(projectActions);

    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    await waitFor(() => {
      expect(page?.classList.contains("reading")).toBe(true);
      expect(document.documentElement.classList.contains("project-map-viewport")).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    await waitFor(() => {
      expect(page?.classList.contains("map")).toBe(true);
      expect(document.documentElement.classList.contains("project-map-viewport")).toBe(true);
    });

    view.unmount();
    expect(document.documentElement.classList.contains("project-map-viewport")).toBe(false);
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
    fireEvent.click(openProjectActions());
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

  it("requires a fresh title confirmation and lifecycle identity after a deletion conflict", async () => {
    const initial = projectTestSnapshot();
    const refreshed = projectTestSnapshot();
    refreshed.project = {
      ...refreshed.project,
      revision: initial.project.revision + 1,
      updatedAt: "2026-08-14T09:40:00.000Z",
    };
    let readCount = 0;
    const deleteInputs: Array<{ expectedRevision: number; operationId: string }> = [];

    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) {
        readCount += 1;
        return jsonResponse(readCount === 1 ? initial : refreshed);
      }
      if (String(path) === "/api/projects/project-a" && init?.method === "DELETE") {
        const input = JSON.parse(String(init.body)) as { expectedRevision: number; operationId: string };
        deleteInputs.push(input);
        if (deleteInputs.length === 1) return jsonResponse({ error: "Project revision conflict" }, 409);
        return jsonResponse({
          project: {
            ...refreshed.project,
            revision: refreshed.project.revision + 1,
            deletedAt: "2026-08-14T09:45:00.000Z",
            deletedBy: "user@example.com",
          },
          replayed: false,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Project Map fixture");
    fireEvent.click(openProjectActions());
    fireEvent.change(screen.getByLabelText("Type the Project title to confirm"), {
      target: { value: initial.project.title },
    });
    let dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    expect(await screen.findByText(/latest authoritative state has been reloaded/)).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByLabelText("Type the Project title to confirm") as HTMLInputElement).value).toBe("");
    });
    dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    expect(within(dialog).getByRole("button", { name: "Move to trash" }).hasAttribute("disabled")).toBe(true);
    expect(deleteInputs).toHaveLength(1);
    expect(deleteInputs[0].expectedRevision).toBe(initial.project.revision);

    fireEvent.change(screen.getByLabelText("Type the Project title to confirm"), {
      target: { value: refreshed.project.title },
    });
    dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    const freshConfirm = within(dialog).getByRole("button", { name: "Move to trash" });
    expect(freshConfirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(freshConfirm);

    await screen.findByText("Projects destination");
    expect(deleteInputs).toHaveLength(2);
    expect(deleteInputs[1].expectedRevision).toBe(refreshed.project.revision);
    expect(deleteInputs[1].operationId).not.toBe(deleteInputs[0].operationId);
  });


  it("does not carry a deterministic deletion request across Project route identities", async () => {
    const projectA = projectTestSnapshot();
    const projectB = projectTestSnapshot();
    projectB.project = {
      ...projectB.project,
      id: "project-b",
      title: projectA.project.title,
      revision: projectA.project.revision,
      updatedAt: "2026-08-14T10:00:00.000Z",
    };
    projectB.contents = projectB.contents.map((content) => ({ ...content, projectId: "project-b" }));
    projectB.items = projectB.items.map((item) => ({ ...item, projectId: "project-b" }));

    const deletionCalls: Array<{
      projectId: string;
      expectedRevision: number;
      operationId: string;
    }> = [];
    let projectBReads = 0;

    fetchMock.mockImplementation((path, init) => {
      const url = String(path);
      if (url === "/api/projects/project-a" && !init?.method) return jsonResponse(projectA);
      if (url === "/api/projects/project-b" && !init?.method) {
        projectBReads += 1;
        return jsonResponse(projectB);
      }
      if ((url === "/api/projects/project-a" || url === "/api/projects/project-b") && init?.method === "DELETE") {
        const input = JSON.parse(String(init.body)) as { expectedRevision: number; operationId: string };
        const targetProjectId = url.endsWith("project-a") ? "project-a" : "project-b";
        deletionCalls.push({ projectId: targetProjectId, ...input });
        if (targetProjectId === "project-a") {
          return jsonResponse({ error: "Project deletion rejected" }, 400);
        }
        return jsonResponse({
          project: {
            ...projectB.project,
            revision: projectB.project.revision + 1,
            deletedAt: "2026-08-14T10:05:00.000Z",
            deletedBy: "user@example.com",
          },
          replayed: false,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${url}` }, 500);
    });

    const { router } = renderProjectPage();
    await screen.findByText("Project Map fixture");
    fireEvent.click(openProjectActions());
    fireEvent.change(screen.getByLabelText("Type the Project title to confirm"), {
      target: { value: projectA.project.title },
    });
    let dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    expect(await screen.findByText("Project deletion rejected")).toBeTruthy();
    expect(deletionCalls).toHaveLength(1);
    expect(deletionCalls[0]).toMatchObject({
      projectId: "project-a",
      expectedRevision: projectA.project.revision,
    });
    const projectAOperationId = deletionCalls[0].operationId;
    expect((screen.getByLabelText("Type the Project title to confirm") as HTMLInputElement).value)
      .toBe(projectA.project.title);

    await act(async () => {
      await router.navigate("/projects/project-b");
    });
    await waitFor(() => expect(projectBReads).toBeGreaterThan(0));
    await screen.findByText("Project Map fixture");
    expect(screen.queryByRole("alertdialog", { name: "Move Project to trash" })).toBeNull();
    expect(deletionCalls).toHaveLength(1);

    fireEvent.click(openProjectActions());
    dialog = await screen.findByRole("alertdialog", { name: "Move Project to trash" });
    const confirmation = screen.getByLabelText("Type the Project title to confirm") as HTMLInputElement;
    expect(confirmation.value).toBe("");
    fireEvent.change(confirmation, { target: { value: projectB.project.title } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    await screen.findByText("Projects destination");
    expect(deletionCalls).toHaveLength(2);
    expect(deletionCalls[1]).toMatchObject({
      projectId: "project-b",
      expectedRevision: projectB.project.revision,
    });
    expect(deletionCalls[1].operationId).not.toBe(projectAOperationId);
  });

});
