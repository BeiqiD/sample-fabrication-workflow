import type { SampleEvent } from "../../shared/types";
import { isSampleRecordEvent } from "../../shared/sample-records";
import { sampleEventLabel } from "../lib/sampleHistory";
import { sampleEventAssetUrl } from "../lib/asset-media";
import { CommentBody } from "./CommentBody";
import { DiagramGallery } from "./MultiSampleRunGrid";

export function SampleTimeline({
  events,
  id,
  compact = false,
  onDeleteRecord,
  onDeleteAsset,
}: {
  events: SampleEvent[];
  id?: string;
  compact?: boolean;
  onDeleteRecord?: (event: SampleEvent) => void;
  onDeleteAsset?: (event: SampleEvent) => void;
}) {
  if (!events.length) return <p className="muted timeline-empty">No timeline entries yet.</p>;

  return <div className={`timeline${compact ? " compact-timeline" : ""}`} id={id}>
    {events.map((event) => <article className={`event${event.metadata.deletedAt ? " deleted-event" : ""}`} key={event.id}>
      <div className="event-dot" />
      <div className="event-content">
        <div className="event-meta">
          <span>{sampleEventLabel(event)}{event.metadata.deletedAt ? " · deleted" : ""}{event.actorEmail ? ` · ${event.actorEmail}` : ""}</span>
          <div>
            <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
            {onDeleteAsset && sampleEventAssetUrl(event) && <button type="button" onClick={() => onDeleteAsset(event)}>Delete image</button>}
            {onDeleteRecord && isSampleRecordEvent(event.kind, event.metadata) && <button type="button" onClick={() => onDeleteRecord(event)}>Delete note</button>}
          </div>
        </div>
        {event.body && (event.kind === "comment" || event.kind === "image"
          ? <CommentBody source={event.body} scrollable={compact} />
          : <p>{event.body}</p>)}
        {!compact && sampleEventAssetUrl(event) && <div className="event-asset">
          <DiagramGallery keys={[]} urls={[sampleEventAssetUrl(event)!]}
            thumbnailUrls={{ [sampleEventAssetUrl(event)!]: event.thumbnailUrl ?? (typeof event.metadata.thumbnailKey === "string" ? `/api/assets/${event.metadata.thumbnailKey}` : sampleEventAssetUrl(event)!) }}
            label={event.body || "Timeline attachment"} kind="photo" size="wide" />
        </div>}
      </div>
    </article>)}
  </div>;
}
