import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CommentAttachment } from "../../shared/types";
import { CommentAttachmentList } from "./CommentAttachmentList";

describe("CommentAttachmentList", () => {
  it("marks uploaded files as downloads with their original filename", () => {
    const attachments: CommentAttachment[] = [{
      id: "file-1",
      kind: "file",
      title: "Surface scan",
      description: null,
      filename: "surface scan.tiff",
      mimeType: "image/tiff",
      byteSize: 2_097_152,
      sha256: null,
      downloadUrl: "/api/attachments/file-1/download",
      status: "ready",
      error: null,
      relatedCommentImageId: null,
    }];

    const markup = renderToStaticMarkup(createElement(CommentAttachmentList, { attachments }));

    expect(markup).toContain('href="/api/attachments/file-1/download"');
    expect(markup).toContain('download="surface scan.tiff"');
    expect(markup).toContain("2.0 MB");
  });

  it("keeps external attachment links separate from managed downloads", () => {
    const attachments: CommentAttachment[] = [{
      id: "link-1",
      kind: "link",
      title: "External data",
      description: null,
      url: "https://example.com/data",
      status: "ready",
      error: null,
    }];

    const markup = renderToStaticMarkup(createElement(CommentAttachmentList, { attachments }));

    expect(markup).toContain('target="_blank"');
    expect(markup).not.toContain("download=");
  });
});
