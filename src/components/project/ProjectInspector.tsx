import type { ProjectMapGeometry } from "../../../shared/project-types";
import type { ProjectMapNodeModel } from "../../lib/project-map";

export function ProjectInspector({
  node,
  geometry,
}: {
  node: ProjectMapNodeModel | null;
  geometry: ProjectMapGeometry | null;
}) {
  return <aside className="project-inspector" aria-label="Project Inspector">
    <div className="project-inspector-heading">
      <p className="card-label">Inspector</p>
      <h2>{node ? node.title : "Nothing selected"}</h2>
    </div>
    {!node || !geometry ? <p className="muted">Select a Map item to inspect its current Project-local placement.</p> : <>
      <dl className="project-inspector-facts">
        <div><dt>Kind</dt><dd>{node.kind}</dd></div>
        <div><dt>Position</dt><dd>{Math.round(geometry.x)}, {Math.round(geometry.y)}</dd></div>
        <div><dt>Size</dt><dd>{Math.round(geometry.width)} × {Math.round(geometry.height)}</dd></div>
        <div><dt>Reading order</dt><dd>{node.createdSequence}</dd></div>
      </dl>
      {node.meta && <p className="card-meta">{node.meta}</p>}
      {node.openUrl && <a className="button wide" href={node.openUrl}>Open reference</a>}
    </>}
  </aside>;
}
