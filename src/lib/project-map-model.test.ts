import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../../shared/project-api";
import { projectTestSnapshotWithAttachment } from "../project-test-fixture";
import {
  applyProjectGeometryCommand,
  applyProjectGeometryCommands,
  normalizeProjectGeometryCommands,
  orderProjectReadingNodes,
  projectDirtyPlacements,
  projectMapNodes,
  projectNodeKindLabel,
  projectReadingNodes,
} from "./project-map-model";

function snapshot(): ProjectSnapshot {
  return {
    schemaVersion: 1,
    project: {
      id: "project-a",
      title: "Map fixture",
      revision: 3,
      nextCreatedSequence: 4,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: "2026-08-11T08:00:00.000Z",
      updatedAt: "2026-08-11T09:00:00.000Z",
      deletedAt: null,
      deletedBy: null,
    },
    contents: [{
      id: "content-markdown",
      projectId: "project-a",
      contentType: "markdown",
      markdownSource: "# First note\n\nLonger explanation",
      attachmentCaption: null,
      attachmentSourceUrl: null,
      formatVersion: 1,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: "2026-08-11T08:01:00.000Z",
      updatedAt: "2026-08-11T08:01:00.000Z",
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
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: "2026-08-11T08:02:00.000Z",
      updatedAt: "2026-08-11T08:02:00.000Z",
      deletedAt: null,
      deletedBy: null,
    }, {
      id: "item-markdown",
      projectId: "project-a",
      itemType: "content",
      projectContentId: "content-markdown",
      referenceTargetId: null,
      createdSequence: 1,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: "2026-08-11T08:01:00.000Z",
      updatedAt: "2026-08-11T08:01:00.000Z",
      deletedAt: null,
      deletedBy: null,
    }],
    placements: [{
      id: "placement-reference",
      projectItemId: "item-reference",
      x: 300,
      y: 80,
      width: 240,
      height: 150,
      zIndex: 1,
      revision: 2,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: "2026-08-11T08:02:00.000Z",
      updatedAt: "2026-08-11T08:03:00.000Z",
    }, {
      id: "placement-markdown",
      projectItemId: "item-markdown",
      x: 20,
      y: 40,
      width: 250,
      height: 180,
      zIndex: 0,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: "2026-08-11T08:01:00.000Z",
      updatedAt: "2026-08-11T08:01:00.000Z",
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
          excerpt: "Reference excerpt",
          kind: "sample",
          state: "stored",
          updatedAt: "2026-08-11T07:00:00.000Z",
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

describe("Project Map projection", () => {
  it("preserves complete Markdown reference excerpts without a second text truncation", () => {
    const fixture = snapshot();
    const source = fixture.references[0].resolution!.source!;
    const excerpt = "QA observation\n\n$$\n" + "x + ".repeat(52) + "y\n$$";
    expect(excerpt.length).toBeGreaterThan(220);
    source.excerpt = excerpt;
    source.excerptFormat = "markdown";
    const reference = projectMapNodes(fixture).find((node) => node.kind === "reference")!;
    expect(reference.excerpt).toBe(excerpt);
    expect(reference.excerptFormat).toBe("markdown");
  });

  it("keeps Project item occurrence identity separate from placement and source identity", () => {
    const nodes = projectMapNodes(snapshot());
    expect(nodes.map((node) => ({
      itemId: node.itemId,
      placementId: node.placementId,
      title: node.title,
      kind: node.kind,
    }))).toEqual([{
      itemId: "item-reference",
      placementId: "placement-reference",
      title: "Sample A",
      kind: "reference",
    }, {
      itemId: "item-markdown",
      placementId: "placement-markdown",
      title: "First note",
      kind: "markdown",
    }]);
  });

  it("uses one stable textual kind vocabulary across Project projections", () => {
    expect([
      projectNodeKindLabel("markdown"),
      projectNodeKindLabel("attachment"),
      projectNodeKindLabel("reference"),
    ]).toEqual(["Project Markdown", "Project attachment", "Reference"]);
    expect(projectMapNodes(snapshot()).find((node) => node.kind === "markdown")?.subtitle).toBeNull();
  });

  it("orders the mobile occurrence projection by immutable sequence", () => {
    expect(projectReadingNodes(snapshot()).map((node) => node.itemId)).toEqual([
      "item-markdown",
      "item-reference",
    ]);
  });

  it("orders complete mixed-record descriptors without mutating Map order or working geometry", () => {
    const fixture = projectTestSnapshotWithAttachment();
    fixture.items = [fixture.items[2], fixture.items[0], fixture.items[1]].map((item, index) => ({
      ...item, createdSequence: index === 0 ? 1 : 3,
    }));
    const canonical = projectMapNodes(fixture);
    const before = structuredClone(canonical);
    const workingGeometry = { ...canonical[2].geometry, x: canonical[2].geometry.x + 80 };
    const projected = Object.freeze(canonical.map((node) => node.itemId === "item-note"
      ? Object.freeze({ ...node, geometry: Object.freeze(workingGeometry) }) : Object.freeze(node)));
    const reading = orderProjectReadingNodes(projected);

    expect(projected.map((node) => node.kind)).toEqual(["attachment", "reference", "markdown"]);
    expect(reading.map((node) => node.itemId)).toEqual(["item-attachment", "item-note", "item-reference"]);
    expect(reading).toEqual([projected[0], projected[2], projected[1]]);
    expect(reading[0]).toBe(projected[0]);
    expect(reading[1]).toBe(projected[2]);
    expect(reading[2]).toBe(projected[1]);
    expect(reading[1].geometry).toBe(workingGeometry);
    expect(projected.map((node) => node.itemId)).toEqual(["item-attachment", "item-reference", "item-note"]);
    expect(canonical).toEqual(before);
    expect(projectReadingNodes(fixture)).toEqual([canonical[0], canonical[2], canonical[1]]);
  });

  it("keeps Reading sequence independent of reversed Map order and returns a separate array", () => {
    const canonical = projectMapNodes(projectTestSnapshotWithAttachment());
    const reversed = Object.freeze([...canonical].reverse());
    const reading = orderProjectReadingNodes(reversed);
    expect(reading).toEqual([canonical[1], canonical[0], canonical[2]]);
    expect(reading.map((node) => node.itemId)).toEqual(["item-note", "item-reference", "item-attachment"]);
    expect(reversed).toEqual([...canonical].reverse());
    expect(reading).not.toBe(reversed);
    expect(reading.every((node) => canonical.includes(node))).toBe(true);
    const empty = Object.freeze([]);
    expect(orderProjectReadingNodes(empty)).toEqual([]);
    expect(orderProjectReadingNodes(empty)).not.toBe(empty);
  });

  it("normalizes one grouped geometry action and applies every placement atomically in history", () => {
    const noteBefore = { x: 20, y: 40, width: 250, height: 180, zIndex: 0 };
    const referenceBefore = { x: 300, y: 80, width: 240, height: 150, zIndex: 1 };
    const commands = normalizeProjectGeometryCommands([{
      placementId: "placement-markdown",
      before: noteBefore,
      after: { ...noteBefore, x: 30 },
    }, {
      placementId: "placement-reference",
      before: referenceBefore,
      after: { ...referenceBefore, x: 310 },
    }, {
      placementId: "placement-markdown",
      before: { ...noteBefore, x: 30 },
      after: { ...noteBefore, x: 40 },
    }]);

    expect(commands).toEqual([{
      placementId: "placement-markdown",
      before: noteBefore,
      after: { ...noteBefore, x: 40 },
    }, {
      placementId: "placement-reference",
      before: referenceBefore,
      after: { ...referenceBefore, x: 310 },
    }]);
    const redone = applyProjectGeometryCommands({}, commands, "redo");
    expect(redone["placement-markdown"].x).toBe(40);
    expect(redone["placement-reference"].x).toBe(310);
    expect(applyProjectGeometryCommands(redone, commands, "undo")).toMatchObject({
      "placement-markdown": noteBefore,
      "placement-reference": referenceBefore,
    });
  });

  it("tracks normalized placement deltas and applies one semantic undo or redo command", () => {
    const fixture = snapshot();
    const baseline = Object.fromEntries(fixture.placements.map((placement) => [placement.id, placement]));
    const command = {
      placementId: "placement-markdown",
      before: { x: 20, y: 40, width: 250, height: 180, zIndex: 0 },
      after: { x: 90, y: 100, width: 320, height: 210, zIndex: 0 },
    };
    const current = applyProjectGeometryCommand({}, command, "redo");
    expect(projectDirtyPlacements(baseline, current)).toEqual([
      ["placement-markdown", command.after],
    ]);
    expect(applyProjectGeometryCommand(current, command, "undo")["placement-markdown"])
      .toEqual(command.before);
  });
});
