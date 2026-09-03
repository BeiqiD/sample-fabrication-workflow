import type { ProjectSnapshot } from "../../shared/project-api";
import type {
  ReferenceContextSegment,
  ReferenceResolution,
  ReferenceTarget,
  ReferenceTargetType,
} from "../../shared/reference-types";

export const MAX_PROJECT_REFERENCE_SUGGESTION_SEEDS = 3;

const REFERENCE_SUGGESTION_PARENT_TYPES = new Set<ReferenceTargetType>([
  "sample",
  "run",
  "run_step",
  "comment",
  "comment_occurrence",
  "recipe_revision",
]);

export interface ProjectReferenceSuggestionSeed {
  target: ReferenceTarget;
  title: string;
  origin: "selection" | "project";
}

export function projectReferenceTargetKey(target: ReferenceTarget) {
  return `${target.type}\u0000${target.id}`;
}

function canSuggestChildren(target: ReferenceTarget) {
  return REFERENCE_SUGGESTION_PARENT_TYPES.has(target.type);
}

function deepestEligibleContext(
  resolution: ReferenceResolution,
): ReferenceContextSegment | null {
  for (const context of resolution.contexts) {
    for (let index = context.segments.length - 1; index >= 0; index -= 1) {
      const segment = context.segments[index];
      if (REFERENCE_SUGGESTION_PARENT_TYPES.has(segment.type)) return segment;
    }
  }
  return null;
}

function suggestionSeed(
  resolution: ReferenceResolution,
  origin: ProjectReferenceSuggestionSeed["origin"],
): ProjectReferenceSuggestionSeed | null {
  if (canSuggestChildren(resolution.target)) {
    return {
      target: resolution.target,
      title: resolution.source?.title || resolution.target.id,
      origin,
    };
  }
  const context = deepestEligibleContext(resolution);
  if (!context) return null;
  return {
    target: { type: context.type, id: context.id },
    title: context.label,
    origin,
  };
}

/**
 * Choose a small, explainable set of existing Project references whose direct
 * children can be suggested. The current selection wins; remaining seeds use
 * reverse insertion order so the panel follows the user's recent context.
 */
export function projectReferenceSuggestionSeeds(
  snapshot: ProjectSnapshot,
  selectedTarget: ReferenceTarget | null,
  limit = MAX_PROJECT_REFERENCE_SUGGESTION_SEEDS,
) {
  const referencesByRegistryId = new Map(
    snapshot.references.map((reference) => [reference.registryId, reference.resolution]),
  );
  const seeds: ProjectReferenceSuggestionSeed[] = [];
  const seen = new Set<string>();

  const push = (
    resolution: ReferenceResolution | undefined,
    origin: ProjectReferenceSuggestionSeed["origin"],
  ) => {
    if (!resolution || seeds.length >= limit) return;
    const seed = suggestionSeed(resolution, origin);
    if (!seed) return;
    const key = projectReferenceTargetKey(seed.target);
    if (seen.has(key)) return;
    seen.add(key);
    seeds.push(seed);
  };

  if (selectedTarget) {
    push(snapshot.references.find((reference) => (
      projectReferenceTargetKey(reference.resolution.target)
        === projectReferenceTargetKey(selectedTarget)
    ))?.resolution, "selection");
  }

  const activeReferenceItems = snapshot.items
    .filter((item) => item.itemType === "reference" && !item.deletedAt && item.referenceTargetId)
    .sort((left, right) => right.createdSequence - left.createdSequence);
  for (const item of activeReferenceItems) {
    push(referencesByRegistryId.get(item.referenceTargetId!), "project");
    if (seeds.length >= limit) break;
  }
  return seeds;
}

export function projectReferenceOccurrenceCounts(snapshot: ProjectSnapshot) {
  const referencesByRegistryId = new Map(
    snapshot.references.map((reference) => [reference.registryId, reference.resolution.target]),
  );
  const counts: Record<string, number> = {};
  for (const item of snapshot.items) {
    if (item.itemType !== "reference" || item.deletedAt || !item.referenceTargetId) continue;
    const target = referencesByRegistryId.get(item.referenceTargetId);
    if (!target) continue;
    const key = projectReferenceTargetKey(target);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
