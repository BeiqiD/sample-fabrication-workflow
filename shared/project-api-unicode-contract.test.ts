import { describe, expect, it } from "vitest";
import {
  isProjectAttachmentCaption,
  isProjectAttachmentLocator,
  isProjectAttachmentSourceUrl,
  isProjectEdgeLabel,
  isProjectMarkdownSource,
  isProjectTitle,
  MAX_PROJECT_MARKDOWN_LENGTH,
} from "./project-api";
import {
  MAX_PROJECT_ATTACHMENT_CAPTION_LENGTH,
  MAX_PROJECT_ATTACHMENT_SOURCE_URL_LENGTH,
  MAX_PROJECT_EDGE_LABEL_LENGTH,
  MAX_PROJECT_TITLE_LENGTH,
} from "./project-types";

function codePointLength(value: string) {
  return [...value].length;
}

describe("Project Unicode and attachment-locator API contract", () => {
  it("counts every persisted payload ceiling in Unicode code points", () => {
    expect(isProjectTitle("😀".repeat(MAX_PROJECT_TITLE_LENGTH))).toBe(true);
    expect(isProjectTitle("😀".repeat(MAX_PROJECT_TITLE_LENGTH + 1))).toBe(false);

    expect(isProjectMarkdownSource(
      "😀".repeat(MAX_PROJECT_MARKDOWN_LENGTH),
    )).toBe(true);
    expect(isProjectMarkdownSource(
      "😀".repeat(MAX_PROJECT_MARKDOWN_LENGTH + 1),
    )).toBe(false);

    expect(isProjectAttachmentCaption(
      "😀".repeat(MAX_PROJECT_ATTACHMENT_CAPTION_LENGTH),
    )).toBe(true);
    expect(isProjectAttachmentCaption(
      "😀".repeat(MAX_PROJECT_ATTACHMENT_CAPTION_LENGTH + 1),
    )).toBe(false);

    expect(isProjectEdgeLabel(
      "😀".repeat(MAX_PROJECT_EDGE_LABEL_LENGTH),
    )).toBe(true);
    expect(isProjectEdgeLabel(
      "😀".repeat(MAX_PROJECT_EDGE_LABEL_LENGTH + 1),
    )).toBe(false);

    const urlPrefix = "https://example.test/";
    const sourceUrlAtLimit = `${urlPrefix}${"😀".repeat(
      MAX_PROJECT_ATTACHMENT_SOURCE_URL_LENGTH - codePointLength(urlPrefix),
    )}`;
    expect(codePointLength(sourceUrlAtLimit))
      .toBe(MAX_PROJECT_ATTACHMENT_SOURCE_URL_LENGTH);
    expect(isProjectAttachmentSourceUrl(sourceUrlAtLimit)).toBe(true);
    expect(isProjectAttachmentSourceUrl(`${sourceUrlAtLimit}😀`)).toBe(false);
  });

  it("retains ECMAScript trim semantics for titles and source URLs", () => {
    [
      "\tTitle",
      "Title\t",
      "\u00A0Title\u00A0",
      "\uFEFFTitle",
      "Title\n",
    ].forEach((title) => {
      expect(isProjectTitle(title)).toBe(false);
    });

    [
      "\thttps://example.test/source",
      "https://example.test/source\t",
      "https://example.test/source\u00A0",
      "\u00A0https://example.test/source",
      "\uFEFFhttps://example.test/source",
    ].forEach((sourceUrl) => {
      expect(isProjectAttachmentSourceUrl(sourceUrl)).toBe(false);
    });
  });

  it("requires the locator keys themselves to be mutually exclusive", () => {
    expect(isProjectAttachmentLocator({ assetId: "asset-a" })).toBe(true);
    expect(isProjectAttachmentLocator({
      storageObjectId: "storage-a",
    })).toBe(true);

    expect(isProjectAttachmentLocator({
      assetId: "asset-a",
      storageObjectId: "storage-a",
    })).toBe(false);
    expect(isProjectAttachmentLocator({
      assetId: null,
      storageObjectId: "storage-a",
    })).toBe(false);
    expect(isProjectAttachmentLocator({
      assetId: "asset-a",
      storageObjectId: null,
    })).toBe(false);
    expect(isProjectAttachmentLocator({ assetId: 42 })).toBe(false);
    expect(isProjectAttachmentLocator({ storageObjectId: 42 })).toBe(false);
    expect(isProjectAttachmentLocator({
      assetId: undefined,
      storageObjectId: "storage-a",
    })).toBe(false);
  });
});
