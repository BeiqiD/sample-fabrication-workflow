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

function submissionWith(item: unknown) {
  return {
    id: "submission-123",
    body: "Attachment",
    context: sampleContext,
    items: [item],
  };
}

function expectValidationError(input: unknown, expected: string) {
  expect(() => validateCommentSubmissionInput(input)).not.toThrow();
  expect(validateCommentSubmissionInput(input)).toBe(expected);
}

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
    expect(safeAttachmentUrl(123)).toBe(false);
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

  it("requires a TIFF preview to include its matching unchanged original", () => {
    const preview = {
      id: "image-tiff",
      kind: "comment_image" as const,
      filename: "surface.webp",
      mimeType: "image/webp",
      byteSize: 120_000,
      originalFilename: "surface.tif",
      originalMimeType: "application/octet-stream",
      originalByteSize: 3_600_000,
      relatedAttachmentId: "original-tiff",
    };
    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "SEM image",
      context: sampleContext,
      items: [preview],
    })).toBe("A related original attachment is missing");
    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "SEM image",
      context: sampleContext,
      items: [preview, {
        id: "original-tiff",
        kind: "attachment",
        filename: "surface.tif",
        mimeType: "application/octet-stream",
        byteSize: 3_600_000,
      }],
    })).toBe("A TIFF preview requires its unchanged original attachment");
    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "SEM image",
      context: sampleContext,
      items: [preview, {
        id: "original-tiff",
        kind: "attachment",
        filename: "surface.tif",
        mimeType: "application/octet-stream",
        byteSize: 3_600_000,
        relatedCommentImageId: "image-tiff",
      }],
    })).toBeNull();
  });

  it("accepts safe TIFF source metadata while preserving filename classification", () => {
    for (const original of [
      { filename: "surface.tif\t", mimeType: "image/png" },
      { filename: "surface.bin", mimeType: "image/tiff; charset=binary" },
    ]) {
      const preview = {
        id: "image-whitespace",
        kind: "comment_image" as const,
        filename: "surface.webp",
        mimeType: "image/webp",
        byteSize: 120_000,
        originalFilename: original.filename,
        originalMimeType: original.mimeType,
        originalByteSize: 3_600_000,
        relatedAttachmentId: "original-whitespace",
      };
      expect(validateCommentSubmissionInput({
        id: "submission-123",
        body: "SEM image",
        context: sampleContext,
        items: [preview, {
          id: "original-whitespace",
          kind: "attachment",
          filename: original.filename,
          mimeType: original.mimeType,
          byteSize: 3_600_000,
          relatedCommentImageId: "image-whitespace",
        }],
      })).toBeNull();
    }
  });

  it("rejects NUL in persisted attachment presentation metadata", () => {
    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "SEM image",
      context: sampleContext,
      items: [{
        id: "image-nul",
        kind: "comment_image",
        filename: "surface.webp",
        mimeType: "image/webp",
        byteSize: 120_000,
        originalFilename: "\u0000surface.tif",
        originalMimeType: "image/png",
        originalByteSize: 3_600_000,
      }],
    })).toBe("Comment image metadata is invalid");

    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "file",
      context: sampleContext,
      items: [{
        id: "file-nul",
        kind: "attachment",
        filename: "surface.tif",
        mimeType: "image/tiff\u0000ignored",
        byteSize: 1_024,
      }],
    })).toBe("Attachment metadata is invalid");
  });

  it("rejects malformed attachment JSON field types without throwing", () => {
    const malformedValues: unknown[] = [123, [], {}];
    const imageBase = {
      id: "image-bad",
      kind: "comment_image",
      filename: "surface.webp",
      mimeType: "image/webp",
      byteSize: 120_000,
      originalFilename: "surface.png",
      originalMimeType: "image/png",
      originalByteSize: 3_600_000,
    };
    for (const field of ["filename", "mimeType", "originalFilename", "originalMimeType", "relatedAttachmentId"] as const) {
      for (const value of malformedValues) {
        expectValidationError(
          submissionWith({ ...imageBase, [field]: value }),
          "Comment image metadata is invalid",
        );
      }
    }
    for (const field of ["byteSize", "originalByteSize"] as const) {
      for (const value of ["1", [], {}]) {
        expectValidationError(
          submissionWith({ ...imageBase, [field]: value }),
          "Comment image metadata is invalid",
        );
      }
    }

    const attachmentBase = {
      id: "file-bad",
      kind: "attachment",
      filename: "measurement.csv",
      mimeType: "text/csv",
      byteSize: 1_024,
    };
    for (const field of ["filename", "mimeType", "title", "relatedCommentImageId"] as const) {
      for (const value of malformedValues) {
        expectValidationError(
          submissionWith({ ...attachmentBase, [field]: value }),
          "Attachment metadata is invalid",
        );
      }
    }
    for (const value of ["1024", 1.5, [], {}]) {
      expectValidationError(
        submissionWith({ ...attachmentBase, byteSize: value }),
        "Attachment metadata is invalid",
      );
    }

    const linkBase = {
      id: "link-bad",
      kind: "link",
      title: "Dataset",
      url: "https://example.com/data",
    };
    for (const field of ["title", "url", "description"] as const) {
      for (const value of malformedValues) {
        expectValidationError(
          submissionWith({ ...linkBase, [field]: value }),
          "Attachment link metadata is invalid",
        );
      }
    }
  });

  it("rejects malformed context and run-step target field types without throwing", () => {
    for (const value of [123, [], {}]) {
      expectValidationError({
        id: "submission-123",
        body: "Comment",
        context: { ...sampleContext, sampleId: value },
        items: [],
      }, "A current sample revision is required");
    }

    const target = {
      sampleId: "sample-123",
      runId: "run-12345",
      stepId: "step-1234",
      expectedUpdatedAt: "2026-07-23T20:00:00Z",
    };
    for (const field of ["sampleId", "runId", "stepId", "expectedUpdatedAt"] as const) {
      for (const value of [123, [], {}]) {
        expectValidationError({
          id: "submission-123",
          body: "Comment",
          context: {
            kind: "run_steps",
            scope: "individual",
            targets: [{ ...target, [field]: value }],
          },
          items: [],
        }, "Valid process-step targets are required");
      }
    }
  });
});
