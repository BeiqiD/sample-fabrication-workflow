// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => null,
}));

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: ({
    nodes,
    onGeometryCommit,
  }: {
    nodes: ProjectNodeDescriptor[];
    onGeometryCommit: (command: ProjectGeometryCommand) => void;
  }) => <button type="button" onClick={() => {
    const node = nodes.find((candidate) => candidate.placementId === "placement-note")!;
    onGeometryCommit({
      placementId: node.placementId,
      before: node.geometry,
      after: { ...node.geometry, x: node.geometry.x + 80 },
    });
  }}>Simulate semantic move</button>,
}));

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

function placementResponse(revision = 2, x?: number) {
  const placement = projectTestSnapshot().placements.find((candidate) => candidate.id === "placement-note")!;
  return {
    value: { ...placement, x: x ?? placement.x + 80, revision },
    replayed: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }, {
    path: "/projects",
    element: <p>Projects route</p>,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("mounted desktop Project Map save behavior", () => {
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

  it("persists one compact placement mutation after a semantic interaction", async () => {
    fetchMock.mockImplementation((_path, init) => Promise.resolve(new Response(JSON.stringify(
      init?.method === "PATCH" ? placementResponse() : projectTestSnapshot(),
    ), { status: 200, headers: { "content-type": "application/json" } })));

    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    expect(screen.getByText("Unsaved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [path, init] = fetchMock.mock.calls[1];
    expect(path).toBe("/api/projects/project-a/placements/placement-note");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      geometry: { x: 100, y: 40, width: 250, height: 180, zIndex: 0 },
      expectedRevision: 1,
    });
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("autosaves once after the bounded idle interval", async () => {
    fetchMock.mockImplementation((_path, init) => Promise.resolve(new Response(JSON.stringify(
      init?.method === "PATCH" ? placementResponse() : projectTestSnapshot(),
    ), { status: 200, headers: { "content-type": "application/json" } })));

    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    expect(screen.getByText("Unsaved")).toBeTruthy();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2_500 });
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("replays the exact mutation identity after an uncertain failure", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Temporary save failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(placementResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Temporary save failure")).toBeTruthy();

    const firstAttempt = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const replay = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(replay).toEqual(firstAttempt);
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("keeps failed geometry visible and requires an authoritative reload after 409", async () => {
    fetchMock.mockImplementation((_path, init) => Promise.resolve(new Response(JSON.stringify(
      init?.method === "PATCH"
        ? { error: "Placement revision conflict" }
        : projectTestSnapshot(),
    ), {
      status: init?.method === "PATCH" ? 409 : 200,
      headers: { "content-type": "application/json" },
    })));

    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Placement revision conflict")).toBeTruthy();
    expect(screen.getByText("Conflict")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload authoritative Project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("flushes unsaved placement changes before internal navigation proceeds", async () => {
    fetchMock.mockImplementation((_path, init) => Promise.resolve(new Response(JSON.stringify(
      init?.method === "PATCH" ? placementResponse() : projectTestSnapshot(),
    ), { status: 200, headers: { "content-type": "application/json" } })));

    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    fireEvent.click(screen.getByRole("link", { name: "← Projects" }));

    expect(screen.queryByText("Projects route")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
    expect(await screen.findByText("Projects route")).toBeTruthy();
  });

  it("drains in-flight geometry before navigation and never offers discard while the save can still succeed", async () => {
    const firstPatch = deferred<Response>();
    let patchCount = 0;
    fetchMock.mockImplementation((_path, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify(projectTestSnapshot()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      patchCount += 1;
      if (patchCount === 1) return firstPatch.promise;
      return Promise.resolve(new Response(JSON.stringify(placementResponse(3, 180)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });

    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    fireEvent.click(screen.getByRole("link", { name: "← Projects" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Leave without saving" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Simulate semantic move" }));
    expect(screen.queryByRole("button", { name: "Leave without saving" })).toBeNull();

    firstPatch.resolve(new Response(JSON.stringify(placementResponse(2, 100)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const secondMutation = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(secondMutation).toMatchObject({
      geometry: { x: 180, y: 40, width: 250, height: 180, zIndex: 0 },
      expectedRevision: 2,
    });
    expect(await screen.findByText("Projects route")).toBeTruthy();

    const callsAfterNavigation = fetchMock.mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 1_750));
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterNavigation);
  });

  it("invalidates a stale save session so an in-flight result cannot schedule writes after unmount", async () => {
    const firstPatch = deferred<Response>();
    let patchCount = 0;
    fetchMock.mockImplementation((_path, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify(projectTestSnapshot()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      patchCount += 1;
      if (patchCount === 1) {
        return firstPatch.promise;
      }
      return Promise.resolve(new Response(JSON.stringify(placementResponse(3, 180)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });

    const mounted = renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Simulate semantic move" }));
    mounted.unmount();

    firstPatch.resolve(new Response(JSON.stringify(placementResponse(2, 100)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 1_750));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("protects refresh or close while placement changes are not safely saved", async () => {
    fetchMock.mockImplementation((_path, init) => Promise.resolve(new Response(JSON.stringify(
      init?.method === "PATCH" ? placementResponse() : projectTestSnapshot(),
    ), { status: 200, headers: { "content-type": "application/json" } })));

    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    const unsavedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unsavedUnload);
    expect(unsavedUnload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const savedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedUnload);
    expect(savedUnload.defaultPrevented).toBe(false);
  });

  it("keeps internal navigation blocked after a save error until retry succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Temporary save failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(placementResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    fireEvent.click(screen.getByRole("link", { name: "← Projects" }));

    expect(await screen.findByText("Temporary save failure")).toBeTruthy();
    expect(screen.queryByText("Projects route")).toBeNull();
    expect(screen.getByRole("alertdialog", { name: "Unsaved Project changes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry save and leave" }));
    expect(await screen.findByText("Projects route")).toBeTruthy();
  });

  it("keeps internal navigation blocked on conflict until the user explicitly discards local placement changes", async () => {
    fetchMock.mockImplementation((_path, init) => Promise.resolve(new Response(JSON.stringify(
      init?.method === "PATCH"
        ? { error: "Placement revision conflict" }
        : projectTestSnapshot(),
    ), {
      status: init?.method === "PATCH" ? 409 : 200,
      headers: { "content-type": "application/json" },
    })));

    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate semantic move" }));
    fireEvent.click(screen.getByRole("link", { name: "← Projects" }));

    expect(await screen.findByText("Placement revision conflict")).toBeTruthy();
    expect(screen.queryByText("Projects route")).toBeNull();
    expect(screen.getByRole("alertdialog", { name: "Unsaved Project changes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByText("Projects route")).toBeTruthy();
  });
});
