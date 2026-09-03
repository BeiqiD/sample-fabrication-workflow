import { describe, expect, it } from "vitest";
import type { ReferenceResolution } from "../../shared/reference-types";
import { projectTestSnapshot } from "../project-test-fixture";
import {
  projectReferenceOccurrenceCounts,
  projectReferenceSuggestionSeeds,
  projectReferenceTargetKey,
} from "./project-reference-suggestions";

describe("Project reference suggestions", () => {
  it("prioritizes the selected reference and deduplicates the same Project seed", () => {
    const snapshot = projectTestSnapshot();
    expect(projectReferenceSuggestionSeeds(snapshot, { type: "sample", id: "sample-a" }))
      .toEqual([{
        target: { type: "sample", id: "sample-a" },
        title: "Sample A",
        origin: "selection",
      }]);
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
