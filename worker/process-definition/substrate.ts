import type { InitialSubstrateStep } from "../../shared/types";
import { normalizedStepName } from "../../shared/content-addressing";

export function normalizedSubstrateStepName(name: string) {
  return normalizedStepName(name).replace(/[-_]+/g, " ");
}

export function parseInitialSubstrateStep(contentJson: string | null): InitialSubstrateStep | null {
  if (!contentJson) return null;
  try {
    const value = JSON.parse(contentJson) as { initialSubstrateStep?: unknown };
    const step = value.initialSubstrateStep;
    if (!step || typeof step !== "object") return null;
    const candidate = step as Partial<InitialSubstrateStep>;
    if (candidate.stepNumber !== "0" || normalizedSubstrateStepName(candidate.name ?? "") !== "substrate stack") return null;
    return step as InitialSubstrateStep;
  } catch {
    return null;
  }
}
