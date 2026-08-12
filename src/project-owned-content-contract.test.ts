import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Phase 3B3 Project-owned content contract", () => {
  it("keeps new Markdown renderer-local until an explicit save starts the authoritative create", () => {
    const page = read("./pages/ProjectPage.tsx");
    const map = read("./components/project/ProjectMapSurface.tsx");
    expect(map).toContain("onMarkdownCreateRequest(point)");
    expect(map).toContain('aria-label={markdownEditor.isNew ? "New Project Markdown"');
    expect(page).toContain("projectMarkdownGeometryAtPoint");
    expect(page).toContain("markdownCreateInputRef.current = null");
    expect(page).toContain("projectApi.createMarkdownItem(projectId, input)");
    expect(page.indexOf("projectApi.createMarkdownItem(projectId, input)")).toBeGreaterThan(page.indexOf("const saveMarkdown"));
  });

  it("uploads generic files first and then creates one authoritative Project attachment occurrence", () => {
    const page = read("./pages/ProjectPage.tsx");
    const client = read("./lib/project-client.ts");
    expect(client).toContain('uploadAttachmentAsset: (file: File)');
    expect(client).toContain('"/assets"');
    expect(client).toContain('/items/attachment`');
    expect(page).toContain("const asset = await projectApi.uploadAttachmentAsset(file)");
    expect(page).toContain("locator: { assetId: asset.id }");
    expect(page).toContain("await performAttachmentProjectCreate(generation, input, file)");
  });

  it("freezes editable payloads after the first request so retries preserve mutation identity", () => {
    const page = read("./pages/ProjectPage.tsx");
    const map = read("./components/project/ProjectMapSurface.tsx");
    expect(page).toContain("markdownCreateInputRef.current");
    expect(page).toContain("markdownUpdateInputRef.current");
    expect(page).toContain("pendingAttachmentInputRef.current");
    expect(page).toContain("attachmentUpdateInputRef.current");
    expect(map).toContain('disabled={markdownEditor.status !== "editing"}');
    expect(page).toContain('disabled={attachmentEditor.status !== "editing"}');
  });

  it("uses MIME identity for image rendering and keeps source attachments on the reference path", () => {
    const page = read("./pages/ProjectPage.tsx");
    const map = read("./components/project/ProjectMapSurface.tsx");
    const model = read("./lib/project-map-model.ts");
    expect(map).toContain("projectAttachmentIsImage(descriptor.mimeType)");
    expect(map).toContain('className="project-node-image"');
    expect(page).toContain("projectAttachmentIsImage(node.mimeType)");
    expect(model).toContain("attachmentCaption");
    expect(page).toContain("<ReferenceSearchSurface");
    expect(page).not.toContain("sourceAttachmentId");
  });

  it("keeps Project-owned content creation desktop-only and leaves edges for Phase 3B4", () => {
    const page = read("./pages/ProjectPage.tsx");
    const map = read("./components/project/ProjectMapSurface.tsx");
    const desktopBranch = page.indexOf('{desktop ? <div className="project-desktop-workspace with-reference-sidebar">');
    const mobileBranch = page.indexOf(': <section className="project-mobile-reading"', desktopBranch);
    expect(desktopBranch).toBeGreaterThan(-1);
    expect(mobileBranch).toBeGreaterThan(desktopBranch);
    const mobile = page.slice(mobileBranch);
    expect(mobile).not.toContain("Add attachment");
    expect(mobile).not.toContain("New Project Markdown");
    expect(map).toContain("const PROJECT_EDGES: [] = []");
    expect(page).not.toContain("createProjectEdge");
  });
});
