import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ProjectSnapshot } from "../../shared/project-api";
import { ProjectMobileReading } from "../components/project/ProjectMobileReading";
import { projectApi } from "../lib/project-api";
import "../project-map.css";

const ProjectMapEditor = lazy(() => import("../components/project/ProjectMapEditor")
  .then((module) => ({ default: module.ProjectMapEditor })));

const DESKTOP_MAP_QUERY = "(min-width: 901px)";

function useDesktopMap() {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(DESKTOP_MAP_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_MAP_QUERY);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return desktop;
}

export function ProjectWorkspacePage() {
  const { projectId = "" } = useParams();
  const desktop = useDesktopMap();
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    projectApi.getProject(projectId, controller.signal).then((result) => {
      setSnapshot(result);
      setError("");
    }).catch((cause: Error) => {
      if (cause.name !== "AbortError") setError(cause.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [projectId, reloadToken]);

  return <div className="page project-workspace-page">
    <div className="project-workspace-heading">
      <div>
        <Link className="back-link" to="/projects">← Projects</Link>
        <p className="eyebrow">Project workspace</p>
        <h1>{snapshot?.project.title || "Project"}</h1>
      </div>
      {snapshot && <p className="project-workspace-meta">Revision {snapshot.project.revision} · {snapshot.items.length} occurrence{snapshot.items.length === 1 ? "" : "s"}</p>}
    </div>
    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading Project…</p> : snapshot ? desktop ? <Suspense fallback={<div className="card"><p className="muted padded">Loading desktop Map…</p></div>}>
      <ProjectMapEditor snapshot={snapshot} onReload={() => setReloadToken((value) => value + 1)} />
    </Suspense> : <ProjectMobileReading snapshot={snapshot} /> : !error ? <p className="muted">Project not found.</p> : null}
  </div>;
}
