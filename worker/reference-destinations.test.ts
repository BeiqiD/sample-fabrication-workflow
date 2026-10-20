import { describe, expect, it } from "vitest";
import {
  buildReferenceDestination,
  decodeReferenceRouteId,
  decodeReferenceSourceFocus,
  encodeReferenceRouteId,
  encodeReferenceSourceFocus,
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

function withQuery(path: string, entries: Array<[string, string]>) {
  const params = new URLSearchParams(entries);
  return `${path}?${params.toString()}`;
}

function processingPath(
  sampleId: string,
  runId: string,
  stepId?: string,
  target?: ReferenceTarget,
) {
  const entries: Array<[string, string]> = [["run", runId]];
  if (stepId) entries.push(["step", stepId]);
  if (target) entries.push(["focus", encodeReferenceSourceFocus(target)]);
  return withQuery(`/processing/${sampleId}`, entries);
}

function focusedPath(path: string, target: ReferenceTarget) {
  return withQuery(path, [["focus", encodeReferenceSourceFocus(target)]]);
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
    expected: processingPath("sample-1", "run-1"),
  },
  {
    target: { type: "run_step", id: "step-1" },
    contexts: [context(sample, run, step)],
    expected: processingPath(
      "sample-1",
      "run-1",
      "step-1",
      { type: "run_step", id: "step-1" },
    ),
  },
  {
    target: { type: "comment", id: "comment-1" },
    contexts: [context(sample, run, step)],
    expected: processingPath(
      "sample-1",
      "run-1",
      "step-1",
      { type: "comment", id: "comment-1" },
    ),
  },
  {
    target: { type: "comment_occurrence", id: "occurrence-1" },
    contexts: [context(sample, run, step)],
    expected: processingPath(
      "sample-1",
      "run-1",
      "step-1",
      { type: "comment_occurrence", id: "occurrence-1" },
    ),
  },
  {
    target: { type: "comment_attachment", id: "attachment-1" },
    contexts: [context(sample)],
    expected: focusedPath(
      "/samples/sample-1",
      { type: "comment_attachment", id: "attachment-1" },
    ),
  },
  {
    target: { type: "execution_image", id: "image-1" },
    contexts: [context(sample, run, step)],
    expected: processingPath(
      "sample-1",
      "run-1",
      "step-1",
      { type: "execution_image", id: "image-1" },
    ),
  },
  {
    target: { type: "metrology_reference", id: "metrology-reference-1" },
    contexts: [context(recipe)],
    expected: focusedPath(
      "/templates/metrology/recipe-1",
      { type: "metrology_reference", id: "metrology-reference-1" },
    ),
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
        referenceUrl: referenceUrlForTarget(target),
        mode: "source",
        openSourceUrl: expected,
        contextOpenSourceUrls: [expected],
      });
    }
  });

  it("round-trips every allowed route character through one canonical opaque codec", () => {
    const ids = [
      ".",
      "..",
      "/",
      "%2F",
      "?",
      "#",
      "id with space",
      "样品/α",
      "id%2Fencoded",
      "id/encoded",
      "\uD800",
    ];
    const encodedIds = ids.map(encodeReferenceRouteId);

    expect(new Set(encodedIds).size).toBe(ids.length);
    ids.forEach((id, index) => {
      const encodedId = encodedIds[index];
      expect(encodedId).toMatch(/^r1_[A-Za-z0-9_-]*$/);
      expect(decodeReferenceRouteId(encodedId)).toBe(id);
      expect(referenceUrlForTarget({ type: "sample", id }))
        .toBe(`/references/sample/${encodedId}`);
    });
    expect(decodeReferenceRouteId("r1_A")).toBeNull();
    expect(decodeReferenceRouteId("id%2Fencoded")).toBeNull();
  });

  it("round-trips typed source focus without collisions", () => {
    const targets: ReferenceTarget[] = [
      { type: "run_step", id: "." },
      { type: "run_step", id: ".." },
      { type: "comment", id: "id/encoded" },
      { type: "comment", id: "id%2Fencoded" },
      { type: "comment_attachment", id: "附件 ?#" },
      { type: "execution_image", id: "image:1" },
    ];
    const encoded = targets.map(encodeReferenceSourceFocus);

    expect(new Set(encoded).size).toBe(targets.length);
    targets.forEach((target, index) => {
      expect(decodeReferenceSourceFocus(encoded[index])).toEqual(target);
    });
    for (const invalid of [
      null,
      "",
      "run_step",
      "unknown:r1_AAAA",
      "run_step:legacy",
      "run_step:r2_AAAA",
      "run_step:r1_A",
      "run_step:r1_AAAA:extra",
    ]) {
      expect(decodeReferenceSourceFocus(invalid)).toBeNull();
    }
  });

  it("preserves every ordered context without choosing one common Comment path", () => {
    const target: ReferenceTarget = { type: "comment", id: "comment-1" };
    const secondContext = context(
      segment("sample", "sample-2"),
      segment("run", "run-2"),
      segment("run_step", "step-2"),
    );
    const destination = buildReferenceDestination({
      target,
      resolution: "resolved",
      source: source(),
      contexts: [context(sample, run, step), secondContext],
    });

    expect(destination).toEqual({
      referenceUrl: referenceUrlForTarget(target),
      mode: "source",
      openSourceUrl: null,
      contextOpenSourceUrls: [
        processingPath("sample-1", "run-1", "step-1", target),
        processingPath("sample-2", "run-2", "step-2", target),
      ],
    });
  });

  it("collapses duplicate context routes only for the single source action", () => {
    const target: ReferenceTarget = { type: "comment", id: "comment-1" };
    const repeated = context(sample, run, step);
    const expected = processingPath("sample-1", "run-1", "step-1", target);
    const destination = buildReferenceDestination({
      target,
      resolution: "resolved",
      source: source(),
      contexts: [repeated, repeated],
    });

    expect(destination.openSourceUrl).toBe(expected);
    expect(destination.contextOpenSourceUrls).toEqual([expected, expected]);
  });

  it("keeps active contexts open while a deleted sibling context stays read-only", () => {
    const target: ReferenceTarget = { type: "comment", id: "comment-1" };
    const deletedContext = context(
      segment("sample", "sample-2", { deletedAt: "2026-08-08T13:00:00.000Z" }),
      segment("run", "run-2"),
      segment("run_step", "step-2"),
    );
    const destination = buildReferenceDestination({
      target,
      resolution: "resolved",
      source: source(),
      contexts: [context(sample, run, step), deletedContext],
    });

    expect(destination.mode).toBe("source");
    expect(destination.openSourceUrl)
      .toBe(processingPath("sample-1", "run-1", "step-1", target));
    expect(destination.contextOpenSourceUrls).toEqual([
      processingPath("sample-1", "run-1", "step-1", target),
      null,
    ]);
  });

  it("round-trips Run, Step, and focus identities through query parameters", () => {
    const runId = "run/%2F ?#运行";
    const stepId = "step/%2F ?#步骤";
    const target: ReferenceTarget = { type: "run_step", id: stepId };
    const destination = buildReferenceDestination({
      target,
      resolution: "resolved",
      source: source(),
      contexts: [context(
        sample,
        segment("run", runId),
        segment("run_step", stepId),
      )],
    });

    expect(destination.mode).toBe("source");
    const parsed = new URL(destination.openSourceUrl!, "https://app.test");
    expect(parsed.pathname).toBe("/processing/sample-1");
    expect(parsed.searchParams.get("run")).toBe(runId);
    expect(parsed.searchParams.get("step")).toBe(stepId);
    expect(decodeReferenceSourceFocus(parsed.searchParams.get("focus"))).toEqual(target);
  });

  it.each([".", "..", "/", "%2F", "sample with space", "样品"])(
    "fails closed instead of emitting an unsafe Sample path for %j",
    (sampleId) => {
      const target: ReferenceTarget = { type: "sample", id: sampleId };
      expect(buildReferenceDestination({
        target,
        resolution: "resolved",
        source: source(),
        contexts: [context(segment("sample", sampleId))],
      })).toEqual({
        referenceUrl: referenceUrlForTarget(target),
        mode: "archived",
        openSourceUrl: null,
        contextOpenSourceUrls: [null],
      });
    },
  );

  it("fails closed instead of emitting unsafe processing or Recipe path segments", () => {
    const unsafeSample = segment("sample", "sample/unsafe");
    const unsafeRecipe = segment("recipe_revision", "recipe%2Funsafe");
    const runDestination = buildReferenceDestination({
      target: { type: "run", id: "run-1" },
      resolution: "resolved",
      source: source(),
      contexts: [context(unsafeSample, run)],
    });
    const recipeDestination = buildReferenceDestination({
      target: { type: "recipe_revision", id: unsafeRecipe.id },
      resolution: "resolved",
      source: source(),
      contexts: [context(unsafeRecipe)],
    });
    const metrologyDestination = buildReferenceDestination({
      target: { type: "metrology_reference", id: "metrology-1" },
      resolution: "resolved",
      source: source(),
      contexts: [context(unsafeRecipe)],
    });

    for (const destination of [runDestination, recipeDestination, metrologyDestination]) {
      expect(destination.mode).toBe("archived");
      expect(destination.openSourceUrl).toBeNull();
      expect(destination.contextOpenSourceUrls).toEqual([null]);
    }
  });

  it.each([
    ["deleted source", source({ deletedAt: "2026-08-08T13:00:00.000Z" })],
    ["archived source", source({ archivedAt: "2026-08-08T13:00:00.000Z" })],
  ])("uses the archived destination for a %s", (_label, resolvedSource) => {
    const target: ReferenceTarget = { type: "sample", id: "sample-1" };
    expect(buildReferenceDestination({
      target,
      resolution: "resolved",
      source: resolvedSource,
      contexts: [context(sample)],
    })).toEqual({
      referenceUrl: referenceUrlForTarget(target),
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
      const target: ReferenceTarget = { type: "sample", id: "missing-1" };
      const destination = buildReferenceDestination({
        target,
        resolution,
        source: resolution === "inconsistent" ? source() : null,
        contexts: [context(segment("sample", "missing-1"))],
      });

      expect(destination).toEqual({
        referenceUrl: referenceUrlForTarget(target),
        mode: "archived",
        openSourceUrl: null,
        contextOpenSourceUrls: [null],
      });
    },
  );

  it("fails closed when a context does not identify the requested source", () => {
    const target: ReferenceTarget = { type: "run", id: "run-1" };
    expect(buildReferenceDestination({
      target,
      resolution: "resolved",
      source: source(),
      contexts: [context(sample, segment("run", "other-run"))],
    })).toEqual({
      referenceUrl: referenceUrlForTarget(target),
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
