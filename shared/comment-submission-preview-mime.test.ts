import { describe, expect, it } from "vitest";
import { validateCommentSubmissionInput } from "./comment-submissions";

const baseSubmission = {
  id: "submission-123",
  body: "Preview",
  context: {
    kind: "sample" as const,
    sampleId: "sample-123",
    expectedUpdatedAt: "2026-07-23T20:00:00Z",
  },
};

function preview(mimeType: unknown) {
  return {
    id: "image-123",
    kind: "comment_image",
    filename: "preview.webp",
    mimeType,
    byteSize: 1_024,
    originalFilename: "source.png",
    originalMimeType: "image/png",
    originalByteSize: 2_048,
  };
}

describe("Comment preview MIME validation", () => {
  it("accepts parameterized browser-safe raster MIME", () => {
    expect(validateCommentSubmissionInput({
      ...baseSubmission,
      items: [preview("image/webp; charset=binary")],
    })).toBeNull();
  });

  it("rejects unsupported or malformed image MIME before persistence", () => {
    for (const mimeType of [
      "image/svg+xml",
      "image/tiff",
      "image/not valid",
      "image/",
      " image/webp",
      "image/webp ",
      "image/webp;\r\nx-test: injected",
      "image/webp\u0000ignored",
      123,
      [],
      {},
    ]) {
      expect(() => validateCommentSubmissionInput({
        ...baseSubmission,
        items: [preview(mimeType)],
      })).not.toThrow();
      expect(validateCommentSubmissionInput({
        ...baseSubmission,
        items: [preview(mimeType)],
      })).toBe("Comment image metadata is invalid");
    }
  });
});
