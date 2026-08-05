export function pendingRunStepActionTargets(pendingAction: string | null, stepId: string) {
  if (!pendingAction) return false;
  return pendingAction === `done:${stepId}`
    || pendingAction === `verify:${stepId}`
    || pendingAction.startsWith(`delete-asset:${stepId}:`);
}
