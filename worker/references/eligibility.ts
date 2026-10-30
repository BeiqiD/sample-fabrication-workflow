import type { ReferenceResolution } from "../../shared/reference-types";

export function referenceResolutionHasActiveContext(
  resolution: ReferenceResolution,
) {
  return resolution.contexts.some((context) => (
    context.segments.length > 0
    && context.segments.every((segment) => segment.deletedAt === null)
  ));
}

export function referenceResolutionIsEligible(
  resolution: ReferenceResolution,
) {
  return resolution.resolution === "resolved"
    && resolution.source !== null
    && resolution.source.deletedAt === null
    && referenceResolutionHasActiveContext(resolution);
}
