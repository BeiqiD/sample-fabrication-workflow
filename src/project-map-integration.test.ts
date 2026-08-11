import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("./pages/ProjectWorkspacePage.tsx", import.meta.url), "utf8");
const editor = readFileSync(new URL("./components/project/ProjectMapEditor.tsx", import.meta.url), "utf8");
const packageConfiguration = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
const verifyWorkflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
const workflowNames = readdirSync(new URL("../.github/workflows", import.meta.url));
const packageLock = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");
const roadmap = readFileSync(new URL("../docs/PRODUCT_ROADMAP.md", import.meta.url), "utf8");

describe("Phase 3B1 Project Map integration", () => {
  it("replaces the temporary Search destination with Project list/open routes", () => {
    expect(app).toContain('{ to: "/projects", label: "Projects", icon: "projects" }');
    expect(app).toContain('<Route path="/projects" element={<ProjectsPage />} />');
    expect(app).toContain('<Route path="/projects/:projectId" element={<ProjectWorkspacePage />} />');
    expect(app).not.toContain('{ to: "/search", label: "Search"');
    expect(app).not.toContain('<Route path="/search"');
  });

  it("keeps React Flow behind the desktop-only lazy Project Map boundary", () => {
    expect(workspace).toContain('const ProjectMapEditor = lazy(() => import("../components/project/ProjectMapEditor")');
    expect(workspace).toContain('const DESKTOP_MAP_QUERY = "(min-width: 901px)";');
    expect(workspace).toMatch(/desktop \? <Suspense[\s\S]*?<ProjectMapEditor/);
    expect(editor).toContain('from "@xyflow/react"');
    expect(packageConfiguration.dependencies?.["@xyflow/react"]).toBe("^12.11.2");
    expect(packageLock).toContain('"node_modules/@xyflow/react"');
  });

  it("keeps placement writes at semantic flush boundaries and leaves later creation APIs out", () => {
    expect(editor).toContain("onNodeDragStop={onNodeDragStop}");
    expect(editor).toContain("onResizeEnd={(_event, params) => data.onResizeEnd(id, params)}");
    expect(editor).toContain("projectApi.updatePlacement(");
    expect(editor).not.toMatch(/onNodeDrag\s*=.*projectApi\.updatePlacement/s);
    expect(editor).not.toMatch(/onResize\s*=.*projectApi\.updatePlacement/s);
    expect(editor).not.toMatch(/createReferenceProjectItem|createMarkdownProjectItem|createAttachmentProjectItem|createProjectEdge|onConnect|addEdge/);
  });

  it("adds a permanent Project Map CI context and deployment gate", () => {
    expect(packageConfiguration.scripts?.["verify:project-map"]).toBe("npm run test:project-map");
    expect(packageConfiguration.scripts?.["verify:v3-deployment"]).toContain("npm run verify:project-map");
    expect(verifyWorkflow).toContain("Run Project Map contract");
    expect(verifyWorkflow).toContain('context: "pre-pr/project-map"');
    expect(verifyWorkflow).not.toMatch(/contents:\s*write/);
    expect(workflowNames).toEqual(["verify.yml"]);
    expect(verifyWorkflow).not.toMatch(/filebin|curl .*patch|git push/s);
    expect(roadmap).toContain("Phase 3B1");
  });
});
