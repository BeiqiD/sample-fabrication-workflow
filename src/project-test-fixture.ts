import type { ProjectSnapshot } from "../shared/project-api";

export function projectTestSnapshot(): ProjectSnapshot {
  const actor = "user@example.com";
  const createdAt = "2026-08-11T08:00:00.000Z";
  return {
    schemaVersion: 1,
    project: {
      id: "project-a",
      title: "Topological laser",
      revision: 2,
      nextCreatedSequence: 3,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    },
    contents: [{
      id: "content-note",
      projectId: "project-a",
      contentType: "markdown",
      markdownSource: "# Design note\n\nPreserve the occurrence identity.",
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
    attachments: [],
    items: [{
      id: "item-reference",
      projectId: "project-a",
      itemType: "reference",
      projectContentId: null,
      referenceTargetId: "registry-sample",
      createdSequence: 2,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    }, {
      id: "item-note",
      projectId: "project-a",
      itemType: "content",
      projectContentId: "content-note",
      referenceTargetId: null,
      createdSequence: 1,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    }],
    placements: [{
      id: "placement-reference",
      projectItemId: "item-reference",
      x: 320,
      y: 40,
      width: 240,
      height: 150,
      zIndex: 1,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
    }, {
      id: "placement-note",
      projectItemId: "item-note",
      x: 20,
      y: 40,
      width: 250,
      height: 180,
      zIndex: 0,
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
    }],
    edges: [],
    references: [{
      registryId: "registry-sample",
      resolution: {
        target: { type: "sample", id: "sample-a" },
        resolution: "resolved",
        source: {
          title: "Sample A",
          subtitle: "Stored sample",
          excerpt: "A source record",
          kind: "sample",
          state: "stored",
          updatedAt: createdAt,
          deletedAt: null,
          archivedAt: null,
        },
        contexts: [],
        destination: {
          referenceUrl: "/references/sample/r1_sample-a",
          mode: "source",
          openSourceUrl: "/samples/sample-a",
          contextOpenSourceUrls: ["/samples/sample-a"],
        },
      },
    }],
  };
}

export function projectTestSnapshotWithAttachment(): ProjectSnapshot {
  const snapshot = projectTestSnapshot();
  const markdownContent = snapshot.contents.find((content) => content.id === "content-note")!;
  const markdownItem = snapshot.items.find((item) => item.id === "item-note")!;
  const markdownPlacement = snapshot.placements.find(
    (placement) => placement.projectItemId === "item-note",
  )!;
  snapshot.project.nextCreatedSequence = 4;
  snapshot.contents.push({
    ...markdownContent,
    id: "content-attachment",
    contentType: "attachment",
    markdownSource: null,
    attachmentCaption: "Evidence",
    attachmentSourceUrl: null,
  });
  snapshot.attachments.push({
    projectContentId: "content-attachment",
    originalName: "evidence.pdf",
    mimeType: "application/pdf",
    byteSize: 2_048,
    createdBy: markdownContent.createdBy,
    createdAt: markdownContent.createdAt,
    fileUrl: "/api/projects/project-a/contents/content-attachment/file",
  });
  snapshot.items.push({
    ...markdownItem,
    id: "item-attachment",
    projectContentId: "content-attachment",
    createdSequence: 3,
  });
  snapshot.placements.push({
    ...markdownPlacement,
    id: "placement-attachment",
    projectItemId: "item-attachment",
    x: 600,
    width: 180,
    zIndex: 2,
  });
  return snapshot;
}
