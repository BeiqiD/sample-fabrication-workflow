import { useEffect, useState } from "react";
import type { SampleSummary } from "../../shared/types";
import { hasRecordedStructure } from "../lib/currentStructure";

export function SampleStateThumbnail({ sample }: { sample: SampleSummary }) {
  const [imageFailed, setImageFailed] = useState(false);
  const thumbnailUrl = sample.currentStateThumbnailUrl ?? (sample.currentStateThumbnailKey ? `/api/assets/${sample.currentStateThumbnailKey}` : null);

  useEffect(() => setImageFailed(false), [thumbnailUrl]);

  if (thumbnailUrl && !imageFailed) return <div className="sample-state-thumbnail has-image">
    <img
      src={thumbnailUrl}
      alt={sample.currentStateStepTitle ? `Current state after ${sample.currentStateStepTitle}` : `Current state of ${sample.code}`}
      loading="lazy"
      onError={() => setImageFailed(true)}
    />
  </div>;

  const hasStructure = hasRecordedStructure(sample);
  return <div
    className={`sample-state-thumbnail placeholder ${hasStructure ? "missing-image" : "no-workflow"}`}
    role="img"
    aria-label={hasStructure ? "No state image available" : "No process run yet"}
  >
    <svg aria-hidden="true" viewBox="0 0 48 48">
      <path d="M9 16 24 8l15 8-15 8-15-8Z" />
      <path d="m9 24 15 8 15-8M9 32l15 8 15-8" />
    </svg>
    <span>{hasStructure ? "No state image" : "No process run"}</span>
  </div>;
}
