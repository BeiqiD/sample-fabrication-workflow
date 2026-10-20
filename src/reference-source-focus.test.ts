import { createMemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  decodeReferenceSourceFocus,
  encodeReferenceSourceFocus,
} from "../shared/reference-destinations";
import type { ReferenceTarget } from "../shared/reference-types";
import type {
  CommentAttachment,
  CommentImage,
  CommentSubmission,
  ProcessingSampleDetail,
  RunStep,
  RunStepComment,
  SampleDetail,
  SampleRun,
} from "../shared/types";
import type { TemplateDetail } from "./lib/api";
import {
  findMetrologyReferenceFocus,
  findProcessingReferenceFocus,
  findSampleReferenceFocus,
  processingFocusColumns,
} from "./lib/reference-source-focus";

const timestamp = "2026-08-08T12:00:00.000Z";

function commentImage(id: string): CommentImage {
  return {
    id,
    filename: `${id}.png`,
    mimeType: "image/png",
    byteSize: 120,
    originalFilename: `${id}-original.png`,
    originalMimeType: "image/png",
    originalByteSize: 140,
    assetKey: `private/${id}.png`,
    status: "ready",
    error: null,
    relatedAttachmentId: null,
  };
}

function fileAttachment(id: string): CommentAttachment {
  return {
    id,
    kind: "file",
    title: `${id} title`,
    description: `${id} description`,
    filename: `${id}.pdf`,
    mimeType: "application/pdf",
    byteSize: 2048,
    sha256: null,
    downloadUrl: `/api/comment-attachments/${id}`,
    status: "ready",
    error: null,
    relatedCommentImageId: null,
  };
}

function linkAttachment(id: string): CommentAttachment {
  return {
    id,
    kind: "link",
    title: `${id} title`,
    description: `${id} description`,
    url: `https://example.test/${id}`,
    status: "ready",
    error: null,
  };
}

function runComment(overrides: Partial<RunStepComment> = {}): RunStepComment {
  return {
    id: "occurrence-a",
    scope: "common",
    operationGroupId: "comment-group",
    body: "Focused comment",
    assetKey: null,
    submissionId: "logical-comment",
    status: "ready",
    images: [commentImage("comment-image")],
    attachments: [fileAttachment("comment-file"), linkAttachment("comment-link")],
    actorEmail: "user@example.test",
    createdAt: timestamp,
    ...overrides,
  };
}

function runStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: "step-a",
    templateStepId: "template-step",
    logicalStepKey: "logical-step",
    sectionName: null,
    definitionHash: null,
    expectedStateHash: null,
    position: 0,
    planPosition: 0,
    origin: "template",
    entryKind: "fabrication",
    planStatus: "current",
    title: "Focused step",
    status: "pending",
    notes: null,
    toolName: null,
    parametersText: null,
    commentsText: null,
    deviationNote: null,
    plannedTitle: "Focused step",
    plannedToolName: null,
    plannedParametersText: null,
    plannedCommentsText: null,
    plannedImageKeys: [],
    executionImageKeys: [],
    comments: [runComment()],
    actualizedAt: null,
    verificationIds: [],
    stateVerification: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function sampleRun(id: string, steps: RunStep[]): SampleRun {
  return {
    id,
    recipeFamilyId: "family-a",
    templateVersionId: "template-a",
    templateName: "Process A",
    templateType: "process",
    templateVersion: 1,
    runKind: "process",
    status: "active",
    currentPlanRevisionId: "plan-a",
    planRevisionNumber: 1,
    predecessorRunId: null,
    anchorStepId: null,
    sequenceNo: 1,
    runGroupId: "group-a",
    initialStateHash: null,
    initialStateImageKeys: [],
    createdAt: timestamp,
    completedAt: null,
    steps,
  };
}

function processingSample(id: string, code: string, runs: SampleRun[]): ProcessingSampleDetail {
  return {
    id,
    code,
    title: `Sample ${code}`,
    status: "active",
    location: null,
    parentId: null,
    inheritedStateHash: null,
    pinned: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    latestWorkflowName: "Process A",
    latestWorkflowVersion: 1,
    latestRunStatus: "active",
    currentStepTitle: "Focused step",
    currentStateStepTitle: null,
    currentStateThumbnailKey: null,
    runs,
    stateVerifications: [],
  };
}

function sampleComment(id: string, createdAt: string, images: CommentImage[] = []): CommentSubmission {
  return {
    id,
    contextKind: "sample",
    scope: null,
    body: `Sample comment ${id}`,
    status: "ready",
    error: null,
    images,
    attachments: [],
    actorEmail: "user@example.test",
    createdAt,
    updatedAt: createdAt,
  };
}

function sampleDetail(comments: CommentSubmission[]): SampleDetail {
  return {
    ...processingSample("sample-a", "A", []),
    description: null,
    parent: null,
    children: [],
    events: [],
    comments,
  };
}

function focusFromLocation(search: string) {
  return decodeReferenceSourceFocus(new URLSearchParams(search).get("focus"));
}

describe("reference source focus", () => {
  it("locates exact Steps, Comments, occurrences, attachments, and execution images in one grid context", () => {
    const individual = runComment({
      id: "individual-occurrence",
      scope: "individual",
      operationGroupId: null,
      submissionId: "individual-comment",
      images: [],
      attachments: [],
    });
    const primaryStep = runStep({ comments: [runComment(), individual] });
    const secondaryStep = runStep({
      id: "step-b",
      comments: [runComment({ id: "occurrence-b" })],
    });
    const primary = processingSample("sample-a", "A", [sampleRun("run-a", [primaryStep])]);
    const secondary = processingSample("sample-b", "B", [sampleRun("run-b", [secondaryStep])]);
    const columns = processingFocusColumns(primary, "run-a", [secondary]);

    expect(findProcessingReferenceFocus(columns, "sample-a", "step-a", {
      type: "run_step",
      id: "step-a",
    })).toEqual(expect.objectContaining({ rowIndex: 0, columnIndex: 0, step: primaryStep }));

    expect(findProcessingReferenceFocus(columns, "sample-a", "step-a", {
      type: "comment",
      id: "logical-comment",
    })).toEqual(expect.objectContaining({
      rowIndex: 0,
      columnIndex: 0,
      comment: expect.objectContaining({ id: "occurrence-a" }),
      commonCommentIndex: 0,
    }));

    expect(findProcessingReferenceFocus(columns, "sample-a", "step-a", {
      type: "comment_occurrence",
      id: "individual-occurrence",
    })).toEqual(expect.objectContaining({
      comment: expect.objectContaining({ submissionId: "individual-comment" }),
      commentIndex: 0,
    }));

    expect(findProcessingReferenceFocus(columns, "sample-a", "step-a", {
      type: "comment_attachment",
      id: "comment-image",
    })?.preview).toEqual(expect.objectContaining({
      kind: "image",
      id: "comment-image",
      assetUrl: "/api/assets/private/comment-image.png",
    }));

    expect(findProcessingReferenceFocus(columns, "sample-a", "step-a", {
      type: "comment_attachment",
      id: "comment-file",
    })?.preview).toEqual(expect.objectContaining({
      kind: "file",
      id: "comment-file",
      downloadUrl: "/api/comment-attachments/comment-file",
    }));

    expect(findProcessingReferenceFocus(columns, "sample-a", "step-a", {
      type: "comment_attachment",
      id: "comment-link",
    })?.preview).toEqual(expect.objectContaining({
      kind: "link",
      id: "comment-link",
      url: "https://example.test/comment-link",
    }));

    expect(findProcessingReferenceFocus(columns, "sample-a", "step-a", {
      type: "execution_image",
      id: "execution-occurrence",
    })?.preview).toEqual({
      kind: "execution_image",
      id: "execution-occurrence",
      title: "Execution image for Focused step",
      stepId: "step-a",
    });

    expect(findProcessingReferenceFocus(columns, "sample-a", "wrong-step", {
      type: "comment",
      id: "logical-comment",
    })).toBeNull();
    expect(findProcessingReferenceFocus(columns, "sample-b", "step-a", {
      type: "comment_occurrence",
      id: "occurrence-a",
    })).toBeNull();
  });

  it("focuses direct Sample Comments beyond the recent-three preview without reclassifying process comments", () => {
    const comments = Array.from({ length: 5 }, (_, index) => sampleComment(
      `sample-comment-${index}`,
      `2026-08-08T12:0${4 - index}:00.000Z`,
      index === 4 ? [commentImage("sample-image")] : [],
    ));
    const sample = sampleDetail(comments);

    expect(findSampleReferenceFocus(sample, {
      type: "comment",
      id: "sample-comment-4",
    })).toEqual({ noteIndex: 4, preview: null });

    expect(findSampleReferenceFocus(sample, {
      type: "comment_attachment",
      id: "sample-image",
    })).toEqual({
      noteIndex: 4,
      preview: expect.objectContaining({ kind: "image", id: "sample-image" }),
    });

    expect(findSampleReferenceFocus(sample, {
      type: "comment",
      id: "logical-comment",
    })).toBeNull();
  });

  it("locates only the exact metrology reference occurrence", () => {
    const template = {
      id: "metrology-template",
      referenceAttachments: [
        { id: "reference-a" },
        { id: "reference-b" },
      ],
    } as unknown as TemplateDetail;

    expect(findMetrologyReferenceFocus(template, {
      type: "metrology_reference",
      id: "reference-b",
    })).toEqual({ referenceIndex: 1 });
    expect(findMetrologyReferenceFocus(template, {
      type: "metrology_reference",
      id: "missing-reference",
    })).toBeNull();
    expect(findMetrologyReferenceFocus(template, {
      type: "recipe_revision",
      id: "metrology-template",
    })).toBeNull();
  });

  it("restores focus through MemoryRouter navigation, Back, Forward, and refresh reconstruction", async () => {
    const first: ReferenceTarget = { type: "run_step", id: "step/one" };
    const second: ReferenceTarget = { type: "comment_attachment", id: "attachment%2Ftwo" };
    const firstPath = `/processing/sample-a?run=run-a&step=step%2Fone&focus=${encodeURIComponent(encodeReferenceSourceFocus(first))}`;
    const secondPath = `/samples/sample-a?focus=${encodeURIComponent(encodeReferenceSourceFocus(second))}`;
    const routes = [{ path: "*", element: null }];
    const router = createMemoryRouter(routes, { initialEntries: [firstPath] });

    expect(focusFromLocation(router.state.location.search)).toEqual(first);
    await router.navigate(secondPath);
    expect(focusFromLocation(router.state.location.search)).toEqual(second);
    await router.navigate(-1);
    expect(focusFromLocation(router.state.location.search)).toEqual(first);
    await router.navigate(1);
    expect(focusFromLocation(router.state.location.search)).toEqual(second);

    const refreshPath = `${router.state.location.pathname}${router.state.location.search}`;
    const refreshed = createMemoryRouter(routes, { initialEntries: [refreshPath] });
    expect(focusFromLocation(refreshed.state.location.search)).toEqual(second);
    router.dispose();
    refreshed.dispose();
  });
});
