import type {
  ReferenceContext,
  ReferenceContextSegment,
  ReferenceDestination,
  ReferenceResolutionStatus,
  ReferenceTarget,
  ResolvedReferenceSource,
} from "./reference-types";

export interface ReferenceDestinationInput {
  target: ReferenceTarget;
  resolution: ReferenceResolutionStatus;
  source: ResolvedReferenceSource | null;
  contexts: ReferenceContext[];
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value);
}

export function referenceUrlForTarget(target: ReferenceTarget) {
  return `/references/${target.type}/${encodePathSegment(target.id)}`;
}

function segment(
  context: ReferenceContext,
  type: ReferenceContextSegment["type"],
) {
  return context.segments.find((candidate) => candidate.type === type) ?? null;
}

function contextHasArchivedLifecycle(context: ReferenceContext) {
  return context.segments.some((candidate) => candidate.deletedAt || candidate.archivedAt);
}

function withQuery(path: string, entries: Array<[string, string | null]>) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function referenceHint(target: ReferenceTarget) {
  return `${target.type}:${target.id}`;
}

function processingDestination(
  target: ReferenceTarget,
  context: ReferenceContext,
  requireRunIdentity = false,
  requireStepIdentity = false,
) {
  const sample = segment(context, "sample");
  const run = segment(context, "run");
  const step = segment(context, "run_step");
  if (!sample || !run) return null;
  if (requireRunIdentity && run.id !== target.id) return null;
  if (requireStepIdentity && (!step || step.id !== target.id)) return null;

  return withQuery(`/processing/${encodePathSegment(sample.id)}`, [
    ["run", run.id],
    ["step", step?.id ?? null],
    ["reference", requireRunIdentity ? null : referenceHint(target)],
  ]);
}

function contextSourceUrl(target: ReferenceTarget, context: ReferenceContext) {
  const sample = segment(context, "sample");
  const recipe = segment(context, "recipe_revision");

  switch (target.type) {
    case "sample":
      return sample?.id === target.id
        ? `/samples/${encodePathSegment(sample.id)}`
        : null;
    case "run":
      return processingDestination(target, context, true, false);
    case "run_step":
      return processingDestination(target, context, false, true);
    case "comment":
    case "comment_attachment":
      if (segment(context, "run")) return processingDestination(target, context);
      return sample
        ? withQuery(`/samples/${encodePathSegment(sample.id)}`, [
          ["reference", referenceHint(target)],
        ])
        : null;
    case "comment_occurrence":
    case "execution_image":
      return processingDestination(target, context);
    case "metrology_reference":
      return recipe
        ? withQuery(`/templates/${encodePathSegment(recipe.id)}`, [
          ["reference", referenceHint(target)],
        ])
        : null;
    case "recipe_revision":
      return recipe?.id === target.id
        ? `/templates/${encodePathSegment(recipe.id)}`
        : null;
  }
}

export function buildReferenceDestination({
  target,
  resolution,
  source,
  contexts,
}: ReferenceDestinationInput): ReferenceDestination {
  const referenceUrl = referenceUrlForTarget(target);
  const sourceAvailable = resolution === "resolved"
    && source !== null
    && !source.deletedAt
    && !source.archivedAt;

  const contextOpenSourceUrls = contexts.map((context) => {
    if (!sourceAvailable || contextHasArchivedLifecycle(context)) return null;
    return contextSourceUrl(target, context);
  });
  const uniqueOpenSourceUrls = [...new Set(
    contextOpenSourceUrls.filter((value): value is string => value !== null),
  )];
  const mode = sourceAvailable && uniqueOpenSourceUrls.length > 0
    ? "source"
    : "archived";

  return {
    referenceUrl,
    mode,
    openSourceUrl: mode === "source" && uniqueOpenSourceUrls.length === 1
      ? uniqueOpenSourceUrls[0]
      : null,
    contextOpenSourceUrls: mode === "source"
      ? contextOpenSourceUrls
      : contexts.map(() => null),
  };
}
