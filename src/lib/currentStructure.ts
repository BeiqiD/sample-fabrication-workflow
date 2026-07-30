import type { SampleDetail, SampleSummary } from "../../shared/types";

type CurrentStructureSample = Pick<
  SampleDetail,
  "currentStateStepTitle" | "latestWorkflowName" | "latestWorkflowVersion" | "inheritedStateHash" | "parent"
>;

export type CurrentStructurePresentation = {
  source: "process-step" | "process-run" | "inherited" | "empty";
  title: string;
  detail: string;
};

function workflowLabel(sample: CurrentStructureSample) {
  if (!sample.latestWorkflowName) return "Recorded process structure.";
  return `${sample.latestWorkflowName}${sample.latestWorkflowVersion ? ` · v${sample.latestWorkflowVersion}` : ""}`;
}

export function currentStructurePresentation(sample: CurrentStructureSample): CurrentStructurePresentation {
  if (sample.currentStateStepTitle) {
    return {
      source: "process-step",
      title: `After ${sample.currentStateStepTitle}`,
      detail: workflowLabel(sample),
    };
  }
  if (sample.latestWorkflowName) {
    return {
      source: "process-run",
      title: "Latest recorded substrate",
      detail: workflowLabel(sample),
    };
  }
  if (sample.inheritedStateHash) {
    return {
      source: "inherited",
      title: "Inherited structure",
      detail: sample.parent
        ? `Snapshot inherited from ${sample.parent.code} when this sample was split.`
        : "Snapshot inherited when this sample was split.",
    };
  }
  return {
    source: "empty",
    title: "No process structure yet",
    detail: "Start a process run to establish the first substrate snapshot.",
  };
}

export function hasRecordedStructure(
  sample: Pick<SampleSummary, "currentStateStepTitle" | "currentStateThumbnailKey" | "latestWorkflowName" | "inheritedStateHash">,
) {
  return Boolean(
    sample.currentStateStepTitle
    || sample.currentStateThumbnailKey
    || sample.latestWorkflowName
    || sample.inheritedStateHash,
  );
}
