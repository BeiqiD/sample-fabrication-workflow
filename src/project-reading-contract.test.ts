import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("Phase 3C/3D Reading contract", () => {
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
    expect(page).toContain('lazy(() => import("../components/project/ProjectReadingSurface")');
    expect(page).not.toContain('import { ProjectReadingSurface } from');
  });

  it("renders complete Markdown/GFM and TeX through the shared safe renderer", () => {
    const reading = read("src/components/project/ProjectReadingSurface.tsx");
    const renderer = read("src/lib/rich-text.ts");
    const compatibility = read("src/lib/project-markdown.ts");
    const component = read("src/components/project/ProjectMarkdown.tsx");
    const sharedComponent = read("src/components/RichText.tsx");
    expect(reading).toContain("<ProjectMarkdown source={node.markdownSource || \"\"}");
    expect(renderer).toContain("new Marked");
    expect(renderer).toContain("Temml.renderToString");
    expect(renderer).toContain("maxSize: [20, 200]");
    expect(renderer).toContain("renderer.html = ({ text }) => escapeRichTextHtml(text)");
    expect(compatibility).toContain('renderRichText(source, "document")');
    expect(component).toContain('<RichText');
    expect(sharedComponent).toContain("dangerouslySetInnerHTML");
    expect(component).not.toContain("projectApi");
  });

  it("loads the editor only for the active Markdown block and retains exact retry semantics", () => {
    const reading = read("src/components/project/ProjectReadingSurface.tsx");
    const editor = read("src/components/project/ProjectMarkdownEditor.tsx");
    expect(reading).toContain('lazy(() => import("./ProjectMarkdownEditor"))');
    expect(reading).toContain("<Suspense");
    expect(editor).toContain("Retry exact save");
    expect(editor).toContain('editor.status !== "saving" && editor.status !== "uncertain"');
    expect(editor).not.toContain("projectApi");
  });

  it("builds human-readable export from the current Reading descriptors without a server export model", () => {
    const reading = read("src/components/project/ProjectReadingSurface.tsx");
    const exportModule = read("src/lib/project-readable-export.ts");
    expect(reading).toContain("buildProjectReadableArchive(nodes");
    expect(exportModule).toContain('zip.file("reading.md"');
    expect(exportModule).toContain('zip.file("manifest.json"');
    expect(exportModule).toContain("relativeAttachmentPath");
    expect(exportModule).toContain("markdownRelativePath");
    expect(exportModule).toContain("credentials: \"same-origin\"");
    expect(exportModule).not.toContain("projectApi");
  });

  it("keeps responsive projection changes behind the same unresolved-operation guard", () => {
    const page = read("src/pages/ProjectPage.tsx");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(page).toContain("if (lockCheckRef.current()) return;");
    expect(page).toContain("const viewSwitchDisabled = projectionSwitchLocked;");
    expect(page).toContain("setDesktop(window.matchMedia(query).matches)");
    expect(pkg.scripts["test:project-reading-mounted"]).toContain("src/project-responsive-projection-safety.mount.test.tsx");
  });

  it("keeps the Map double-click regression fix folded into the Reading branch", () => {
    const map = read("src/components/project/ProjectMapSurface.tsx");
    const surfaceTest = read("src/project-map-surface.mount.test.tsx");
    expect(map).toContain("zoomOnDoubleClick={false}");
    expect(surfaceTest).toContain("reserves empty-pane double click for Markdown creation instead of viewport zoom");
  });
});
