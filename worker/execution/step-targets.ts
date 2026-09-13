import type { RunStepTarget } from "../../shared/types";

// Execution target shape also accepted by the existing legacy Evidence API.
export function validRunStepTargets(value: unknown): value is RunStepTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return false;
  const keys = new Set<string>();
  for (const target of value) {
    if (!target || typeof target !== "object") return false;
    const candidate = target as Partial<RunStepTarget>;
    if (typeof candidate.sampleId !== "string" || typeof candidate.runId !== "string"
      || typeof candidate.stepId !== "string" || typeof candidate.expectedUpdatedAt !== "string"
      || !candidate.sampleId || !candidate.runId || !candidate.stepId || !candidate.expectedUpdatedAt) return false;
    const key = `${candidate.sampleId}\u0000${candidate.runId}\u0000${candidate.stepId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}
