export function isSampleRecordEvent(kind: string, metadata: Record<string, unknown>) {
  if (metadata.deletedAt) return false;
  if (typeof metadata.action === "string" && metadata.action !== "sample_record") return false;
  return kind === "comment"
    || (kind === "image" && metadata.runId === undefined && metadata.stepId === undefined);
}
