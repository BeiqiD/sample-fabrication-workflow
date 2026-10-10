import type { ReferenceTarget } from "../../shared/reference-types";
import { d1StorageConfigurationDatabase } from "../storage/configuration-d1";
import { getReferenceTargetsReadOnly, resolveReferencesReadOnly } from "./read-resolver";
export { ReferenceResolutionInputError, referenceTargetKey } from "./read-resolver";

/** Existing Worker consumers retain real D1 bindings; logic lives once. */
export function getReferenceTargets(db: D1Database, targets: readonly ReferenceTarget[]) {
  return getReferenceTargetsReadOnly(d1StorageConfigurationDatabase(db), targets);
}
export function resolveReferences(db: D1Database, targets: readonly ReferenceTarget[]) {
  return resolveReferencesReadOnly(d1StorageConfigurationDatabase(db), targets);
}
