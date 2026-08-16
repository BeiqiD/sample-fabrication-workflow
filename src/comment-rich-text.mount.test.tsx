// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommentSubmissionStatus, SampleDetail, SampleEvent } from "../shared/types";
import { CommentBody } from "./components/CommentBody";
import { SampleTimeline } from "./components/SampleTimeline";
import { api } from "./lib/api";
import { SamplePage } from "./pages/SamplePage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function event(input: Partial<SampleEvent> & Pick<SampleEvent, "id" | "kind" | "body">): SampleEvent {
  return {
    sampleId: "sample-a",
    assetKey: null,
    metadata: {},
    actorEmail: "researcher@example.com",
    createdAt: "2026-08-16T12:00:00.000Z",
    ...input,
  };
}

function sampleWithStepComments(statuses: CommentSubmissionStatus[]): SampleDetail {
  const createdAt = "2026-08-16T12:00:00.000Z";
  return {
    id: "sample-a",
    code: "S-001",
    title: "Comment boundary sample",
    description: null,
    status: "active",
    location: null,
    parentId: null,
    inheritedStateHash: null,
    pinned: false,
    createdAt,
    updatedAt: createdAt,
    latestWorkflowName: "Etch process",
    latestWorkflowVersion: 1,
    latestRunStatus: "active",
    currentStepTitle: "Etch",
    currentStateStepTitle: null,
    currentStateThumbnailKey: null,
    parent: null,
    children: [],
    events: [],
    comments: [],
    stateVerifications: [],
    runs: [{
      id: "run-a",
      recipeFamilyId: "family-a",
      templateVersionId: "template-a",
      templateName: "Etch process",
      templateType: "process",
      templateVersion: 1,
      runKind: "process",
      status: "active",
      currentPlanRevisionId: "revision-a",
      planRevisionNumber: 1,
      predecessorRunId: null,
      anchorStepId: null,
      sequenceNo: 1,
      runGroupId: "group-a",
      initialStateHash: null,
      initialStateImageKeys: [],
      createdAt,
      completedAt: null,
      steps: [{
        id: "step-a",
        templateStepId: "template-step-a",
        logicalStepKey: "logical-step-a",
        sectionName: null,
        definitionHash: "definition-a",
        expectedStateHash: null,
        position: 0,
        planPosition: 0,
        origin: "template",
        entryKind: "fabrication",
        planStatus: "current",
        title: "Etch",
        status: "in_progress",
        notes: null,
        toolName: null,
        parametersText: null,
        commentsText: null,
        deviationNote: null,
        plannedTitle: "Etch",
        plannedToolName: null,
        plannedParametersText: null,
        plannedCommentsText: null,
        plannedImageKeys: [],
        executionImageKeys: [],
        comments: statuses.map((status, index) => ({
          id: `comment-${status}`,
          scope: "individual",
          operationGroupId: `operation-${status}`,
          body: status === "ready" ? "**Ready** $R_a$" : `**${status}** $x_${index}$`,
          assetKey: null,
          submissionId: `submission-${status}`,
          status,
          images: [],
          attachments: [],
          actorEmail: "researcher@example.com",
          createdAt: new Date(Date.parse(createdAt) + index * 1_000).toISOString(),
        })),
        actualizedAt: null,
        verificationIds: [],
        stateVerification: null,
        createdAt,
        updatedAt: createdAt,
      }],
    }],
  };
}

describe("mounted Comment rich text", () => {
  it("renders line breaks, compact headings, TeX, and safe image links lazily", async () => {
    const view = render(<CommentBody source={`# Observation
First line
Second line with $R_a = 0.239\\,\\mathrm{nm}$.

![AFM](https://example.com/afm.png)`} />);

    await waitFor(() => expect(view.container.querySelector('[data-rich-text="comment"]')).not.toBeNull());
    const rich = view.container.querySelector('[data-rich-text="comment"]');
    expect(rich?.querySelector("h1")).toBeNull();
    expect(rich?.querySelector(".rich-text-comment-heading")?.textContent).toBe("Observation");
    expect(rich?.innerHTML).toMatch(/First line<br>\s*Second line/);
    expect(rich?.querySelector(".rich-text-math-inline math")).not.toBeNull();
    expect(rich?.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "Image: AFM" }).getAttribute("href"))
      .toBe("https://example.com/afm.png");
  });

  it("renders only Comment and image-note timeline bodies as rich text", async () => {
    const view = render(<SampleTimeline events={[
      event({ id: "comment", kind: "comment", body: "**Measured** $R_a$" }),
      event({ id: "status", kind: "status", body: "Status *stored*" }),
    ]} />);

    await waitFor(() => expect(view.container.querySelector('[data-rich-text="comment"]')).not.toBeNull());
    expect(screen.getByText("Measured").tagName).toBe("STRONG");
    expect(view.container.querySelector(".rich-text-math-inline math")).not.toBeNull();
    expect(screen.getByText("Status *stored*").tagName).toBe("P");
  });

  it("keeps uploading and failed Run-step Comments plain on SamplePage while rendering ready Comments", async () => {
    vi.spyOn(api, "getSample").mockResolvedValue(sampleWithStepComments(["ready", "uploading", "failed"]));
    vi.spyOn(api, "getManagedStorageStatus").mockResolvedValue({
      provider: null,
      available: false,
      authentication: "not_configured",
      message: "Attachments unavailable in this test.",
    });

    const router = createMemoryRouter([{
      path: "/samples/:sampleId",
      element: <SamplePage />,
    }], { initialEntries: ["/samples/sample-a"] });
    const view = render(<RouterProvider router={router} />);

    await screen.findByRole("heading", { name: "Comment boundary sample" });
    await waitFor(() => expect(view.container.querySelectorAll('[data-rich-text="comment"]')).toHaveLength(1));
    expect(screen.getByText("Ready").tagName).toBe("STRONG");
    expect(view.container.querySelector(".rich-text-math-inline math")).not.toBeNull();
    expect(screen.getByText("**uploading** $x_1$").tagName).toBe("P");
    expect(screen.getByText("**failed** $x_2$").tagName).toBe("P");
    expect(screen.getByText("Uploading…")).toBeTruthy();
    expect(screen.getByText("Upload incomplete")).toBeTruthy();
    router.dispose();
  });

  it("never executes raw HTML from a Comment body", async () => {
    const view = render(<CommentBody source={'<script>alert("x")</script>'} />);
    await waitFor(() => expect(view.container.querySelector('[data-rich-text="comment"]')).not.toBeNull());
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.textContent).toContain('<script>alert("x")</script>');
  });
});
