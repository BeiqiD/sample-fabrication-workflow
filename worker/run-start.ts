export type RunInitialStateChoice = {
  hasPreviousRun: boolean;
  requestedHashProvided: boolean;
  requestedHash: string | null;
  templateHash: string | null;
  sampleCurrentHash: string | null;
};

export function resolveRunInitialState(choice: RunInitialStateChoice): {
  ok: true;
  hash: string | null;
} | {
  ok: false;
  reason: "confirmation_required" | "invalid_choice";
} {
  if (!choice.hasPreviousRun && choice.sampleCurrentHash === null) {
    return { ok: true, hash: choice.templateHash };
  }
  if (!choice.requestedHashProvided) return { ok: false, reason: "confirmation_required" };

  const allowed = new Set([choice.templateHash, choice.sampleCurrentHash]);
  if (!allowed.has(choice.requestedHash)) return { ok: false, reason: "invalid_choice" };
  if (choice.requestedHash === null && (choice.templateHash !== null || choice.sampleCurrentHash !== null)) {
    return { ok: false, reason: "invalid_choice" };
  }
  return { ok: true, hash: choice.requestedHash };
}
