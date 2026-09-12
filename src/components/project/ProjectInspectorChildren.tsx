import type { ReferenceTarget } from "../../../shared/reference-types";
import "./project-inspector-children.css";

export interface ProjectInspectorChildrenProps {
  parent: ReferenceTarget;
  disabled?: boolean;
  onBrowseRelated: (parent: ReferenceTarget) => void;
}

export function ProjectInspectorChildren({
  parent,
  disabled = false,
  onBrowseRelated,
}: ProjectInspectorChildrenProps) {
  return <section
    className="project-inspector-section project-inspector-children"
    aria-label="Related reference records"
  >
    <button
      type="button"
      className="button compact-button"
      disabled={disabled}
      onClick={() => onBrowseRelated(parent)}
    >Browse related records</button>
  </section>;
}
