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

  it("only lets Escape cancel an empty new Markdown draft", () => {
    const map = read("./components/project/ProjectMapSurface.tsx");
    expect(map).toContain('if (event.key !== "Escape") return;');
    expect(map).toContain("if (markdownEditor.isNew && !markdownEditor.value.trim()) data.onMarkdownCancel()");
    expect(map).not.toContain("if (!markdownEditor.isNew || !markdownEditor.value.trim()) data.onMarkdownCancel()");
  });

  it("uploads generic files through the Project asset route before creating one authoritative occurrence", () => {
    const page = read("./pages/ProjectPage.tsx");
    const client = read("./lib/project-client.ts");
    const foundation = read("../worker/project-foundation-routes.ts");
    expect(client).toContain('uploadAttachmentAsset: (file: File)');
    expect(client).toContain('"/project-assets"');
    expect(client).toContain('"x-project-filename-uri": encodeURIComponent(file.name)');
    expect(client).toContain('/items/attachment`');
    expect(foundation).toContain('routes.post("/project-assets"');
    expect(foundation).not.toContain('startsWith("image/")');
    expect(foundation).toContain("decodeURIComponent(encoded)");
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

  it("only exact-retries outcome-uncertain owned-content mutations", () => {
    const page = read("./pages/ProjectPage.tsx");
    expect(page).toContain('if (!current || current.status !== "uncertain") return;\n    void saveMarkdown();');
    expect(page).toContain('if (!file || !current || current.status !== "uncertain") return;');
    expect(page).toContain('if (!current || current.status !== "uncertain") return;\n    void saveAttachmentMetadata();');
    expect(page).toContain('pendingAttachment?.status === "uncertain"');
    expect(page).toContain('markdownEditor?.status === "uncertain"');
    expect(page).toContain('attachmentEditor?.status === "uncertain"');
    expect(page).not.toContain('pendingAttachment?.status === "error" || pendingAttachment?.status === "conflict" || pendingAttachment?.status === "uncertain") && <button type="button" className="button primary compact-button" onClick={retryAttachment}');
  });

  it("uses MIME identity for image rendering and keeps source attachments on the reference path", () => {
    const page = read("./pages/ProjectPage.tsx");
    const map = read("./components/project/ProjectMapSurface.tsx");
    const model = read("./lib/project-map-model.ts");
    expect(map).toContain("projectAttachmentCanPreviewImage(descriptor.mimeType)");
    expect(map).toContain('className="project-node-image"');
    expect(map).toContain("onError={() => setFailedPreviewUrl(previewUrl)}");
    const reading = read("./components/project/ProjectReadingSurface.tsx");
    const presentation = read("./components/project/ProjectAttachmentPresentation.tsx");
    expect(reading).toContain("<ProjectAttachmentPresentation");
    expect(presentation).toContain("projectAttachmentCanPreviewImage(mimeType)");
    expect(presentation).toContain("onError={() => setFailedPreviewUrl(imagePreviewUrl)}");
    expect(model).toContain("attachmentCaption");
    expect(page).toContain("<ReferenceSearchSurface");
    expect(page).not.toContain("sourceAttachmentId");
  });

  it("keeps occurrence classification textual and reserves semantic color for real state", () => {
    const model = read("./lib/project-map-model.ts");
    const map = read("./components/project/ProjectMapSurface.tsx");
    const reading = read("./components/project/ProjectReadingSurface.tsx");
    const inspector = read("./lib/project-inspector-model.ts");
    const css = read("./components/project/project-map-surface.css");
    expect(model).toContain("export function projectNodeKindLabel");
    expect(map).toContain("projectNodeKindLabel(descriptor.kind)");
    expect(reading).toContain("projectNodeKindLabel(node.kind)");
    expect(inspector).toContain("projectNodeKindLabel(descriptor.kind)");
    expect(css).not.toContain(".project-map-node-markdown::before");
    expect(css).not.toContain(".project-map-node-attachment::before");
    expect(css).not.toContain(".project-map-node-reference::before");
    expect(css).toContain(".project-map-node.pending.error::before");
    expect(css).toContain(".project-map-node.pending.conflict::before");
  });

  it("anchors the context menu to the Project Map canvas", () => {
    const css = read("./components/project/project-map-surface.css");
    expect(css).toMatch(/\.project-flow-canvas\s*\{[\s\S]*?position:\s*relative;/);
    expect(css).toContain(".project-map-context-menu {");
    expect(css).toContain("position: absolute;");
  });

  it("keeps the dedicated gate on the real Project asset Worker path", () => {
    const packageJson = read("../package.json");
    const workerSmoke = read("../scripts/verify-project-worker.mjs");
    expect(packageJson).toContain("worker/project-routes.test.ts");
    expect(packageJson).toContain("npm run verify:project-worker");
    expect(workerSmoke).toContain("/api/project-assets");
    expect(workerSmoke).toContain('encodeURIComponent("smoke.bin")');
    expect(workerSmoke).not.toContain("project-smoke-asset");
  });

  it("keeps Project-owned content creation Map-only while Reading edits existing content", () => {
    const page = read("./pages/ProjectPage.tsx");
    const reading = read("./components/project/ProjectReadingSurface.tsx");
    expect(page).toContain('{desktop ? <div className="project-desktop-workspace with-reference-sidebar">');
    expect(page).toContain('desktopView === "map" ? <>');
    expect(reading).not.toContain("Add attachment");
    expect(reading).not.toContain("New Project Markdown");
    expect(reading).toContain("Edit Markdown");
    expect(reading).toContain("Edit attachment metadata");
    expect(reading).toContain("Move attachment to trash");
    expect(page).toContain("const removeAttachmentItem");
    expect(page).toContain("onAttachmentDeleteRequest={removeAttachmentItem}");
  });
});
