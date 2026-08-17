import { describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../../shared/project-api";
import { projectTestSnapshot } from "../project-test-fixture";
import { projectCanvasKeyboardShortcutFromEvent } from "./project-canvas-productivity";
import {
  buildProjectCanvasClipboard,
  createProjectCanvasPasteJournal,
  executeProjectCanvasPasteJournal,
  projectCanvasPasteDestinationItemIds,
  projectCanvasPasteHasAcknowledgedWrites,
  type ProjectCanvasPasteClients,
} from "./project-canvas-copy-paste";

function copyPasteSnapshot(): ProjectSnapshot {
  const snapshot = projectTestSnapshot();
  const actor = "user@example.com";
  const createdAt = "2026-08-11T08:00:00.000Z";
  return {
    ...snapshot,
    project: {
      ...snapshot.project,
      revision: 4,
      nextCreatedSequence: 5,
    },
    contents: [...snapshot.contents, {
      id: "content-attachment",
      projectId: snapshot.project.id,
      contentType: "attachment",
      markdownSource: null,
      attachmentCaption: "SEM image",
      attachmentSourceUrl: "https://example.com/source",
      formatVersion: 1,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    }, {
      id: "content-outside",
      projectId: snapshot.project.id,
      contentType: "markdown",
      markdownSource: "Outside selection",
      attachmentCaption: null,
      attachmentSourceUrl: null,
      formatVersion: 1,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    }],
    attachments: [...snapshot.attachments, {
      projectContentId: "content-attachment",
      originalName: "sem.png",
      mimeType: "image/png",
      byteSize: 42,
      createdBy: actor,
      createdAt,
      fileUrl: "/api/projects/project-a/contents/content-attachment/file",
    }],
    items: [...snapshot.items, {
      id: "item-attachment",
      projectId: snapshot.project.id,
      itemType: "content",
      projectContentId: "content-attachment",
      referenceTargetId: null,
      createdSequence: 3,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    }, {
      id: "item-outside",
      projectId: snapshot.project.id,
      itemType: "content",
      projectContentId: "content-outside",
      referenceTargetId: null,
      createdSequence: 4,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    }],
    placements: [...snapshot.placements, {
      id: "placement-attachment",
      projectItemId: "item-attachment",
      x: 80,
      y: 280,
      width: 300,
      height: 220,
      zIndex: 2,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
    }, {
      id: "placement-outside",
      projectItemId: "item-outside",
      x: 700,
      y: 100,
      width: 220,
      height: 140,
      zIndex: 3,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
    }],
    edges: [{
      id: "edge-note-reference",
      projectId: snapshot.project.id,
      sourceItemId: "item-note",
      targetItemId: "item-reference",
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: "internal",
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    }, {
      id: "edge-attachment-note",
      projectId: snapshot.project.id,
      sourceItemId: "item-attachment",
      targetItemId: "item-note",
      sourceHandle: "top",
      targetHandle: "bottom",
      markerStart: "none",
      markerEnd: "none",
      label: null,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt: "2026-08-11T08:01:00.000Z",
      updatedAt: "2026-08-11T08:01:00.000Z",
      deletedAt: null,
      deletedBy: null,
    }, {
      id: "edge-boundary",
      projectId: snapshot.project.id,
      sourceItemId: "item-note",
      targetItemId: "item-outside",
      sourceHandle: "bottom",
      targetHandle: "top",
      markerStart: "none",
      markerEnd: "arrow",
      label: "boundary",
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt: "2026-08-11T08:02:00.000Z",
      updatedAt: "2026-08-11T08:02:00.000Z",
      deletedAt: null,
      deletedBy: null,
    }],
  };
}

function deterministicIdentity(kind: string, _sourceId: string, ordinal: number) {
  return `${kind}-${ordinal}`;
}

describe("authoritative Project Canvas copy/paste", () => {
  it("classifies copy and paste chords only outside the editable-target boundary", () => {
    const shortcut = (key: string, options: Partial<KeyboardEvent> = {}) => (
      projectCanvasKeyboardShortcutFromEvent({
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        ...options,
      })
    );
    expect(shortcut("c", { ctrlKey: true })).toBe("copy");
    expect(shortcut("v", { metaKey: true })).toBe("paste");
    expect(shortcut("v", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(shortcut("c", { ctrlKey: true, isComposing: true })).toBeNull();
  });

  it("freezes authoritative payloads and copies only edges internal to the selection", () => {
    const snapshot = copyPasteSnapshot();
    const clipboard = buildProjectCanvasClipboard(snapshot, [
      "item-attachment",
      "item-reference",
      "item-note",
      "item-note",
    ]);

    expect(clipboard?.items.map((item) => item.kind)).toEqual([
      "markdown",
      "reference",
      "attachment",
    ]);
    expect(clipboard?.items[0]).toMatchObject({
      sourceItemId: "item-note",
      markdownSource: "# Design note\n\nPreserve the occurrence identity.",
    });
    expect(clipboard?.items[1]).toMatchObject({
      sourceItemId: "item-reference",
      target: { type: "sample", id: "sample-a" },
    });
    expect(clipboard?.items[2]).toMatchObject({
      sourceItemId: "item-attachment",
      sourceContentId: "content-attachment",
      caption: "SEM image",
      sourceUrl: "https://example.com/source",
    });
    expect(clipboard?.edges.map((edge) => edge.sourceEdgeId)).toEqual([
      "edge-note-reference",
      "edge-attachment-note",
    ]);
    expect(clipboard?.edges.some((edge) => edge.sourceEdgeId === "edge-boundary")).toBe(false);
  });

  it("allocates fresh authoritative identities and preserves relative geometry", () => {
    const snapshot = copyPasteSnapshot();
    const clipboard = buildProjectCanvasClipboard(snapshot, [
      "item-note",
      "item-reference",
      "item-attachment",
    ])!;
    const journal = createProjectCanvasPasteJournal(snapshot, clipboard, {
      pasteOrdinal: 1,
      createIdentity: deterministicIdentity,
    });

    expect(journal.baseProjectRevision).toBe(4);
    expect(journal.itemSteps.map((step) => step.input.expectedProjectRevision)).toEqual([
      4,
      5,
      6,
    ]);
    expect(journal.itemSteps.map((step) => step.destinationItemId)).not.toContain("item-note");
    expect(new Set(journal.itemSteps.map((step) => step.input.operationId)).size).toBe(3);

    const markdown = journal.itemSteps.find((step) => step.kind === "markdown")!;
    const reference = journal.itemSteps.find((step) => step.kind === "reference")!;
    const attachment = journal.itemSteps.find((step) => step.kind === "attachment")!;
    expect(markdown.input.contentId).not.toBe("content-note");
    expect(markdown.input.markdownSource).toContain("Preserve the occurrence identity");
    expect(reference.input.target).toEqual({ type: "sample", id: "sample-a" });
    expect(attachment.input.sourceContentId).toBe("content-attachment");
    expect(attachment.input.contentId).not.toBe("content-attachment");
    expect("locator" in attachment.input).toBe(false);

    expect(markdown.input.geometry.x).toBe(52);
    expect(reference.input.geometry.x - markdown.input.geometry.x).toBe(300);
    expect(attachment.input.geometry.y - markdown.input.geometry.y).toBe(240);
    expect(markdown.input.geometry.zIndex).toBe(4);
    expect(reference.input.geometry.zIndex).toBe(5);
    expect(attachment.input.geometry.zIndex).toBe(6);

    const destinations = new Map(journal.itemSteps.map((step) => [
      step.sourceItemId,
      step.destinationItemId,
    ]));
    expect(journal.edgeSteps).toHaveLength(2);
    expect(journal.edgeSteps[0].input).toMatchObject({
      sourceItemId: destinations.get("item-note"),
      targetItemId: destinations.get("item-reference"),
      expectedSourceItemRevision: 1,
      expectedTargetItemRevision: 1,
    });
    expect(projectCanvasPasteDestinationItemIds(journal)).toEqual(
      journal.itemSteps.map((step) => step.destinationItemId),
    );
  });

  it("pauses on one independent write and resumes the exact frozen journal", async () => {
    const snapshot = copyPasteSnapshot();
    const clipboard = buildProjectCanvasClipboard(snapshot, [
      "item-note",
      "item-reference",
      "item-attachment",
    ])!;
    const journal = createProjectCanvasPasteJournal(snapshot, clipboard, {
      createIdentity: deterministicIdentity,
    });
    const calls: Array<{ kind: string; input: unknown }> = [];
    const referenceFailure = new Error("revision conflict");
    let failReference = true;
    const clients: ProjectCanvasPasteClients = {
      createMarkdownItem: vi.fn(async (_projectId, input) => {
        calls.push({ kind: "markdown", input });
      }),
      createReferenceItem: vi.fn(async (_projectId, input) => {
        calls.push({ kind: "reference", input });
        if (failReference) {
          failReference = false;
          throw referenceFailure;
        }
      }),
      copyAttachmentItem: vi.fn(async (_projectId, input) => {
        calls.push({ kind: "attachment", input });
      }),
      createEdge: vi.fn(async (_projectId, input) => {
        calls.push({ kind: "edge", input });
      }),
    };

    const paused = await executeProjectCanvasPasteJournal(journal, clients);
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") throw new Error("Expected a paused paste");
    expect(paused.error).toBe(referenceFailure);
    expect(paused.failedStep).toMatchObject({
      kind: "item",
      sourceId: "item-reference",
    });
    expect(paused.journal.itemSteps.map((step) => step.status)).toEqual([
      "acknowledged",
      "pending",
      "pending",
    ]);
    expect(projectCanvasPasteHasAcknowledgedWrites(paused.journal)).toBe(true);
    const failedInput = calls.at(-1)?.input;

    const completed = await executeProjectCanvasPasteJournal(paused.journal, clients);
    expect(completed.status).toBe("complete");
    expect(completed.journal.itemSteps.every((step) => step.status === "acknowledged")).toBe(true);
    expect(completed.journal.edgeSteps.every((step) => step.status === "acknowledged")).toBe(true);
    expect(calls.filter((call) => call.kind === "markdown")).toHaveLength(1);
    expect(calls.filter((call) => call.kind === "reference")).toHaveLength(2);
    expect(calls.filter((call) => call.kind === "reference")[1].input).toEqual(failedInput);
  });

  it("keeps a lost-response step pending so retry replays the same identity and operation", async () => {
    const snapshot = copyPasteSnapshot();
    const clipboard = buildProjectCanvasClipboard(snapshot, ["item-note"])!;
    const journal = createProjectCanvasPasteJournal(snapshot, clipboard, {
      createIdentity: deterministicIdentity,
    });
    const attemptedInputs: unknown[] = [];
    let loseResponse = true;
    const clients: ProjectCanvasPasteClients = {
      createMarkdownItem: async (_projectId, input) => {
        attemptedInputs.push(input);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("response lost after commit");
        }
      },
      createReferenceItem: vi.fn(),
      copyAttachmentItem: vi.fn(),
      createEdge: vi.fn(),
    };

    const paused = await executeProjectCanvasPasteJournal(journal, clients);
    expect(paused.status).toBe("paused");
    expect(paused.journal.itemSteps[0].status).toBe("pending");
    const completed = await executeProjectCanvasPasteJournal(paused.journal, clients);
    expect(completed.status).toBe("complete");
    expect(attemptedInputs).toHaveLength(2);
    expect(attemptedInputs[1]).toEqual(attemptedInputs[0]);
  });

  it("rejects partial or cross-Project clipboard reconstruction", () => {
    const snapshot = copyPasteSnapshot();
    expect(() => buildProjectCanvasClipboard(snapshot, ["missing-item"])).toThrow(
      "is not available for copy",
    );
    const clipboard = buildProjectCanvasClipboard(snapshot, ["item-note"])!;
    expect(() => createProjectCanvasPasteJournal({
      ...snapshot,
      project: { ...snapshot.project, id: "another-project" },
    }, clipboard)).toThrow("limited to one authoritative Project");
  });
});
