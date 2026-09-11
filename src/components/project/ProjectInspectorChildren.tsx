import {
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  ListReferenceChildrenResponse,
} from "../../../shared/reference-children";
import type {
  ReferenceResolution,
  ReferenceTarget,
} from "../../../shared/reference-types";
import { listReferenceChildren } from "../../lib/reference-api";
import { projectInspectorReferenceTypeLabel } from "../../lib/project-inspector-model";
import "./project-inspector-children.css";

type ChildLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; response: ListReferenceChildrenResponse };

export interface ProjectInspectorChildrenProps {
  parent: ReferenceTarget;
  placementDisabled: boolean;
  onPlaceAtCenter: (resolution: ReferenceResolution) => void;
}

function childTitle(resolution: ReferenceResolution) {
  return resolution.source?.title || resolution.target.id;
}

export function ProjectInspectorChildren({
  parent,
  placementDisabled,
  onPlaceAtCenter,
}: ProjectInspectorChildrenProps) {
  const controllerRef = useRef<AbortController | null>(null);
  const [loadState, setLoadState] = useState<ChildLoadState>({ status: "idle" });

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setLoadState({ status: "idle" });
    return () => controllerRef.current?.abort();
  }, [parent.id, parent.type]);

  const loadChildren = () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadState({ status: "loading" });
    void listReferenceChildren({ parent }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (controllerRef.current === controller) controllerRef.current = null;
        setLoadState({ status: "ready", response });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (controllerRef.current === controller) controllerRef.current = null;
        const message = caught instanceof Error
          ? caught.message
          : "Direct child references could not be loaded";
        setLoadState({ status: "error", message });
      });
  };

  const response = loadState.status === "ready" ? loadState.response : null;
  const children = Array.isArray(response?.children) ? response.children : [];

  return <section
    className="project-inspector-section project-inspector-children"
    aria-label="Related reference records"
  >
    <h3>Related records</h3>
    {loadState.status === "idle" && <button
      type="button"
      className="button compact-button"
      onClick={loadChildren}
    >Browse related records</button>}
    {loadState.status === "loading" && <p className="muted" role="status">
      Loading child references…
    </p>}
    {loadState.status === "error" && <div className="project-inspector-children-message error">
      <p>{loadState.message}</p>
      <button
        type="button"
        className="button compact-button"
        onClick={loadChildren}
      >Retry</button>
    </div>}
    {response && !response.parentEligible && <p className="muted">
      This source is no longer eligible for new Project references.
    </p>}
    {response?.parentEligible && children.length === 0 && <p className="muted">
      No related child records are available.
    </p>}
    {children.length > 0 && <>
      <ul className="project-inspector-child-list">
        {children.map((child) => {
          const title = childTitle(child);
          return <li key={`${child.target.type}\u0000${child.target.id}`}>
            <div>
              <span>{projectInspectorReferenceTypeLabel(child.target.type)}</span>
              <strong>{title}</strong>
              {child.source?.subtitle && <small>{child.source.subtitle}</small>}
              {child.source?.excerpt && <p>{child.source.excerpt}</p>}
            </div>
            <button
              type="button"
              className="button compact-button"
              disabled={placementDisabled}
              aria-label={`Place ${title} on Map`}
              onClick={() => onPlaceAtCenter(child)}
            >Place</button>
          </li>;
        })}
      </ul>
      {response?.truncated && <small className="muted">
        More related records exist; use Reference search for the complete set.
      </small>}
    </>}
  </section>;
}
