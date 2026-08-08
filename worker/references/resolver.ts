import type {
  ReferenceContext,
  ReferenceResolution,
  ReferenceTarget,
  ReferenceTargetRegistryEntry,
  ReferenceTargetType,
} from "../../shared/reference-types";
import {
  isReferenceTarget,
  MAX_REFERENCE_RESOLUTION_TARGETS,
} from "../../shared/reference-types";
import { buildReferenceDestination } from "../../shared/reference-destinations";
import { REFERENCE_ADAPTERS } from "./adapters";

type RegistryRow = {
  id: string;
  registry_version: number;
  target_type: ReferenceTargetType;
  target_id: string;
  first_registered_at: string;
  last_validated_at: string;
  tombstoned_at: string | null;
  last_known_contexts_json: string;
};

type ReferenceResolutionWithoutDestination = Omit<ReferenceResolution, "destination">;

export class ReferenceResolutionInputError extends Error {
  constructor(
    readonly code: "too_many_targets" | "invalid_target",
    message: string,
  ) {
    super(message);
    this.name = "ReferenceResolutionInputError";
  }
}

export function referenceTargetKey(target: ReferenceTarget) {
  return `${target.type}\u0000${target.id}`;
}

function parseContexts(value: string): ReferenceContext[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ReferenceContext[];
  } catch {
    return [];
  }
}

function registryEntry(row: RegistryRow): ReferenceTargetRegistryEntry {
  return {
    id: row.id,
    registryVersion: 1,
    target: { type: row.target_type, id: row.target_id },
    firstRegisteredAt: row.first_registered_at,
    lastValidatedAt: row.last_validated_at,
    tombstonedAt: row.tombstoned_at,
    lastKnownContexts: parseContexts(row.last_known_contexts_json),
  };
}

function withDestination(
  resolution: ReferenceResolutionWithoutDestination,
): ReferenceResolution {
  return {
    ...resolution,
    destination: buildReferenceDestination(resolution),
  };
}

function validateReferenceTargets(targets: readonly ReferenceTarget[]) {
  if (targets.length > MAX_REFERENCE_RESOLUTION_TARGETS) {
    throw new ReferenceResolutionInputError(
      "too_many_targets",
      `Reference resolution accepts at most ${MAX_REFERENCE_RESOLUTION_TARGETS} targets`,
    );
  }
  for (const target of targets) {
    if (!isReferenceTarget(target) || target.id.trim() !== target.id) {
      throw new ReferenceResolutionInputError(
        "invalid_target",
        "Every reference target needs a known type and valid stable ID",
      );
    }
  }
}

export async function getReferenceTargets(
  db: D1Database,
  targets: readonly ReferenceTarget[],
): Promise<Map<string, ReferenceTargetRegistryEntry>> {
  if (!targets.length) return new Map();
  const uniqueTargets = [...new Map(targets.map((target) => [referenceTargetKey(target), target])).values()];
  const result = await db.prepare(`
    SELECT rt.id, rt.registry_version, rt.target_type, rt.target_id,
           rt.first_registered_at, rt.last_validated_at, rt.tombstoned_at,
           rt.last_known_contexts_json
    FROM reference_targets rt
    JOIN json_each(?) requested
      ON rt.target_type = json_extract(requested.value, '$.type')
     AND rt.target_id = json_extract(requested.value, '$.id')
    ORDER BY rt.target_type, rt.target_id
  `).bind(JSON.stringify(uniqueTargets)).all<RegistryRow>();
  return new Map(result.results.map((row) => {
    const entry = registryEntry(row);
    return [referenceTargetKey(entry.target), entry];
  }));
}

export async function resolveReferences(
  db: D1Database,
  targets: readonly ReferenceTarget[],
): Promise<ReferenceResolution[]> {
  if (!targets.length) return [];
  validateReferenceTargets(targets);

  const grouped = new Map<ReferenceTargetType, Set<string>>();
  for (const target of targets) {
    const ids = grouped.get(target.type) ?? new Set<string>();
    ids.add(target.id);
    grouped.set(target.type, ids);
  }

  const [registry, resolvedGroups] = await Promise.all([
    getReferenceTargets(db, targets),
    Promise.all([...grouped.entries()].map(async ([type, ids]) => [
      type,
      await REFERENCE_ADAPTERS[type](db, [...ids]),
    ] as const)),
  ]);
  const resolvedByType = new Map(resolvedGroups);

  return targets.map((target): ReferenceResolution => {
    const key = referenceTargetKey(target);
    const registered = registry.get(key);
    if (registered?.tombstonedAt) {
      return withDestination({
        target,
        resolution: "tombstoned",
        source: null,
        contexts: registered.lastKnownContexts,
      });
    }

    const record = resolvedByType.get(target.type)?.get(target.id);
    if (!record) {
      return withDestination({
        target,
        resolution: registered ? "inconsistent" : "not_found",
        source: null,
        contexts: registered?.lastKnownContexts ?? [],
      });
    }

    return withDestination({
      target,
      resolution: record.consistent ? "resolved" : "inconsistent",
      source: record.source,
      contexts: record.contexts,
    });
  });
}
