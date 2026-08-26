import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./pages/ProjectPage.tsx", import.meta.url), "utf8");
const projectsPageSource = readFileSync(new URL("./pages/ProjectsPage.tsx", import.meta.url), "utf8");
const projectStyles = readFileSync(new URL("./project.css", import.meta.url), "utf8");
const surfaceSource = readFileSync(new URL("./components/project/ProjectMapSurface.tsx", import.meta.url), "utf8");
const performanceSource = readFileSync(new URL("./lib/project-map-performance.ts", import.meta.url), "utf8");

describe("Project Map kernel boundaries", () => {
  it("keeps React Flow behind the desktop-only lazy surface", () => {
    expect(appSource).not.toContain("@xyflow/react");
    expect(pageSource).not.toContain("@xyflow/react");
    expect(pageSource).toContain("lazy(() => import(\"../components/project/ProjectMapSurface\")");
    expect(pageSource).toContain('{desktop ? <div className="project-desktop-workspace');
    expect(surfaceSource).toContain('from "@xyflow/react"');
  });

  it("keeps pointer persistence at semantic boundaries and commits keyboard position changes", () => {
    expect(surfaceSource).not.toContain("projectApi");
    expect(surfaceSource).toContain("onNodeDragStop");
    expect(surfaceSource).toContain("onResizeEnd");
    expect(surfaceSource).toContain('change.type !== "position" || change.dragging || !change.position');
    expect(surfaceSource).toContain("onGeometryCommit({ placementId: descriptor.placementId, before, after });");
    expect(surfaceSource).toContain("emitGeometryCommands(commands);");
    expect(surfaceSource).toContain("onGeometryBatchCommit");
    expect(surfaceSource).toContain("const PROJECT_NODE_TYPES");
  });

  it("keeps Phase 4B3 assistance transient and reuses normalized placement commands", () => {
    expect(surfaceSource).toContain("projectCanvasAlignmentGuides");
    expect(surfaceSource).toContain("onNodeDrag={handleNodeDrag}");
    expect(surfaceSource).toContain("<ViewportPortal>");
    expect(surfaceSource).toContain("elevateNodesOnSelect={false}");
    expect(pageSource).toContain("projectCanvasAlignmentCommands");
    expect(pageSource).toContain("projectCanvasZOrderCommands");
    expect(pageSource).toContain("commitGeometryBatch(projectCanvasAlignmentCommands");
    expect(pageSource).toContain("commitGeometryBatch(projectCanvasZOrderCommands");
  });

  it("keeps Phase 4C performance adaptive rather than changing persistence", () => {
    expect(surfaceSource).toContain("memo(function ProjectItemNode");
    expect(surfaceSource).toContain("onMove={handleViewportMove}");
    expect(surfaceSource).toContain("onlyRenderVisibleElements={performancePolicy.onlyRenderVisibleElements}");
    expect(surfaceSource).toContain('detailLevel === "full"');
    expect(surfaceSource).toContain("contextual-hidden");
    expect(surfaceSource).not.toContain("projectApi");
    expect(performanceSource).toContain("PROJECT_MAP_TARGET_NODE_COUNT = 200");
    expect(performanceSource).toContain("PROJECT_MAP_ENVELOPE_NODE_COUNT = 500");
    expect(performanceSource).toContain("PROJECT_MAP_ENVELOPE_EDGE_COUNT = 800");
  });

  it("protects dirty Project placement state across SPA and hard navigation", () => {
    expect(mainSource).toContain("createBrowserRouter");
    expect(mainSource).toContain("<RouterProvider router={router} />");
    expect(pageSource).toContain("useBlocker(shouldBlockNavigation)");
    expect(pageSource).toContain("useBeforeUnload(");
    expect(pageSource).toContain("navigationSaveRequestedRef");
    expect(pageSource).toContain("Retry save and leave");
    expect(pageSource).toContain("Leave without saving");
  });

  it("keeps Phase 5A1 directory states and shell geometry explicit", () => {
    expect(projectsPageSource).toContain('type ProjectDirectoryState = "loading" | "ready" | "error"');
    expect(projectsPageSource).toContain("const [loadError, setLoadError]");
    expect(projectsPageSource).toContain("const [createError, setCreateError]");
    expect(projectsPageSource).toContain("Projects could not be loaded");
    expect(projectsPageSource).toContain("Retry loading Projects");
    expect(projectsPageSource).not.toContain("<EmptyState");
    expect(projectStyles).toMatch(/\.project-workspace-header\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(projectStyles).toMatch(/\.project-view-toggle\s*\{[^}]*background:\s*var\(--surface-warm\);/s);
    expect(projectStyles).toMatch(/\.project-save-state\s*\{[^}]*border-radius:\s*999px;/s);
    expect(projectStyles).toContain("@media (max-width: 1180px) and (min-width: 860px)");
    expect(projectStyles).toContain("@media (max-width: 859px)");
    expect(projectStyles).toContain("@media (max-width: 560px)");
    expect(projectStyles).not.toContain("@media (max-width: 1200px)");
    expect(projectStyles).not.toContain("@media (max-width: 720px)");
  });
});
