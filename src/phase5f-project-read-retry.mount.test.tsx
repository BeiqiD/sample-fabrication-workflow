// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => null }));
vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: () => <div data-testid="actual-page-map">Loaded Map surface</div>,
}));
const fetchMock = vi.fn<typeof fetch>();
function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
function fixture(id = "project-a", title = "Topological laser") {
  const snapshot = projectTestSnapshot();
  snapshot.project.id = id; snapshot.project.title = title;
  for (const value of [...snapshot.contents, ...snapshot.items]) value.projectId = id;
  return snapshot;
}
function page() {
  const router = createMemoryRouter([
    { path: "/projects/:projectId", element: <ProjectPage /> },
    { path: "/projects", element: <p>Project list destination</p> },
  ], { initialEntries: ["/projects/project-a?qualification=read-retry#retained"] });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}
function assertOnlyGets() {
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
}
async function retry() {
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Project could not be loaded");
  const button = within(alert).getByRole("button", { name: "Retry loading Project" });
  fireEvent.click(button);
}
beforeAll(async () => { await import("./components/project/ProjectReadingSurface"); });
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); });

describe("Project initial read retry", () => {
  it("retries a real API-shaped initial 503 in place without any mutation or URL change", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Temporary initial Project read failure" }, 503))
      .mockResolvedValueOnce(response(fixture()));
    const { router } = page();
    await retry();
    await screen.findByRole("heading", { name: "Topological laser" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/projects/project-a", "/api/projects/project-a"]);
    expect(router.state.location.pathname).toBe("/projects/project-a");
    expect(router.state.location.search).toBe("?qualification=read-retry");
    expect(router.state.location.hash).toBe("#retained");
    assertOnlyGets();
  });

  it("hides the initial retry while its GET is pending and retains a repeated failure for another explicit action", async () => {
    let finish: ((value: Response) => void) | undefined;
    fetchMock.mockResolvedValueOnce(response({ error: "First read failed" }, 503))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response(fixture()));
    page(); await retry();
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.queryByRole("button", { name: "Retry loading Project" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { finish!(response({ error: "Second read failed" }, 503)); });
    await retry();
    await screen.findByRole("heading", { name: "Topological laser" });
    expect(fetchMock).toHaveBeenCalledTimes(3); assertOnlyGets();
  });

  it.each(["success", "failure"] as const)("ignores an obsolete retry %s after another Project owns the page", async (outcome) => {
    let finish: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(async (path) => {
      if (String(path) === "/api/projects/project-b") return response(fixture("project-b", "Project B current"));
      if (fetchMock.mock.calls.filter(([value]) => String(value) === "/api/projects/project-a").length === 1) {
        return response({ error: "A initial failure" }, 503);
      }
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const { router } = page(); await retry();
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(() => router.navigate("/projects/project-b"));
    await screen.findByRole("heading", { name: "Project B current" });
    await act(async () => { finish!(outcome === "success" ? response(fixture()) : response({ error: "Obsolete A error" }, 503)); });
    expect(screen.getByRole("heading", { name: "Project B current" })).toBeTruthy();
    expect(screen.queryByText("Obsolete A error")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Topological laser" })).toBeNull();
    expect(router.state.location.pathname).toBe("/projects/project-b"); assertOnlyGets();
  });

  it("does not publish a retry completion or launch traffic after unmount", async () => {
    let finish: ((value: Response) => void) | undefined;
    fetchMock.mockResolvedValueOnce(response({ error: "Initial read failed" }, 503))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const { view } = page(); await retry();
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.unmount();
    await act(async () => { finish!(response(fixture())); });
    expect(screen.queryByRole("heading", { name: "Topological laser" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); assertOnlyGets();
  });

  it("never offers the initial-read retry after an existing snapshot's explicit conflict reload fails", async () => {
    let reads = 0;
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return ++reads === 1 ? response(fixture()) : response({ error: "Existing-snapshot authoritative read failed" }, 503);
      if (init.method === "PATCH") return response({ error: "Markdown changed elsewhere" }, 409);
      throw new Error("Unexpected mutation");
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(await screen.findByLabelText("Reading Markdown editor"), { target: { value: "Retained conflicting draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard draft and reload" }));
    await screen.findByText("Existing-snapshot authoritative read failed");
    expect(screen.queryByRole("button", { name: "Retry loading Project" })).toBeNull();
    expect(reads).toBe(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });
});
