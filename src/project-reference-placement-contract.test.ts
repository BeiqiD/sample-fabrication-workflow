import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Phase 3B2 source contract", () => {
  it("reuses the read-only ReferenceSearchSurface and writes only a drag payload before placement", () => {
    const surface = read("./components/ReferenceSearchSurface.tsx");
    expect(surface).toContain('mode: "place"');
    expect(surface).toContain("writeProjectReferenceDragPayload(event.dataTransfer, result)");
    expect(surface).toContain("Place at Map center");
    expect(surface).not.toContain("createReferenceItem");
    expect(surface).not.toContain("/projects/");
  });

  it("converts browser drop and viewport-center coordinates through the live React Flow instance", () => {
    const map = read("./components/project/ProjectMapSurface.tsx");
    expect(map).toContain("instance.screenToFlowPosition");
    expect(map).toContain("getViewportCenter()");
    expect(map).toContain("readProjectReferenceDragPayload(event.dataTransfer)");
    expect(map).toContain("buildFlowNode(descriptor, true, null, callbacks)");
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
    expect(map).toContain('changes.filter((change) => change.type !== "position")');
  });

  it("keeps reference creation desktop-only and preserves the mobile no-creation boundary", () => {
    const page = read("./pages/ProjectPage.tsx");
    const desktopBranch = page.indexOf('{desktop ? <div className="project-desktop-workspace with-reference-sidebar">');
    const searchSurface = page.indexOf("<ReferenceSearchSurface", desktopBranch);
    const mobileBranch = page.indexOf(": <section className=\"project-mobile-reading\"", searchSurface);
    expect(desktopBranch).toBeGreaterThan(-1);
    expect(searchSurface).toBeGreaterThan(desktopBranch);
    expect(mobileBranch).toBeGreaterThan(searchSurface);
    expect(page.slice(mobileBranch)).not.toContain("<ReferenceSearchSurface");
    expect(page.slice(mobileBranch)).not.toContain("Remove from Project");
  });
});
