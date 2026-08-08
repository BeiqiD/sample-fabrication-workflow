import type {
  ReferenceTarget,
  ReferenceTargetRegistryEntry,
} from "../../shared/reference-types";
import {
  getReferenceTargets,
  referenceTargetKey,
  resolveReferences,
} from "./resolver";

export class ReferenceRegistrationError extends Error {
  constructor(
    readonly code: "not_resolvable" | "tombstoned" | "not_registered",
    message: string,
  ) {
    super(message);
    this.name = "ReferenceRegistrationError";
  }
}

async function requireResolvedTarget(db: D1Database, target: ReferenceTarget) {
  const [resolution] = await resolveReferences(db, [target]);
  if (resolution.resolution === "tombstoned") {
    throw new ReferenceRegistrationError("tombstoned", "The reference target is tombstoned");
  }
  if (resolution.resolution !== "resolved") {
    throw new ReferenceRegistrationError("not_resolvable", "The reference target cannot be resolved consistently");
  }
  return resolution;
}

async function requireRegistryEntry(db: D1Database, target: ReferenceTarget) {
  const entries = await getReferenceTargets(db, [target]);
  const entry = entries.get(referenceTargetKey(target));
  if (!entry) throw new ReferenceRegistrationError("not_registered", "The reference target is not registered");
  return entry;
}

export async function registerReferenceTarget(
  db: D1Database,
  target: ReferenceTarget,
  now = new Date().toISOString(),
  registryId = crypto.randomUUID(),
): Promise<ReferenceTargetRegistryEntry> {
  const resolution = await requireResolvedTarget(db, target);
  const contextsJson = JSON.stringify(resolution.contexts);
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO reference_targets
        (id, registry_version, target_type, target_id,
         first_registered_at, last_validated_at, last_known_contexts_json)
      VALUES (?, 1, ?, ?, ?, ?, ?)
    `).bind(registryId, target.type, target.id, now, now, contextsJson),
    db.prepare(`
      UPDATE reference_targets
      SET last_validated_at = ?, last_known_contexts_json = ?
      WHERE target_type = ? AND target_id = ? AND tombstoned_at IS NULL
        AND last_validated_at <= ?
    `).bind(now, contextsJson, target.type, target.id, now),
  ]);
  const entry = await requireRegistryEntry(db, target);
  if (entry.tombstonedAt) {
    throw new ReferenceRegistrationError("tombstoned", "The reference target is tombstoned");
  }
  return entry;
}

export async function refreshReferenceTarget(
  db: D1Database,
  target: ReferenceTarget,
  now = new Date().toISOString(),
): Promise<ReferenceTargetRegistryEntry> {
  const existing = await requireRegistryEntry(db, target);
  if (existing.tombstonedAt) {
    throw new ReferenceRegistrationError("tombstoned", "The reference target is tombstoned");
  }
  const resolution = await requireResolvedTarget(db, target);
  const result = await db.prepare(`
    UPDATE reference_targets
    SET last_validated_at = ?, last_known_contexts_json = ?
    WHERE id = ? AND tombstoned_at IS NULL AND last_validated_at <= ?
  `).bind(now, JSON.stringify(resolution.contexts), existing.id, now).run();
  if (!result.meta.changes) {
    const current = await requireRegistryEntry(db, target);
    if (current.tombstonedAt) {
      throw new ReferenceRegistrationError("tombstoned", "The reference target changed while it was being refreshed");
    }
    if (current.lastValidatedAt >= now) return current;
    throw new Error("Reference target validation metadata was not updated");
  }
  return requireRegistryEntry(db, target);
}
