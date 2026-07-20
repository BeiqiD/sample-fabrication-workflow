export function insertionPosition(steps: Array<{ id: string; position: number }>, afterStepId?: string) {
  if (!steps.length) return 1000;
  if (!afterStepId) return steps[0].position - 1000;
  const index = steps.findIndex((step) => step.id === afterStepId);
  if (index < 0) return null;
  const current = steps[index].position;
  const next = steps[index + 1]?.position;
  return next === undefined ? current + 1000 : current + (next - current) / 2;
}
