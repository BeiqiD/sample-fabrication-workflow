import { isSampleRecordEvent } from "../../shared/sample-records";
import type { SampleEvent } from "../../shared/types";

export const SAMPLE_HISTORY_PREVIEW_COUNT = 5;
export type SampleHistoryFilter = "all" | "notes" | "processing" | "sample";

export function sampleEventAction(event: SampleEvent) {
  return typeof event.metadata.action === "string" ? event.metadata.action : null;
}

export function sampleEventLabel(event: SampleEvent) {
  const action = sampleEventAction(event);
  const actionLabels: Record<string, string> = {
    added: "Ad hoc step added",
    comment_attachment_deleted: "Comment attachment deleted",
    comment_submission: "Comment",
    comment_submission_deleted: "Comment deleted",
    confirmed_done: "Steps confirmed",
    created_by_split: "Sample created by split",
    execution_attachment_added: "Execution attachment added",
    execution_attachment_deleted: "Execution attachment deleted",
    image_attachment_deleted: "Image attachment deleted",
    process_run_finished: "Process run finished",
    sample_details_updated: "Sample details updated",
    sample_record: "Sample note",
    sample_record_deleted: "Sample note deleted",
    sample_split: "Sample split",
    step_comment: "Processing comment",
    step_comment_deleted: "Processing comment deleted",
    updated: "Process step updated",
  };
  if (action && actionLabels[action]) return actionLabels[action];
  const kindLabels: Record<SampleEvent["kind"], string> = {
    comment: "Comment",
    image: "Image",
    location: "Location changed",
    status: "Status changed",
    created: "Sample created",
    step: "Process step",
    run: "Process run",
    plan: "Process plan",
    verification: "State verification",
  };
  return kindLabels[event.kind];
}

export function sampleEventCategory(event: SampleEvent): Exclude<SampleHistoryFilter, "all"> {
  const action = sampleEventAction(event);
  if (isSampleRecordEvent(event.kind, event.metadata)
    || action === "sample_record_deleted"
    || action === "comment_submission"
    || action === "comment_submission_deleted"
    || action === "step_comment"
    || action === "step_comment_deleted"
    || action === "comment_attachment_deleted") return "notes";
  if (["step", "run", "plan", "verification", "image"].includes(event.kind)) return "processing";
  return "sample";
}

export function filterSampleHistory(events: readonly SampleEvent[], filter: SampleHistoryFilter) {
  return filter === "all"
    ? [...events]
    : events.filter((event) => sampleEventCategory(event) === filter);
}
