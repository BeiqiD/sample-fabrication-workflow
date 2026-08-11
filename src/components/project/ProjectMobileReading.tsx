import type { ProjectSnapshot } from "../../../shared/project-api";
import { projectMobileItems } from "../../lib/project-map";

export function ProjectMobileReading({ snapshot }: { snapshot: ProjectSnapshot }) {
  const items = projectMobileItems(snapshot);
  return <section className="project-mobile-reading" aria-label="Project read-only mobile projection">
    <header>
      <p className="card-label">Mobile projection</p>
      <h2>Project occurrences</h2>
      <p className="muted">Read-only insertion order for Phase 3B1. Full Reading editing arrives in Phase 3C.</p>
    </header>
    {items.length ? <div className="project-mobile-items">
      {items.map((item) => <article className={`card project-mobile-item project-mobile-item-${item.kind}`} key={item.itemId}>
        <div className="card-copy">
          <p className="card-label">{item.kind} · {item.createdSequence}</p>
          <h3 className="card-title">{item.title}</h3>
          {item.meta && <p className="card-meta">{item.meta}</p>}
          {item.excerpt && <p className="project-mobile-excerpt">{item.excerpt}</p>}
        </div>
        {item.openUrl && <a className="text-button" href={item.openUrl}>Open →</a>}
      </article>)}
    </div> : <div className="card"><p className="muted padded">This Project has no active occurrences yet.</p></div>}
  </section>;
}
