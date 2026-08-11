import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./pages/ProjectPage.tsx", import.meta.url), "utf8");
const surfaceSource = readFileSync(new URL("./components/project/ProjectMapSurface.tsx", import.meta.url), "utf8");

describe("Project Map kernel boundaries", () => {
  it("keeps React Flow behind the desktop-only lazy surface", () => {
    expect(appSource).not.toContain("@xyflow/react");
    expect(pageSource).not.toContain("@xyflow/react");
    expect(pageSource).toContain("lazy(() => import(\"../components/project/ProjectMapSurface\")");
    expect(pageSource).toContain("desktop ? <div className=\"project-desktop-workspace\"");
    expect(surfaceSource).toContain('from "@xyflow/react"');
  });

  it("keeps pointer persistence at semantic boundaries and commits keyboard position changes", () => {
    expect(surfaceSource).not.toContain("projectApi");
    expect(surfaceSource).toContain("onNodeDragStop");
    expect(surfaceSource).toContain("onResizeEnd");
    expect(surfaceSource).toContain('change.type !== "position" || change.dragging || !change.position');
    expect(surfaceSource).toContain("onGeometryCommit({ placementId, before, after });");
    expect(surfaceSource).toContain("const PROJECT_NODE_TYPES");
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
});
