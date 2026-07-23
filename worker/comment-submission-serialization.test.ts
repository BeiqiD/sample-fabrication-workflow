import { describe, expect, it } from "vitest";
import { serializeCommentSubmissions } from "./comment-submission-serialization";

describe("comment submission serialization", () => {
  it("keeps inline images and original attachments separate while preserving their relation", () => {
    const [comment] = serializeCommentSubmissions([{
      id: "submission-1",
      context_kind: "sample",
      sample_id: "sample-1",
      scope: null,
      body: "Surface",
      status: "ready",
      error_message: null,
      actor_email: "user@example.com",
      created_at: "2026-07-23T20:00:00Z",
      updated_at: "2026-07-23T20:01:00Z",
    }], [{
      id: "image-1",
      submission_id: "submission-1",
      kind: "comment_image",
      status: "ready",
      filename: "surface.webp",
      mime_type: "image/webp",
      byte_size: 280_000,
      original_filename: "surface.png",
      original_mime_type: "image/png",
      original_byte_size: 4_300_000,
      title: null,
      description: null,
      external_url: null,
      sha256: "a".repeat(64),
      related_item_id: "original-1",
      error_message: null,
      asset_key: "comments/surface.webp",
      storage_object_id: null,
    }, {
      id: "original-1",
      submission_id: "submission-1",
      kind: "attachment",
      status: "ready",
      filename: "surface.png",
      mime_type: "image/png",
      byte_size: 4_300_000,
      original_filename: "surface.png",
      original_mime_type: "image/png",
      original_byte_size: 4_300_000,
      title: "surface.png",
      description: null,
      external_url: null,
      sha256: "b".repeat(64),
      related_item_id: "image-1",
      error_message: null,
      asset_key: null,
      storage_object_id: "object-1",
    }]);
    expect(comment.images[0].relatedAttachmentId).toBe("original-1");
    expect(comment.attachments[0]).toMatchObject({
      kind: "file",
      relatedCommentImageId: "image-1",
      downloadUrl: "/api/attachments/original-1/download",
    });
  });
});
