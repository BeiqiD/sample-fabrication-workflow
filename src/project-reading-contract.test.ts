
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("Phase 3C Reading contract", () => {
  it("projects the same occurrences in immutable creation order without a second persistence model", () => {
    const model = read("src/lib/project-map-model.ts");
    const reading = read("src/components/project/ProjectReadingSurface.tsx");
    expect(model).toContain("left.createdSequence - right.createdSequence || left.itemId.localeCompare(right.itemId)");
    expect(reading).toContain("Items follow immutable creation order");
    expect(reading).not.toContain("projectApi");
    expect(reading).not.toContain("created_sequence");
  });

  it("keeps Reading creation-free while allowing only existing owned-content edits", () => {
    const reading = read("src/components/project/ProjectReadingSurface.tsx");
    const page = read("src/pages/ProjectPage.tsx");
    expect(reading).toContain("Edit Markdown");
    expect(reading).toContain("Edit attachment metadata");
    expect(reading).toContain("Open reference");
    expect(reading).not.toContain("Add attachment");
    expect(reading).not.toContain("onMarkdownCreateRequest");
    expect(reading).not.toContain("Remove from Project");
    expect(page).toContain('desktopView === "map" ? <>');
    expect(page).toContain("<ProjectReadingSurface");
  });

  it("renders full owned content while leaving rich Markdown/TeX rendering to Phase 3D", () => {
    const reading = read("src/components/project/ProjectReadingSurface.tsx");
    const plan = read("docs/PROJECT_READING_IMPLEMENTATION_PLAN.md");
    expect(reading).toContain('className="project-reading-markdown-source"');
    expect(reading).toContain("node.markdownSource || \"\"");
    expect(reading).toContain("node.attachmentCaption");
    expect(plan).toContain("Rich CommonMark/GFM and TeX rendering remains Phase 3D");
  });

  it("keeps responsive projection changes behind the same unresolved-operation guard", () => {
    const page = read("src/pages/ProjectPage.tsx");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(page).toContain("if (lockCheckRef.current()) return;");
    expect(page).toContain("const viewSwitchDisabled = projectionSwitchLocked;");
    expect(page).toContain("setDesktop(window.matchMedia(query).matches)");
    expect(pkg.scripts["test:project-reading-mounted"]).toContain("src/project-responsive-projection-safety.mount.test.tsx");
  });

  it("keeps the Map double-click regression fix folded into the Phase 3C branch", () => {
    const map = read("src/components/project/ProjectMapSurface.tsx");
    const surfaceTest = read("src/project-map-surface.mount.test.tsx");
    expect(map).toContain("zoomOnDoubleClick={false}");
    expect(surfaceTest).toContain("reserves empty-pane double click for Markdown creation instead of viewport zoom");
  });
});
