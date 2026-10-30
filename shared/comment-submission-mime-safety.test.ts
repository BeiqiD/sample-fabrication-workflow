import { describe, expect, it } from "vitest";
import { validateCommentSubmissionInput } from "./comment-submissions";

const context = {
  kind: "sample" as const,
  sampleId: "sample-123",
  expectedUpdatedAt: "2026-07-23T20:00:00Z",
};

function validateItem(item: unknown) {
  return validateCommentSubmissionInput({
    id: "submission-123",
    body: "Attachment",
    context,
    items: [item],
  });
}

describe("Comment attachment MIME input safety", () => {
  it("accepts safe parameterized MIME for previews, originals, and generic attachments", () => {
    expect(validateItem({
      id: "file-123",
      kind: "attachment",
      filename: "measurement.bin",
      mimeType: "application/octet-stream; charset=binary",
      byteSize: 1_024,
    })).toBeNull();

    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "TIFF",
      context,
      items: [{
        id: "image-123",
        kind: "comment_image",
        filename: "preview.webp",
        mimeType: "image/webp; charset=binary",
        byteSize: 1_024,
        originalFilename: "measurement.tif",
        originalMimeType: "image/tiff; charset=binary",
        originalByteSize: 2_048,
        relatedAttachmentId: "original-123",
      }, {
        id: "original-123",
        kind: "attachment",
        filename: "measurement.tif",
        mimeType: "image/tiff; charset=binary",
        byteSize: 2_048,
        relatedCommentImageId: "image-123",
      }],
    })).toBeNull();
  });

  it("rejects MIME that cannot be written safely as Content-Type", () => {
    const invalidMimeTypes = [
      " application/pdf",
      "application/pdf ",
      "application/pdf;\r\nx-test: injected",
      "\u00A0application/pdf",
      "application/not valid",
      "not-a-mime",
    ];

    for (const mimeType of invalidMimeTypes) {
      expect(() => validateItem({
        id: "file-bad",
        kind: "attachment",
        filename: "measurement.bin",
        mimeType,
        byteSize: 1_024,
      })).not.toThrow();
      expect(validateItem({
        id: "file-bad",
        kind: "attachment",
        filename: "measurement.bin",
        mimeType,
        byteSize: 1_024,
      })).toBe("Attachment metadata is invalid");

      expect(validateItem({
        id: "image-bad",
        kind: "comment_image",
        filename: "preview.webp",
        mimeType: "image/webp",
        byteSize: 1_024,
        originalFilename: "measurement.tif",
        originalMimeType: mimeType,
        originalByteSize: 2_048,
      })).toBe("Comment image metadata is invalid");
    }
  });
});
