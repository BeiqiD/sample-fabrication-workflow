import { describe, expect, it } from "vitest";
import { validateCommentSubmissionInput } from "./comment-submissions";

const oversized = "x".repeat(201);

describe("Comment target metadata bounds", () => {
  it("rejects oversized sample identifiers and revisions", () => {
    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "Comment",
      context: {
        kind: "sample",
        sampleId: oversized,
        expectedUpdatedAt: "2026-07-23T20:00:00Z",
      },
      items: [],
    })).toBe("A current sample revision is required");

    expect(validateCommentSubmissionInput({
      id: "submission-123",
      body: "Comment",
      context: {
        kind: "sample",
        sampleId: "sample-123",
        expectedUpdatedAt: oversized,
      },
      items: [],
    })).toBe("A current sample revision is required");
  });

  it("rejects oversized run-step target fields", () => {
    const target = {
      sampleId: "sample-123",
      runId: "run-12345",
      stepId: "step-1234",
      expectedUpdatedAt: "2026-07-23T20:00:00Z",
    };
    for (const field of ["sampleId", "runId", "stepId", "expectedUpdatedAt"] as const) {
      expect(validateCommentSubmissionInput({
        id: "submission-123",
        body: "Comment",
        context: {
          kind: "run_steps",
          scope: "individual",
          targets: [{ ...target, [field]: oversized }],
        },
        items: [],
      })).toBe("Valid process-step targets are required");
    }
  });
});
