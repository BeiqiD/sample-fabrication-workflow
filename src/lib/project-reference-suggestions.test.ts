import { describe, expect, it } from "vitest";
import type { ReferenceResolution } from "../../shared/reference-types";
import { projectTestSnapshot } from "../project-test-fixture";
import {
  projectReferenceOccurrenceCounts,
  projectReferenceSuggestionSeeds,
  projectReferenceTargetKey,
} from "./project-reference-suggestions";

function suggestionSnapshot() {
  const snapshot = projectTestSnapshot();
  snapshot.references[0].resolution.contexts = [{ segments: [{
    type: "sample", id: "sample-a", label: "Sample A",
    deletedAt: null, archivedAt: null,
  }] }];
  return snapshot;
}

describe("Project reference suggestions", () => {
  it("prioritizes the selected reference and deduplicates the same Project seed", () => {
    const snapshot = suggestionSnapshot();
    expect(projectReferenceSuggestionSeeds(snapshot, { type: "sample", id: "sample-a" }))
      .toEqual([{
        target: { type: "sample", id: "sample-a" },
        title: "Sample A",
        origin: "selection",
      }]);
  });

  it("skips invalid recent and selected references before applying the seed limit", () => {
    const snapshot = suggestionSnapshot();
    const referenceItem = snapshot.items[0];
    for (const [index, status] of (["not_found", "inconsistent", "tombstoned"] as const).entries()) {
      const registryId = `registry-invalid-${index}`;
      snapshot.references.push({
        registryId,
        resolution: {
          ...structuredClone(snapshot.references[0].resolution),
          target: { type: "sample", id: `invalid-${index}` },
          resolution: status,
        },
      });
      snapshot.items.push({
        ...referenceItem,
        id: `item-invalid-${index}`,
        referenceTargetId: registryId,
        createdSequence: 3 + index,
      });
    }

    expect(projectReferenceSuggestionSeeds(snapshot, { type: "sample", id: "invalid-2" }))
      .toEqual([{
        target: { type: "sample", id: "sample-a" }, title: "Sample A", origin: "project",
      }]);
  });

  it.each(["missing source", "deleted source", "deleted ancestor", "missing context"])(
    "does not seed a resolved reference with %s",
    (state) => {
      const snapshot = suggestionSnapshot();
      const resolution = snapshot.references[0].resolution;
      if (state === "missing source") resolution.source = null;
      if (state === "deleted source") resolution.source!.deletedAt = snapshot.project.updatedAt;
      if (state === "deleted ancestor") resolution.contexts[0].segments[0].deletedAt = snapshot.project.updatedAt;
      if (state === "missing context") resolution.contexts = [];
      expect(projectReferenceSuggestionSeeds(snapshot, resolution.target)).toEqual([]);
    },
  );

  it("keeps archived but active references eligible and bounds valid fallback seeds", () => {
    const snapshot = suggestionSnapshot();
    const resolution = snapshot.references[0].resolution;
    resolution.source!.archivedAt = snapshot.project.updatedAt;
    resolution.contexts[0].segments[0].archivedAt = snapshot.project.updatedAt;
    for (let index = 1; index <= 3; index += 1) {
      const registryId = `registry-${index}`;
      snapshot.references.push({
        registryId,
        resolution: {
          ...structuredClone(resolution),
          target: { type: "sample", id: `sample-${index}` },
        },
      });
      snapshot.items.push({
        ...snapshot.items[0], id: `item-${index}`, referenceTargetId: registryId,
        createdSequence: 2 + index,
      });
    }
    expect(projectReferenceSuggestionSeeds(snapshot, resolution.target).map((seed) => seed.target.id))
      .toEqual(["sample-a", "sample-3", "sample-2"]);
  });

  it("uses the deepest eligible source context when the selected target is a leaf", () => {
    const snapshot = projectTestSnapshot();
    const leaf: ReferenceResolution = {
      target: { type: "execution_image", id: "image-a" },
      resolution: "resolved",
      source: {
        title: "Endpoint image",
        subtitle: null,
        excerpt: null,
        kind: "execution_image",
        state: "ready",
        updatedAt: snapshot.project.updatedAt,
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
          label: "Endpoint",
          deletedAt: null,
          archivedAt: null,
        }],
      }],
      destination: {
        referenceUrl: "/references/execution_image/r1_image-a",
        mode: "source",
        openSourceUrl: "/processing/sample-a?run=run-a&step=step-a",
        contextOpenSourceUrls: ["/processing/sample-a?run=run-a&step=step-a"],
      },
    };
    snapshot.references[0].resolution = leaf;

    expect(projectReferenceSuggestionSeeds(snapshot, leaf.target)).toEqual([{
      target: { type: "run_step", id: "step-a" },
      title: "Endpoint",
      origin: "selection",
    }]);

    const deletedContext = structuredClone(leaf.contexts[0]);
    deletedContext.segments[0].deletedAt = snapshot.project.updatedAt;
    deletedContext.segments[2].id = "step-in-deleted-sample";
    leaf.contexts.unshift(deletedContext);
    expect(projectReferenceSuggestionSeeds(snapshot, leaf.target)[0].target)
      .toEqual({ type: "run_step", id: "step-a" });
  });

  it("counts repeated active occurrences without hiding valid repeat placement", () => {
    const snapshot = projectTestSnapshot();
    const referenceItem = snapshot.items.find((item) => item.itemType === "reference")!;
    snapshot.items.push({
      ...referenceItem,
      id: "item-reference-repeat",
      createdSequence: referenceItem.createdSequence + 1,
    });
    const key = projectReferenceTargetKey({ type: "sample", id: "sample-a" });
    expect(projectReferenceOccurrenceCounts(snapshot)[key]).toBe(2);
  });
});
