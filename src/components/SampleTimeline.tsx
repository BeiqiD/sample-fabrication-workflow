import type { SampleEvent } from "../../shared/types";
import { isSampleRecordEvent } from "../../shared/sample-records";
import { sampleEventLabel } from "../lib/sampleHistory";
import { CommentBody } from "./CommentBody";

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
            <time>{new Date(event.createdAt).toLocaleString()}</time>
            {onDeleteAsset && event.assetKey && <button type="button" onClick={() => onDeleteAsset(event)}>Delete image</button>}
            {onDeleteRecord && isSampleRecordEvent(event.kind, event.metadata) && <button type="button" onClick={() => onDeleteRecord(event)}>Delete note</button>}
          </div>
        </div>
        {event.body && (event.kind === "comment" || event.kind === "image"
          ? <CommentBody source={event.body} />
          : <p>{event.body}</p>)}
        {!compact && event.assetKey && <div className="event-asset">
          <a href={`/api/assets/${event.assetKey}`} target="_blank" rel="noreferrer">
            <img
              src={`/api/assets/${typeof event.metadata.thumbnailKey === "string" ? event.metadata.thumbnailKey : event.assetKey}`}
              alt={event.body || "Timeline attachment"}
              loading="lazy"
            />
          </a>
        </div>}
      </div>
    </article>)}
  </div>;
}
