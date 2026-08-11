import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ProjectRecord } from "../../shared/project-api";
import { isProjectTitle } from "../../shared/project-api";
import { projectApi } from "../lib/project-api";
import { newProjectOperationId } from "../lib/project-map";

function newProjectId() {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `project-${uuid}`;
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    projectApi.listProjects(controller.signal).then((response) => {
      setProjects(response.projects);
      setError("");
    }).catch((cause: Error) => {
      if (cause.name !== "AbortError") setError(cause.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    const normalized = title.trim();
    if (!normalized || creating) return;
    if (!isProjectTitle(normalized)) {
      setError("Project title must contain 1–200 Unicode characters and no surrounding whitespace.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const result = await projectApi.createProject({
        id: newProjectId(),
        title: normalized,
        operationId: newProjectOperationId("project-create"),
      });
      navigate(`/projects/${encodeURIComponent(result.project.id)}`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return <div className="page projects-page">
    <div className="page-heading project-directory-heading">
      <div>
        <p className="eyebrow">Research workspace</p>
        <h1>Projects</h1>
        <p className="lead">Open a spatial research workspace without changing the underlying sample, run, or metrology record.</p>
      </div>
      <form className="project-create-form" onSubmit={(event) => void createProject(event)}>
        <label>
          <span>Project title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="New project…"
            disabled={creating}
          />
        </label>
        <button type="submit" className="button primary" disabled={creating || !title.trim()}>
          {creating ? "Creating…" : "New Project"}
        </button>
      </form>
    </div>
    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading Projects…</p> : projects.length ? <div className="project-directory-grid">
      {projects.map((project) => <Link className="card project-directory-card" to={`/projects/${encodeURIComponent(project.id)}`} key={project.id}>
        <div className="card-copy">
          <p className="card-label">Project</p>
          <h2 className="card-title">{project.title}</h2>
          <p className="card-meta">Updated {new Date(project.updatedAt).toLocaleString()}</p>
        </div>
        <span className="project-directory-open">Open →</span>
      </Link>)}
    </div> : <div className="card"><p className="muted padded">No Projects yet. Create one to start organizing research context.</p></div>}
  </div>;
}
