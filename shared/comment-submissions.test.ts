import { describe, expect, it } from "vitest";
import {
  MAX_COMMENT_IMAGE_SOURCE_BYTES,
  MAX_MANAGED_ATTACHMENT_BYTES,
  requiresManagedStorage,
  safeAttachmentUrl,
  validateCommentSubmissionInput,
  validSha256,
} from "./comment-submissions";

const sampleContext = { kind: "sample" as const, sampleId: "sample-123", expectedUpdatedAt: "2026-07-23T20:00:00Z" };

describe("comment submission validation", () => {
  it("accepts text, processed images, unchanged attachments, and external links", () => {
    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "Surface after cleaning",
      context: sampleContext,
      items: [
        {
          id: "image-123",
          kind: "comment_image",
          filename: "surface.webp",
          mimeType: "image/webp",
          byteSize: 280_000,
          originalFilename: "surface.png",
          originalMimeType: "image/png",
          originalByteSize: 4_300_000,
          relatedAttachmentId: "original-123",
        },
        {
          id: "original-123",
          kind: "attachment",
          filename: "surface.png",
          mimeType: "image/png",
          byteSize: 4_300_000,
          relatedCommentImageId: "image-123",
        },
        {
          id: "link-123",
          kind: "link",
          url: "https://drive.example/data",
          title: "Full microscope dataset",
        },
      ],
    })).toBeNull();
  });

  it("rejects oversized source images and managed attachments", () => {
    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "",
      context: sampleContext,
      items: [{
        id: "image-123",
        kind: "comment_image",
        filename: "surface.webp",
        mimeType: "image/webp",
        byteSize: 10,
        originalFilename: "surface.png",
        originalMimeType: "image/png",
        originalByteSize: MAX_COMMENT_IMAGE_SOURCE_BYTES + 1,
      }],
    })).toBe("Comment image metadata is invalid");
    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "",
      context: sampleContext,
      items: [{
        id: "file-123",
        kind: "attachment",
        filename: "large.zip",
        mimeType: "application/zip",
        byteSize: MAX_MANAGED_ATTACHMENT_BYTES + 1,
      }],
    })).toBe("Attachment metadata is invalid");
  });

  it("accepts only http attachment links and lowercase sha256 values", () => {
    expect(safeAttachmentUrl("https://example.com/data")).toBe(true);
    expect(safeAttachmentUrl("file:///tmp/data")).toBe(false);
    expect(validSha256("a".repeat(64))).toBe(true);
    expect(validSha256("A".repeat(64))).toBe(false);
  });

  it("requires managed storage only for uploaded file attachments", () => {
    expect(requiresManagedStorage([{
      id: "image-123",
      kind: "comment_image",
      filename: "surface.webp",
      mimeType: "image/webp",
      byteSize: 280_000,
      originalFilename: "surface.png",
      originalMimeType: "image/png",
      originalByteSize: 4_300_000,
    }, {
      id: "link-123",
      kind: "link",
      url: "https://drive.example/data",
      title: "Full microscope dataset",
    }])).toBe(false);
    expect(requiresManagedStorage([{
      id: "file-123",
      kind: "attachment",
      filename: "measurement.csv",
      mimeType: "text/csv",
      byteSize: 1_024,
    }])).toBe(true);
  });
});
