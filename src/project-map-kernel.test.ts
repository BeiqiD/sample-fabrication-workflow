import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
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

  it("keeps persistence outside pointer-frame callbacks and at semantic boundaries", () => {
    expect(surfaceSource).not.toContain("projectApi");
    expect(surfaceSource).toContain("onNodeDragStop");
    expect(surfaceSource).toContain("onResizeEnd");
    expect(surfaceSource).toContain("const PROJECT_NODE_TYPES");
  });
});
