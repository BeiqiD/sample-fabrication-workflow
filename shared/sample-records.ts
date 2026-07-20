export function isSampleRecordEvent(kind: string, metadata: Record<string, unknown>) {
  return kind === "comment"
    || (kind === "image" && metadata.runId === undefined && metadata.stepId === undefined);
}
