import { describe, expect, it } from "vitest";
import {
  isCreateAttachmentProjectItemInput,
  isCreateMarkdownProjectItemInput,
  isCreateProjectEdgeInput,
  isCreateProjectInput,
  isCreateReferenceProjectItemInput,
  isProjectApiId,
  isProjectAttachmentSourceUrl,
  isProjectItemLifecycleInput,
  isRenameProjectInput,
  isUpdateProjectPlacementInput,
  MAX_PROJECT_MARKDOWN_LENGTH,
} from "./project-api";

const geometry = {
  x: 10,
  y: -20,
  width: 320,
  height: 180,
  zIndex: 2,
};

describe("Project persistence API contract", () => {
  it("accepts portable opaque IDs and rejects path or relative-segment ambiguity", () => {
    expect(isProjectApiId("project-01.uuid_like~value")).toBe(true);
    expect(isProjectApiId("a".repeat(256))).toBe(true);
    expect(isProjectApiId("a".repeat(257))).toBe(false);
    expect(isProjectApiId("../project")).toBe(false);
    expect(isProjectApiId("..")).toBe(false);
    expect(isProjectApiId("project/id")).toBe(false);
    expect(isProjectApiId("project%2Fid")).toBe(false);
    expect(isProjectApiId(" project")).toBe(false);
  });

  it("validates Project and item creation without accepting unsafe revisions", () => {
    expect(isCreateProjectInput({
      id: "project-a",
      title: "Project A",
      operationId: "create-project-a",
    })).toBe(true);
    expect(isCreateProjectInput({
      id: "project-a",
      title: " Project A ",
      operationId: "create-project-a",
    })).toBe(false);
    expect(isRenameProjectInput({
      title: "Renamed",
      expectedRevision: 1,
      operationId: "rename-project-a",
    })).toBe(true);
    expect(isRenameProjectInput({
      title: "Renamed",
      expectedRevision: 1.5,
      operationId: "rename-project-a",
    })).toBe(false);

    expect(isCreateMarkdownProjectItemInput({
      contentId: "content-a",
      itemId: "item-a",
      placementId: "placement-a",
      markdownSource: "# Note",
      geometry,
      expectedProjectRevision: 1,
      operationId: "create-markdown-a",
    })).toBe(true);
    expect(isCreateMarkdownProjectItemInput({
      contentId: "content-a",
      itemId: "item-a",
      placementId: "placement-a",
      markdownSource: "x".repeat(MAX_PROJECT_MARKDOWN_LENGTH + 1),
      geometry,
      expectedProjectRevision: 1,
      operationId: "create-markdown-a",
    })).toBe(false);

    expect(isCreateReferenceProjectItemInput({
      itemId: "item-ref",
      placementId: "placement-ref",
      target: { type: "sample", id: "sample-a" },
      geometry,
      expectedProjectRevision: 2,
      operationId: "create-reference-a",
    })).toBe(true);
    expect(isCreateReferenceProjectItemInput({
      itemId: "item-ref",
      placementId: "placement-ref",
      target: { type: "sample", id: " sample-a" },
      geometry,
      expectedProjectRevision: 2,
      operationId: "create-reference-a",
    })).toBe(false);
  });

  it("requires exactly one existing attachment-record identity and safe provenance URLs", () => {
    expect(isCreateAttachmentProjectItemInput({
      contentId: "content-file",
      itemId: "item-file",
      placementId: "placement-file",
      locator: { assetId: "asset-a" },
      caption: "Figure 1",
      sourceUrl: "https://example.test/source",
      geometry,
      expectedProjectRevision: 1,
      operationId: "create-file-a",
    })).toBe(true);
    expect(isCreateAttachmentProjectItemInput({
      contentId: "content-file",
      itemId: "item-file",
      placementId: "placement-file",
      locator: { assetId: "asset-a", storageObjectId: "storage-a" },
      caption: null,
      sourceUrl: null,
      geometry,
      expectedProjectRevision: 1,
      operationId: "create-file-a",
    })).toBe(false);
    expect(isProjectAttachmentSourceUrl("javascript:alert(1)")).toBe(false);
    expect(isProjectAttachmentSourceUrl("https://example.test/a")).toBe(true);
  });

  it("keeps geometry, edge, and lifecycle inputs closed", () => {
    expect(isUpdateProjectPlacementInput({
      geometry,
      expectedRevision: 1,
      operationId: "move-a",
    })).toBe(true);
    expect(isUpdateProjectPlacementInput({
      geometry: { ...geometry, x: Number.POSITIVE_INFINITY },
      expectedRevision: 1,
      operationId: "move-a",
    })).toBe(false);
    expect(isCreateProjectEdgeInput({
      edgeId: "edge-a",
      sourceItemId: "item-a",
      targetItemId: "item-b",
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: "supports",
      expectedSourceItemRevision: 1,
      expectedTargetItemRevision: 1,
      operationId: "create-edge-a",
    })).toBe(true);
    expect(isCreateProjectEdgeInput({
      edgeId: "edge-a",
      sourceItemId: "item-a",
      targetItemId: "item-a",
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: null,
      expectedSourceItemRevision: 1,
      expectedTargetItemRevision: 1,
      operationId: "create-edge-a",
    })).toBe(false);
    expect(isProjectItemLifecycleInput({
      expectedItemRevision: 1,
      operationId: "remove-item-a",
    })).toBe(true);
    expect(isProjectItemLifecycleInput({
      expectedItemRevision: Number.POSITIVE_INFINITY,
      operationId: "remove-item-a",
    })).toBe(false);
  });
});
