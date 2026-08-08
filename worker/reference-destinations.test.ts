import { describe, expect, it } from "vitest";
import {
  buildReferenceDestination,
  referenceUrlForTarget,
} from "../shared/reference-destinations";
import {
  REFERENCE_TARGET_TYPES,
  type ReferenceContext,
  type ReferenceContextSegment,
  type ReferenceTarget,
  type ResolvedReferenceSource,
} from "../shared/reference-types";

function source(
  overrides: Partial<ResolvedReferenceSource> = {},
): ResolvedReferenceSource {
  return {
    title: "Resolved source",
    subtitle: null,
    excerpt: null,
    kind: "test",
    state: "ready",
    updatedAt: "2026-08-08T12:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function segment(
  type: ReferenceContextSegment["type"],
  id: string,
  overrides: Partial<ReferenceContextSegment> = {},
): ReferenceContextSegment {
  return {
    type,
    id,
    label: `${type}:${id}`,
    deletedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function context(...segments: ReferenceContextSegment[]): ReferenceContext {
  return { segments };
}

const sample = segment("sample", "sample-1");
const run = segment("run", "run-1");
const step = segment("run_step", "step-1");
const recipe = segment("recipe_revision", "recipe-1");

const destinationCases: Array<{
  target: ReferenceTarget;
  contexts: ReferenceContext[];
  expected: string;
}> = [
  {
    target: { type: "sample", id: "sample-1" },
    contexts: [context(sample)],
    expected: "/samples/sample-1",
  },
  {
    target: { type: "run", id: "run-1" },
    contexts: [context(sample, run)],
    expected: "/processing/sample-1?run=run-1",
  },
  {
    target: { type: "run_step", id: "step-1" },
    contexts: [context(sample, run, step)],
    expected: "/processing/sample-1?run=run-1&step=step-1&reference=run_step%3Astep-1",
  },
  {
    target: { type: "comment", id: "comment-1" },
    contexts: [context(sample, run, step)],
    expected: "/processing/sample-1?run=run-1&step=step-1&reference=comment%3Acomment-1",
  },
  {
    target: { type: "comment_occurrence", id: "occurrence-1" },
    contexts: [context(sample, run, step)],
    expected: "/processing/sample-1?run=run-1&step=step-1&reference=comment_occurrence%3Aoccurrence-1",
  },
  {
    target: { type: "comment_attachment", id: "attachment-1" },
    contexts: [context(sample)],
    expected: "/samples/sample-1?reference=comment_attachment%3Aattachment-1",
  },
  {
    target: { type: "execution_image", id: "image-1" },
    contexts: [context(sample, run, step)],
    expected: "/processing/sample-1?run=run-1&step=step-1&reference=execution_image%3Aimage-1",
  },
  {
    target: { type: "metrology_reference", id: "metrology-reference-1" },
    contexts: [context(recipe)],
    expected: "/templates/recipe-1?reference=metrology_reference%3Ametrology-reference-1",
  },
  {
    target: { type: "recipe_revision", id: "recipe-1" },
    contexts: [context(recipe)],
    expected: "/templates/recipe-1",
  },
];

describe("reference destinations", () => {
  it("covers every closed v1 target type with deterministic source routing", () => {
    expect(new Set(destinationCases.map(({ target }) => target.type)))
      .toEqual(new Set(REFERENCE_TARGET_TYPES));

    for (const { target, contexts, expected } of destinationCases) {
      expect(buildReferenceDestination({
        target,
        resolution: "resolved",
        source: source(),
        contexts,
      })).toEqual({
        referenceUrl: `/references/${target.type}/${target.id}`,
        mode: "source",
        openSourceUrl: expected,
        contextOpenSourceUrls: [expected],
      });
    }
  });

  it("percent-encodes the stable ID as one canonical path segment", () => {
    expect(referenceUrlForTarget({ type: "sample", id: "id/with space" }))
      .toBe("/references/sample/id%2Fwith%20space");
  });

  it("preserves every ordered context without choosing one common Comment path", () => {
    const secondContext = context(
      segment("sample", "sample-2"),
      segment("run", "run-2"),
      segment("run_step", "step-2"),
    );
    const destination = buildReferenceDestination({
      target: { type: "comment", id: "comment-1" },
      resolution: "resolved",
      source: source(),
      contexts: [context(sample, run, step), secondContext],
    });

    expect(destination).toEqual({
      referenceUrl: "/references/comment/comment-1",
      mode: "source",
      openSourceUrl: null,
      contextOpenSourceUrls: [
        "/processing/sample-1?run=run-1&step=step-1&reference=comment%3Acomment-1",
        "/processing/sample-2?run=run-2&step=step-2&reference=comment%3Acomment-1",
      ],
    });
  });

  it("collapses duplicate context routes only for the single source action", () => {
    const repeated = context(sample, run, step);
    const expected = "/processing/sample-1?run=run-1&step=step-1&reference=comment%3Acomment-1";
    const destination = buildReferenceDestination({
      target: { type: "comment", id: "comment-1" },
      resolution: "resolved",
      source: source(),
      contexts: [repeated, repeated],
    });

    expect(destination.openSourceUrl).toBe(expected);
    expect(destination.contextOpenSourceUrls).toEqual([expected, expected]);
  });

  it("keeps active contexts open while a deleted sibling context stays read-only", () => {
    const deletedContext = context(
      segment("sample", "sample-2", { deletedAt: "2026-08-08T13:00:00.000Z" }),
      segment("run", "run-2"),
      segment("run_step", "step-2"),
    );
    const destination = buildReferenceDestination({
      target: { type: "comment", id: "comment-1" },
      resolution: "resolved",
      source: source(),
      contexts: [context(sample, run, step), deletedContext],
    });

    expect(destination.mode).toBe("source");
    expect(destination.openSourceUrl)
      .toBe("/processing/sample-1?run=run-1&step=step-1&reference=comment%3Acomment-1");
    expect(destination.contextOpenSourceUrls).toEqual([
      "/processing/sample-1?run=run-1&step=step-1&reference=comment%3Acomment-1",
      null,
    ]);
  });

  it.each([
    ["deleted source", source({ deletedAt: "2026-08-08T13:00:00.000Z" })],
    ["archived source", source({ archivedAt: "2026-08-08T13:00:00.000Z" })],
  ])("uses the archived destination for a %s", (_label, resolvedSource) => {
    expect(buildReferenceDestination({
      target: { type: "sample", id: "sample-1" },
      resolution: "resolved",
      source: resolvedSource,
      contexts: [context(sample)],
    })).toEqual({
      referenceUrl: "/references/sample/sample-1",
      mode: "archived",
      openSourceUrl: null,
      contextOpenSourceUrls: [null],
    });
  });

  it("uses the archived destination when an ancestor is deleted", () => {
    const destination = buildReferenceDestination({
      target: { type: "run_step", id: "step-1" },
      resolution: "resolved",
      source: source(),
      contexts: [context(
        sample,
        segment("run", "run-1", { deletedAt: "2026-08-08T13:00:00.000Z" }),
        step,
      )],
    });

    expect(destination.mode).toBe("archived");
    expect(destination.openSourceUrl).toBeNull();
    expect(destination.contextOpenSourceUrls).toEqual([null]);
  });

  it.each(["not_found", "inconsistent", "tombstoned"] as const)(
    "keeps %s targets canonical and read-only",
    (resolution) => {
      const destination = buildReferenceDestination({
        target: { type: "sample", id: "missing-1" },
        resolution,
        source: resolution === "inconsistent" ? source() : null,
        contexts: [context(segment("sample", "missing-1"))],
      });

      expect(destination).toEqual({
        referenceUrl: "/references/sample/missing-1",
        mode: "archived",
        openSourceUrl: null,
        contextOpenSourceUrls: [null],
      });
    },
  );

  it("fails closed when a context does not identify the requested source", () => {
    expect(buildReferenceDestination({
      target: { type: "run", id: "run-1" },
      resolution: "resolved",
      source: source(),
      contexts: [context(sample, segment("run", "other-run"))],
    })).toEqual({
      referenceUrl: "/references/run/run-1",
      mode: "archived",
      openSourceUrl: null,
      contextOpenSourceUrls: [null],
    });
  });

  it("does not add storage locators to the destination model", () => {
    const serialized = JSON.stringify(buildReferenceDestination({
      target: { type: "execution_image", id: "image-1" },
      resolution: "resolved",
      source: source(),
      contexts: [context(sample, run, step)],
    }));

    expect(serialized).not.toMatch(/r2|storage|provider|locator|assetKey/i);
  });
});
