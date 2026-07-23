import { useEffect, useState } from "react";
import type { SampleSummary } from "../../shared/types";

export function SampleStateThumbnail({ sample }: { sample: SampleSummary }) {
  const [imageFailed, setImageFailed] = useState(false);
  const thumbnailKey = sample.currentStateThumbnailKey;

  useEffect(() => setImageFailed(false), [thumbnailKey]);

  if (thumbnailKey && !imageFailed) return <div className="sample-state-thumbnail has-image">
    <img
      src={`/api/assets/${thumbnailKey}`}
      alt={sample.currentStateStepTitle ? `Current state after ${sample.currentStateStepTitle}` : `Current state of ${sample.code}`}
      loading="lazy"
      onError={() => setImageFailed(true)}
    />
  </div>;

  const hasWorkflow = Boolean(sample.latestWorkflowName);
  return <div
    className={`sample-state-thumbnail placeholder ${hasWorkflow ? "missing-image" : "no-workflow"}`}
    role="img"
    aria-label={hasWorkflow ? "No state image available" : "No process run yet"}
  >
    <svg aria-hidden="true" viewBox="0 0 48 48">
      <path d="M9 16 24 8l15 8-15 8-15-8Z" />
      <path d="m9 24 15 8 15-8M9 32l15 8 15-8" />
    </svg>
    <span>{hasWorkflow ? "No state image" : "No process run"}</span>
  </div>;
}
