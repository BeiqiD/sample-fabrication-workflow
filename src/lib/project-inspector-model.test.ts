import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../../shared/project-api";
import { projectTestSnapshot } from "../project-test-fixture";
import {
  projectInspectorProjection,
  projectInspectorReferenceTypeLabel,
} from "./project-inspector-model";
import { projectMapNodes } from "./project-map-model";

function fieldValue(
  fields: Array<{ label: string; value: string }>,
  label: string,
) {
  return fields.find((field) => field.label === label)?.value;
}

function referenceSnapshot(): ProjectSnapshot {
  const snapshot = projectTestSnapshot();
  const reference = snapshot.references[0];
  const createdAt = snapshot.project.createdAt;
  reference.resolution = {
    target: { type: "comment_attachment", id: "attachment-source" },
    resolution: "resolved",
    source: {
      title: "Cross-section image",
      subtitle: "Comment attachment",
      excerpt: "SEM cross-section after etch",
      kind: "comment_attachment",
      state: "ready",
      updatedAt: createdAt,
      deletedAt: null,
      archivedAt: null,
    },
    contexts: [{
      segments: [{
        type: "sample",
        id: "sample-a",
        label: "Sample A",
        deletedAt: null,
        archivedAt: null,
      }, {
        type: "run",
        id: "run-a",
        label: "Etch run",
        deletedAt: null,
        archivedAt: null,
      }, {
        type: "run_step",
        id: "step-a",
        label: "ICP etch",
        deletedAt: null,
        archivedAt: null,
      }],
    }],
    destination: {
      referenceUrl: "/references/comment_attachment/r1_attachment-source",
      mode: "source",
      openSourceUrl: "/processing/sample-a?run=run-a&step=step-a",
      contextOpenSourceUrls: ["/processing/sample-a?run=run-a&step=step-a"],
    },
  };
  snapshot.edges = [{
    id: "edge-in",
    projectId: snapshot.project.id,
    sourceItemId: "item-note",
    targetItemId: "item-reference",
    sourceHandle: "right",
    targetHandle: "left",
    markerStart: "none",
    markerEnd: "arrow",
    label: "motivates",
    revision: 1,
    createdBy: "user@example.com",
    updatedBy: "user@example.com",
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletedBy: null,
  }, {
    id: "edge-out",
    projectId: snapshot.project.id,
    sourceItemId: "item-reference",
    targetItemId: "item-note",
    sourceHandle: "left",
    targetHandle: "right",
    markerStart: "none",
    markerEnd: "none",
    label: null,
    revision: 1,
    createdBy: "user@example.com",
    updatedBy: "user@example.com",
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletedBy: null,
  }];
  return snapshot;
}

describe("Project Inspector authoritative projection", () => {
  it("keeps occurrence identity distinct from source identity and exposes hierarchy", () => {
    const snapshot = referenceSnapshot();
    const descriptor = projectMapNodes(snapshot)
      .find((candidate) => candidate.itemId === "item-reference");
    expect(descriptor).toBeTruthy();

    const projection = projectInspectorProjection(snapshot, descriptor!);
    expect(projection).toBeTruthy();
    expect(fieldValue(projection!.occurrenceFields, "Occurrence")).toBe("item-reference");
    expect(fieldValue(projection!.identityFields, "Source identity"))
      .toBe("comment_attachment:attachment-source");
    expect(fieldValue(projection!.identityFields, "Registry identity"))
      .toBe("registry-sample");
    expect(fieldValue(projection!.detailFields, "Media state")).toBe("ready");
    expect(projection!.relationshipSummary).toBe("1 incoming · 1 outgoing");
    expect(projection!.relationships.map((relationship) => relationship.direction))
      .toEqual(["incoming", "outgoing"]);
    expect(projection!.contexts).toEqual([{
      label: "Sample A › Etch run › ICP etch",
      segments: [{
        type: "Sample",
        id: "sample-a",
        label: "Sample A",
        lifecycle: "active",
      }, {
        type: "Run",
        id: "run-a",
        label: "Etch run",
        lifecycle: "active",
      }, {
        type: "Step",
        id: "step-a",
        label: "ICP etch",
        lifecycle: "active",
      }],
      openSourceUrl: "/processing/sample-a?run=run-a&step=step-a",
    }]);
    expect(projection!.primaryAction).toEqual({
      href: "/processing/sample-a?run=run-a&step=step-a",
      label: "Open exact source",
      external: false,
    });
  });

  it("keeps tombstoned lifecycle visible when the live source summary is absent", () => {
    const snapshot = referenceSnapshot();
    const reference = snapshot.references[0];
    reference.resolution = {
      ...reference.resolution,
      resolution: "tombstoned",
      source: null,
      destination: {
        referenceUrl: "/references/comment_attachment/r1_attachment-source",
        mode: "archived",
        openSourceUrl: null,
        contextOpenSourceUrls: [null],
      },
    };
    const descriptor = projectMapNodes(snapshot)
      .find((candidate) => candidate.itemId === "item-reference")!;
    const projection = projectInspectorProjection(snapshot, descriptor)!;

    expect(fieldValue(projection.identityFields, "Source lifecycle")).toBe("deleted");
    expect(fieldValue(projection.detailFields, "Resolution")).toBe("tombstoned");
    expect(projection.primaryAction?.label).toBe("Open reference record");
  });

  it("falls back to the canonical reference record when a source is ambiguous", () => {
    const snapshot = referenceSnapshot();
    const reference = snapshot.references[0];
    reference.resolution.destination = {
      referenceUrl: "/references/comment_attachment/r1_attachment-source",
      mode: "source",
      openSourceUrl: null,
      contextOpenSourceUrls: ["/processing/sample-a?run=run-a&step=step-a"],
    };
    const descriptor = projectMapNodes(snapshot)
      .find((candidate) => candidate.itemId === "item-reference")!;
    expect(projectInspectorProjection(snapshot, descriptor)?.primaryAction).toEqual({
      href: "/references/comment_attachment/r1_attachment-source",
      label: "Open reference record",
      external: false,
    });
  });

  it("describes Project-owned Markdown without inventing source provenance", () => {
    const snapshot = projectTestSnapshot();
    snapshot.contents[0].markdownSource = "A😀B";
    const descriptor = projectMapNodes(snapshot)
      .find((candidate) => candidate.itemId === "item-note")!;
    const projection = projectInspectorProjection(snapshot, descriptor)!;

    expect(projection.identityHeading).toBe("Project-owned content");
    expect(fieldValue(projection.identityFields, "Ownership")).toBe("Project-owned");
    expect(fieldValue(projection.identityFields, "Content identity")).toBe("content-note");
    expect(fieldValue(projection.detailFields, "Content type")).toBe("Markdown");
    expect(fieldValue(projection.detailFields, "Characters")).toBe("3");
    expect(projection.contexts).toEqual([]);
    expect(projection.primaryAction).toBeNull();
  });

  it("previews only image attachments while retaining the original file action", () => {
    const snapshot = projectTestSnapshot();
    const createdAt = snapshot.project.createdAt;
    snapshot.contents.push({
      id: "content-image",
      projectId: snapshot.project.id,
      contentType: "attachment",
      markdownSource: null,
      attachmentCaption: "AFM overview",
      attachmentSourceUrl: null,
      formatVersion: 1,
      revision: 2,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    });
    snapshot.attachments.push({
      projectContentId: "content-image",
      originalName: "afm.png",
      mimeType: "image/png",
      byteSize: 12_500,
      createdBy: "user@example.com",
      createdAt,
      fileUrl: "/api/project-assets/afm.png",
    });
    snapshot.items.push({
      id: "item-image",
      projectId: snapshot.project.id,
      itemType: "content",
      projectContentId: "content-image",
      referenceTargetId: null,
      createdSequence: 3,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    });
    snapshot.placements.push({
      id: "placement-image",
      projectItemId: "item-image",
      x: 600,
      y: 40,
      width: 260,
      height: 180,
      zIndex: 2,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt,
      updatedAt: createdAt,
    });

    const descriptor = projectMapNodes(snapshot)
      .find((candidate) => candidate.itemId === "item-image")!;
    const projection = projectInspectorProjection(snapshot, descriptor)!;
    expect(fieldValue(projection.detailFields, "MIME type")).toBe("image/png");
    expect(fieldValue(projection.detailFields, "File size")).toBe("13 kB");
    expect(projection.media).toEqual({
      url: "/api/project-assets/afm.png",
      alt: "AFM overview",
    });
    expect(projection.primaryAction?.label).toBe("Open attachment");
  });

  it("uses explicit labels for every supported reference target", () => {
    expect([
      "sample",
      "run",
      "run_step",
      "comment",
      "comment_occurrence",
      "comment_attachment",
      "execution_image",
      "metrology_reference",
      "recipe_revision",
    ].map((type) => projectInspectorReferenceTypeLabel(type as Parameters<
      typeof projectInspectorReferenceTypeLabel
    >[0]))).toEqual([
      "Sample",
      "Process run",
      "Run step",
      "Comment",
      "Comment occurrence",
      "Comment attachment",
      "Execution image",
      "Metrology reference",
      "Recipe revision",
    ]);
  });
});
