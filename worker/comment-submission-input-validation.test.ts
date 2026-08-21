import { describe, expect, it } from "vitest";
import { routes } from "./comment-submission-routes";

const sampleContext = {
  kind: "sample",
  sampleId: "sample-123",
  expectedUpdatedAt: "2026-07-23T20:00:00Z",
};

async function submit(payload: unknown) {
  return routes.request("http://local.test/comment-submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("Comment submission JSON validation", () => {
  it("returns 400 instead of throwing for malformed attachment presentation fields", async () => {
    const payloads = [
      {
        expected: "Attachment metadata is invalid",
        item: {
          id: "file-bad",
          kind: "attachment",
          filename: 123,
          mimeType: "application/pdf",
          byteSize: 1,
        },
      },
      {
        expected: "Comment image metadata is invalid",
        item: {
          id: "image-bad",
          kind: "comment_image",
          filename: "surface.webp",
          mimeType: "image/webp",
          byteSize: 1,
          originalFilename: [],
          originalMimeType: "image/tiff",
          originalByteSize: 1,
        },
      },
      {
        expected: "Attachment link metadata is invalid",
        item: {
          id: "link-bad",
          kind: "link",
          title: {},
          url: "https://example.com/data",
        },
      },
    ];

    for (const payload of payloads) {
      const response = await submit({
        id: "submission-123",
        body: "Attachment",
        context: sampleContext,
        items: [payload.item],
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(payload.expected);
    }
  });

  it("returns 400 before database access for malformed target fields", async () => {
    const response = await submit({
      id: "submission-123",
      body: "Comment",
      context: {
        kind: "run_steps",
        scope: "individual",
        targets: [{
          sampleId: "sample-123",
          runId: "run-12345",
          stepId: {},
          expectedUpdatedAt: "2026-07-23T20:00:00Z",
        }],
      },
      items: [],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Valid process-step targets are required");
  });
});
