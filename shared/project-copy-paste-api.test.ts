import { describe, expect, it } from "vitest";
import { isCopyAttachmentProjectItemInput } from "./project-copy-paste-api";

const geometry = { x: 10, y: 20, width: 320, height: 180, zIndex: 0 };

function validInput() {
  return {
    sourceContentId: "source-content",
    contentId: "copied-content",
    itemId: "copied-item",
    placementId: "copied-placement",
    caption: "Copied caption",
    sourceUrl: "https://example.com/source",
    geometry,
    expectedProjectRevision: 2,
    operationId: "copy-attachment-operation",
  };
}

describe("Project attachment copy API", () => {
  it("accepts a source content identity without exposing a physical blob locator", () => {
    expect(isCopyAttachmentProjectItemInput(validInput())).toBe(true);
  });

  it("requires a fresh content identity and rejects client-supplied locators", () => {
    expect(isCopyAttachmentProjectItemInput({
      ...validInput(),
      contentId: "source-content",
    })).toBe(false);
    expect(isCopyAttachmentProjectItemInput({
      ...validInput(),
      locator: { assetId: "asset-a" },
    })).toBe(false);
    expect(isCopyAttachmentProjectItemInput({
      ...validInput(),
      assetId: "asset-a",
    })).toBe(false);
    expect(isCopyAttachmentProjectItemInput({
      ...validInput(),
      storageObjectId: "storage-a",
    })).toBe(false);
  });

  it("retains the existing Project metadata, geometry, revision, and operation guards", () => {
    expect(isCopyAttachmentProjectItemInput({
      ...validInput(),
      sourceContentId: "../unsafe",
    })).toBe(false);
    expect(isCopyAttachmentProjectItemInput({
      ...validInput(),
      sourceUrl: "file:///tmp/source",
    })).toBe(false);
    expect(isCopyAttachmentProjectItemInput({
      ...validInput(),
      geometry: { ...geometry, width: 0 },
    })).toBe(false);
    expect(isCopyAttachmentProjectItemInput({
      ...validInput(),
      expectedProjectRevision: 0,
    })).toBe(false);
    expect(isCopyAttachmentProjectItemInput({
      ...validInput(),
      operationId: "",
    })).toBe(false);
  });
});
