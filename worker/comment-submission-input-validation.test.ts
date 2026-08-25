import { describe, expect, it } from "vitest";
import type { Env } from "./types";
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

type BoundStatement = { sql: string; values: unknown[] };

function failureEnvironment(recordMessage?: (message: string) => void) {
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          if (sql.includes("FROM comment_submissions WHERE id = ?")) {
            return {
              async first() {
                return {
                  id: "submission-123",
                  context_kind: "sample",
                  sample_id: "sample-123",
                  scope: null,
                  body: "Comment",
                  status: "uploading",
                  actor_email: null,
                  retry_until: null,
                  retry_closed_at: null,
                };
              },
            };
          }
          if (!recordMessage) {
            throw new Error(`Unexpected database write after failure-payload validation: ${sql}`);
          }
          return { sql, values } satisfies BoundStatement;
        },
      };
    },
    async batch(statements: unknown[]) {
      if (!recordMessage) throw new Error("Unexpected failure-state write");
      const itemUpdate = statements[0] as BoundStatement;
      recordMessage(String(itemUpdate.values[0]));
      return [
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ];
    },
  } as unknown as D1Database;
  return { DB: database } as Env;
}

async function reportFailure(
  body: string,
  recordMessage?: (message: string) => void,
) {
  return routes.request(
    "http://local.test/comment-submissions/submission-123/items/item-123/fail",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
    failureEnvironment(recordMessage),
  );
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

  it("accepts a bounded string and preserves the empty-message default", async () => {
    const messages: string[] = [];
    let response = await reportFailure(
      JSON.stringify({ error: "  Network retry failed  " }),
      (message) => messages.push(message),
    );
    expect(response.status).toBe(200);

    response = await reportFailure(
      JSON.stringify({}),
      (message) => messages.push(message),
    );
    expect(response.status).toBe(200);
    expect(messages).toEqual([
      "Network retry failed",
      "The upload did not reach the server",
    ]);
  });

  it("returns 400 for non-object, non-string, NUL, and overlong failure reports", async () => {
    const payloads: unknown[] = [
      null,
      [],
      { error: {} },
      { error: 42 },
      { error: "failed\u0000details" },
      { error: "x".repeat(1_001) },
    ];

    for (const payload of payloads) {
      const response = await reportFailure(JSON.stringify(payload));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Comment upload failure payload is invalid");
    }
  });

  it("returns 400 for malformed JSON on the failure route", async () => {
    const response = await reportFailure("{");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Comment upload failure payload is invalid");
  });
});
