import { describe, expect, it } from "vitest";
import { validateCommentSubmissionInput } from "./comment-submissions";

const context = {
  kind: "sample" as const,
  sampleId: "sample-123",
  expectedUpdatedAt: "2026-07-23T20:00:00Z",
};

function submission(items: unknown[]) {
  return {
    id: "submission-123",
    body: "Image",
    context,
    items,
  };
}

describe("Comment image/original relation integrity", () => {
  it("accepts a reciprocal original relation with matching metadata", () => {
    expect(validateCommentSubmissionInput(submission([{
      id: "image-123",
      kind: "comment_image",
      filename: "preview.webp",
      mimeType: "image/webp",
      byteSize: 1_024,
      originalFilename: "source.png",
      originalMimeType: "image/png",
      originalByteSize: 2_048,
      relatedAttachmentId: "original-123",
    }, {
      id: "original-123",
      kind: "attachment",
      filename: "source.png",
      mimeType: "image/png",
      byteSize: 2_048,
      relatedCommentImageId: "image-123",
    }]))).toBeNull();
  });

  it("rejects one-way or mismatched non-TIFF original relations", () => {
    expect(validateCommentSubmissionInput(submission([{
      id: "image-123",
      kind: "comment_image",
      filename: "preview.webp",
      mimeType: "image/webp",
      byteSize: 1_024,
      originalFilename: "source.png",
      originalMimeType: "image/png",
      originalByteSize: 2_048,
      relatedAttachmentId: "original-123",
    }, {
      id: "original-123",
      kind: "attachment",
      filename: "source.png",
      mimeType: "image/png",
      byteSize: 2_048,
    }]))).toBe("The related original attachment does not match the image source");

    expect(validateCommentSubmissionInput(submission([{
      id: "image-123",
      kind: "comment_image",
      filename: "preview.webp",
      mimeType: "image/webp",
      byteSize: 1_024,
      originalFilename: "source.png",
      originalMimeType: "image/png",
      originalByteSize: 2_048,
      relatedAttachmentId: "original-123",
    }, {
      id: "original-123",
      kind: "attachment",
      filename: "different.png",
      mimeType: "image/png",
      byteSize: 2_048,
      relatedCommentImageId: "image-123",
    }]))).toBe("The related original attachment does not match the image source");
  });

  it("cannot hide a TIFF original behind non-TIFF image metadata", () => {
    expect(validateCommentSubmissionInput(submission([{
      id: "image-123",
      kind: "comment_image",
      filename: "preview.webp",
      mimeType: "image/webp",
      byteSize: 1_024,
      originalFilename: "source.bin",
      originalMimeType: "application/octet-stream",
      originalByteSize: 2_048,
      relatedAttachmentId: "original-123",
    }, {
      id: "original-123",
      kind: "attachment",
      filename: "source.tif",
      mimeType: "image/tiff",
      byteSize: 2_048,
      relatedCommentImageId: "image-123",
    }]))).toBe("A TIFF preview requires its unchanged original attachment");
  });
});
