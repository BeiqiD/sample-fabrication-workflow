import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Phase 3B2 source contract", () => {
  it("reuses the read-only ReferenceSearchSurface and writes only a drag payload before placement", () => {
    const surface = read("./components/ReferenceSearchSurface.tsx");
    expect(surface).toContain('mode: "place"');
    expect(surface).toContain("writeProjectReferenceResolutionDragPayload(event.dataTransfer, resolution)");
    expect(surface).toContain('aria-label={`Place ${title} on Map`}');
    expect(surface).not.toContain("createReferenceItem");
    expect(surface).not.toContain("/projects/");
  });

  it("converts browser drop and viewport-center coordinates through the live React Flow instance and keeps pending placement full-detail", () => {
    const map = read("./components/project/ProjectMapSurface.tsx");
    expect(map).toContain("instance.screenToFlowPosition");
    expect(map).toContain("getViewportCenter()");
    expect(map).toContain("readProjectReferenceDragPayload(event.dataTransfer)");
    expect(map).toContain('buildFlowNode(descriptor, true, true, false, "full", null, callbacks)');
    expect(map).toContain("edgeInteractionDisabled: boolean");
    expect(map).toContain("selectable: false");
    expect(map).toContain("pendingReference");
  });

  it("keeps structural reference insertion separate from Phase 3B1 placement PATCH state", () => {
    const page = read("./pages/ProjectPage.tsx");
    expect(page).toContain("projectApi.createReferenceItem(projectId, input)");
    expect(page).toContain("mergeReferenceInsertion(result, payload)");
    expect(page).toContain("baselineRef.current = {");
    expect(page).not.toContain("installSnapshot(result");
    expect(page).toContain("projectApi.removeItem(projectId, itemId, input)");
  });

  it("treats transport and 5xx insertion failures as uncertain until exact replay or reconciliation", () => {
    const page = read("./pages/ProjectPage.tsx");
    expect(page).toContain('return "uncertain"');
    expect(page).toContain('current?.status !== "uncertain"');
    expect(page).toContain("projectApi.createReferenceItem(projectId, input)");
    expect(page).toContain("Reconcile and cancel");
    expect(page).toContain("pendingReference.status === \"error\" && <button");
  });

  it("freezes geometry and preserves one exact lifecycle request while a reference removal is unresolved", () => {
    const page = read("./pages/ProjectPage.tsx");
    const map = read("./components/project/ProjectMapSurface.tsx");
    expect(page).toContain("pendingReferenceRemovalRef");
    expect(page).toContain("retryReferenceRemoval");
    expect(page).toContain("geometryInteractionDisabled={geometryInteractionDisabled}");
    expect(map).toContain("nodesDraggable={!geometryInteractionDisabled}");
    expect(map).toContain('change.type !== "position" && !(change.type === "dimensions" && change.resizing !== undefined)');
    const geometryChanges = map.slice(map.indexOf("const onNodesChange ="), map.indexOf("const selectionChanges =", map.indexOf("const onNodesChange =")));
    expect(geometryChanges).toContain("if (cancelledGestureNodeIds.has(change.id)) return false");
    expect(geometryChanges).toContain('change.type === "dimensions" ? Boolean(node?.data.resizeEnabled)');
    expect(geometryChanges).toContain(": !geometryInteractionDisabled && !node?.data.markdownEditor");
    // Only the owning Markdown editor can receive scoped resize permission;
    // unresolved reference operations still block that path at the Page boundary.
    const editorPermission = page.slice(page.indexOf("const canResizeMarkdown ="), page.indexOf("const commitGeometryBatch ="));
    expect(editorPermission).toContain("projectReadyRef.current && editor");
    expect(editorPermission).toContain('editor.status === "editing" || editor.status === "error"');
    expect(editorPermission).toContain("!pendingReferenceRef.current && !pendingReferenceRemovalRef.current");
    expect(page).toContain("markdownResizeItemId={canResizeMarkdown() ? markdownEditor?.itemId : null}");
    expect(map).toContain("resizeEnabled: editorResizeEnabled || (!geometryInteractionDisabled && !editing)");
    expect(map).toContain("markdownResizeItemId === descriptor.itemId");
  });

  it("shares reference placement with Reading while keeping the interactive Map desktop-only", () => {
    const page = read("./pages/ProjectPage.tsx");
    const desktopBranch = page.indexOf('{desktop ? <div className="project-desktop-workspace with-reference-sidebar"');
    const mapSurface = page.indexOf("<DesktopProjectMap", desktopBranch);
    const readingBranch = page.indexOf("</> : readingSurface", mapSurface);
    expect(desktopBranch).toBeGreaterThan(-1);
    expect(mapSurface).toBeGreaterThan(desktopBranch);
    expect(readingBranch).toBeGreaterThan(mapSurface);
    expect(page.slice(readingBranch)).not.toContain("<DesktopProjectMap");
    expect(page).toContain('const readingActive = !desktop || desktopView === "reading"');
    expect(page).toContain('referencePanelOpen && readingActive');
    expect(page).toContain('modal={!desktop} label="References"');
    expect(page.match(/<ProjectReadingSurface\b/g)).toHaveLength(1);
    const reading = read("./components/project/ProjectReadingSurface.tsx");
    expect(reading).not.toContain("projectApi.createReferenceItem");
  });
});
