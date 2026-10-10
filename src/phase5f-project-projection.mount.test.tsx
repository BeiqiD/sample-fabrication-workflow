import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import { projectMapNodes, projectReadingNodes } from "./lib/project-map-model";
import { projectApi } from "./lib/project-client";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshotWithAttachment } from "./project-test-fixture";

const projections = vi.hoisted(() => ({
  map: [] as ProjectNodeDescriptor[],
  reading: [] as ProjectNodeDescriptor[],
}));

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => null }));
vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: ({ nodes, onGeometryCommit }: {
    nodes: ProjectNodeDescriptor[];
    onGeometryCommit: (command: ProjectGeometryCommand) => void;
  }) => {
    projections.map = nodes;
    return <button type="button" onClick={() => {
      const node = nodes.find((candidate) => candidate.itemId === "item-note")!;
      onGeometryCommit({ placementId: node.placementId, before: node.geometry,
        after: { ...node.geometry, x: node.geometry.x + 80 } });
    }}>Move the projected note</button>;
  },
}));
vi.mock("./components/project/ProjectReadingSurface", () => ({
  ProjectReadingSurface: ({ nodes }: { nodes: ProjectNodeDescriptor[] }) => {
    projections.reading = nodes;
    return <section aria-label="Projected Reading">
      {nodes.map((node) => <p key={node.itemId}>{node.title}: {node.geometry.x}</p>)}
    </section>;
  },
}));

const routers: ReturnType<typeof createMemoryRouter>[] = [];
function mountProject() {
  const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }],
    { initialEntries: ["/projects/project-a"] });
  routers.push(router);
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  projections.map = [];
  projections.reading = [];
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async (path) => { throw new Error(`Unexpected request ${path}`); }));
});
afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Phase 5F shared Project projections", () => {
  it("formats source content once per snapshot and reuses it across working geometry changes", async () => {
    const snapshot = projectTestSnapshotWithAttachment();
    const content = snapshot.contents.find((entry) => entry.id === "content-note")!;
    const source = content.markdownSource;
    let sourceReads = 0;
    Object.defineProperty(content, "markdownSource", { enumerable: true, get: () => {
      sourceReads += 1;
      return source;
    } });
    projectMapNodes(snapshot);
    const readsPerCanonicalProjection = sourceReads;
    sourceReads = 0;
    const read = vi.spyOn(projectApi, "read").mockResolvedValue(snapshot);
    mountProject();

    const move = await screen.findByRole("button", { name: "Move the projected note" });
    expect(sourceReads).toBe(readsPerCanonicalProjection);
    fireEvent.click(move);
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(projections.map.find((node) => node.itemId === "item-note")?.geometry.x).toBe(100);
    expect(sourceReads).toBe(readsPerCanonicalProjection);
    expect(screen.getByRole("button", { name: "Reading" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(projections.map.find((node) => node.itemId === "item-note")?.geometry.x).toBe(20);
    expect(sourceReads).toBe(readsPerCanonicalProjection);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    await screen.findByRole("region", { name: "Projected Reading" });
    expect(sourceReads).toBe(readsPerCanonicalProjection);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shares full descriptor values and exact working geometry without changing Map or Reading order", async () => {
    const snapshot = projectTestSnapshotWithAttachment();
    const expectedMap = projectMapNodes(snapshot);
    const expectedReading = projectReadingNodes(snapshot);
    vi.spyOn(projectApi, "read").mockResolvedValue(snapshot);
    const update = vi.spyOn(projectApi, "updatePlacement").mockImplementation(async (_projectId, placementId, input) => ({
      value: { ...snapshot.placements.find((placement) => placement.id === placementId)!,
        ...input.geometry, revision: input.expectedRevision + 1 },
      replayed: false,
    }));
    mountProject();
    fireEvent.click(await screen.findByRole("button", { name: "Move the projected note" }));
    const overlay = (nodes: ProjectNodeDescriptor[]) => nodes.map((node) => node.itemId === "item-note"
      ? { ...node, geometry: { ...node.geometry, x: 100 } } : node);
    expect(projections.map).toEqual(overlay(expectedMap));
    expect(screen.getByRole("button", { name: "Reading" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    expect(update).toHaveBeenCalledTimes(1);
    const mapNodes = projections.map;
    const mapOrder = mapNodes.map((node) => node.itemId);
    const movedGeometry = mapNodes.find((node) => node.itemId === "item-note")!.geometry;

    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    await screen.findByRole("region", { name: "Projected Reading" });
    expect(projections.reading).toEqual(overlay(expectedReading));
    expect(projections.reading.every((node) => mapNodes.includes(node))).toBe(true);
    expect(projections.reading.find((node) => node.itemId === "item-note")!.geometry).toBe(movedGeometry);
    expect(mapNodes.map((node) => node.itemId)).toEqual(mapOrder);

    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    await screen.findByRole("button", { name: "Move the projected note" });
    expect(projections.map).toBe(mapNodes);
    expect(projections.map).toEqual(overlay(expectedMap));
  });
});
