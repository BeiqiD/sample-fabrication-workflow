import { describe, expect, it } from "vitest";
import type { RunStep, SampleDetail, SampleEvent, SampleRun, StateVerification } from "../../shared/types";
import { collectSampleNotes } from "./sampleNotes";

function event(overrides: Partial<SampleEvent> = {}): SampleEvent {
  return {
    id: "event-1",
    sampleId: "sample-1",
    kind: "comment",
    body: "Sample-level observation",
    assetKey: null,
    metadata: { action: "sample_record" },
    actorEmail: "sample@example.com",
    createdAt: "2026-07-20T09:00:00.000Z",
    ...overrides,
  };
}

function verification(overrides: Partial<StateVerification> = {}): StateVerification {
  return {
    id: "verification-1",
    sampleId: "sample-1",
    afterRunStepId: "step-1",
    previousVerificationId: null,
    runPlanRevisionId: "revision-1",
    expectedStateHash: "state-1",
    result: "mismatched",
    note: "Observed edge damage",
    status: "valid",
    actorEmail: "verify@example.com",
    createdAt: "2026-07-20T12:00:00.000Z",
    coveredRunStepIds: ["step-1"],
    ...overrides,
  };
}

function step(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: "step-1",
    templateStepId: "template-step-1",
    logicalStepKey: "logical-step-1",
    definitionHash: "definition-1",
    expectedStateHash: "state-1",
    position: 1,
    planPosition: null,
    origin: "template",
    entryKind: "fabrication",
    planStatus: "current",
    title: "RIE etching",
    status: "done",
    notes: null,
    toolName: null,
    parametersText: null,
    commentsText: null,
    deviationNote: "Etch rate was lower than expected",
    plannedTitle: "RIE etching",
    plannedToolName: null,
    plannedParametersText: null,
    plannedCommentsText: null,
    plannedImageKeys: [],
    executionImageKeys: [],
    comments: [{
      id: "comment-1",
      scope: "individual",
      operationGroupId: "operation-1",
      body: "AFM result attached",
      assetKey: "comment-image",
      actorEmail: "process@example.com",
      createdAt: "2026-07-20T11:00:00.000Z",
    }],
    actualizedAt: "2026-07-20T10:00:00.000Z",
    verificationIds: ["verification-1"],
    stateVerification: verification(),
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<SampleRun> = {}): SampleRun {
  return {
    id: "run-1",
    recipeFamilyId: "family-1",
    templateVersionId: "template-1",
    templateName: "Etch process",
    templateType: "process",
    templateVersion: 2,
    runKind: "process",
    status: "active",
    currentPlanRevisionId: "revision-1",
    planRevisionNumber: 1,
    predecessorRunId: null,
    anchorStepId: null,
    sequenceNo: 3,
    runGroupId: "group-1",
    initialStateHash: null,
    initialStateImageKeys: [],
    createdAt: "2026-07-20T08:00:00.000Z",
    completedAt: null,
    steps: [step()],
    ...overrides,
  };
}

function sample(overrides: Partial<SampleDetail> = {}): SampleDetail {
  return {
    id: "sample-1",
    code: "S-001",
    title: "Test sample",
    description: null,
    status: "active",
    location: "Box A",
    parentId: null,
    parent: null,
    children: [],
    pinned: false,
    updatedAt: "2026-07-20T12:00:00.000Z",
    createdAt: "2026-07-20T08:00:00.000Z",
    latestWorkflowName: "Etch process",
    latestWorkflowVersion: 2,
    latestRunStatus: "active",
    currentStepTitle: "RIE etching",
    currentStateStepTitle: null,
    currentStateThumbnailKey: null,
    runs: [run()],
    stateVerifications: [verification()],
    events: [
      event(),
      event({
        id: "verification-event",
        kind: "verification",
        body: "State mismatch recorded",
        assetKey: "verification-image",
        metadata: { verificationId: "verification-1", runId: "run-1", stepId: "step-1", result: "mismatched" },
        createdAt: "2026-07-20T12:00:00.000Z",
      }),
      event({
        id: "audit-step-comment",
        kind: "step",
        body: "Step comment: AFM result attached",
        assetKey: "comment-image",
        metadata: { action: "step_comment", operationGroupId: "operation-1" },
        createdAt: "2026-07-20T11:00:00.000Z",
      }),
    ],
    ...overrides,
  };
}

describe("collectSampleNotes", () => {
  it("aggregates sample records, execution comments, deviations, and mismatches without duplicating audit events", () => {
    const notes = collectSampleNotes(sample());

    expect(notes.map((note) => note.kind)).toEqual([
      "state_mismatch",
      "process_comment",
      "deviation",
      "sample_record",
    ]);
    expect(notes.filter((note) => note.body === "AFM result attached")).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      assetKey: "verification-image",
      context: "Run 3 · Etch process v2 · RIE etching",
      runId: "run-1",
      stepId: "step-1",
    });
  });

  it("omits deleted sample records and folds a blocked-step reason into one observation", () => {
    const notes = collectSampleNotes(sample({
      events: [event({ metadata: { action: "sample_record", deletedAt: "2026-07-21T08:00:00.000Z" } })],
      runs: [run({ steps: [step({ status: "blocked", stateVerification: null, deviationNote: "Waiting for replacement tips" })] })],
    }));

    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ kind: "process_comment" });
    expect(notes[1]).toMatchObject({
      kind: "blocked_step",
      body: "Waiting for replacement tips",
    });
  });

  it("keeps comments from a step removed from the current process plan", () => {
    const notes = collectSampleNotes(sample({
      events: [],
      stateVerifications: [],
      runs: [run({
        steps: [step({
          planStatus: "superseded",
          deviationNote: null,
          stateVerification: null,
        })],
      })],
    }));

    expect(notes).toEqual([
      expect.objectContaining({
        kind: "process_comment",
        body: "AFM result attached",
        stepId: "step-1",
      }),
    ]);
  });

  it("includes user-entered execution detail but not unchanged template text", () => {
    const notes = collectSampleNotes(sample({
      events: [],
      runs: [run({ steps: [step({
        comments: [],
        commentsText: "Measured a lower etch depth",
        plannedCommentsText: "Inspect the surface",
        deviationNote: null,
        stateVerification: null,
      })] })],
    }));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: "execution_detail",
      body: "Measured a lower etch depth",
    });

    expect(collectSampleNotes(sample({
      events: [],
      runs: [run({ steps: [step({
        comments: [],
        commentsText: "Inspect the surface",
        plannedCommentsText: "Inspect the surface",
        deviationNote: null,
        stateVerification: null,
      })] })],
    }))).toEqual([]);
  });
});
