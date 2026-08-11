import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ProjectRecord } from "../../shared/project-api";
import { EmptyState } from "../components/EmptyState";
import { createProjectApiId, projectApi } from "../lib/project-client";
import "../project.css";

export function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    projectApi.list(controller.signal).then((result) => {
      setProjects(result.projects);
      setError("");
    }).catch((caught: Error) => {
      if (caught.name !== "AbortError") setError(caught.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle || creating) return;
    setCreating(true);
    setError("");
    try {
      const result = await projectApi.create({
        id: createProjectApiId("project"),
        title: normalizedTitle,
        operationId: createProjectApiId("operation"),
      });
      navigate(`/projects/${result.project.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The Project could not be created");
      setCreating(false);
    }
  }

  return <div className="page projects-page">
    <div className="page-heading">
      <div>
        <p className="eyebrow">Research workspace</p>
        <h1>Projects</h1>
        <p className="lead">Arrange experimental records, Project notes, and files in one spatial research workspace.</p>
      </div>
      <div className="header-actions">
        <button
          type="button"
          className="button primary"
          aria-expanded={createOpen}
          onClick={() => setCreateOpen((open) => !open)}
        >New Project</button>
      </div>
    </div>

    {createOpen && <form className="card project-create-form" onSubmit={createProject}>
      <label>
        <span>Project title</span>
        <input
          autoFocus
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. Topological laser fabrication"
        />
      </label>
      <div className="form-actions">
        <button type="button" className="button" onClick={() => setCreateOpen(false)}>Cancel</button>
        <button type="submit" className="button primary" disabled={!title.trim() || creating}>
          {creating ? "Creating…" : "Create Project"}
        </button>
      </div>
    </form>}

    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading Projects…</p> : projects.length > 0
      ? <div className="project-directory">
        <div className="project-directory-head" aria-hidden="true">
          <span>Project</span><span>Revision</span><span>Updated</span>
        </div>
        {projects.map((project) => <Link
          key={project.id}
          className="project-directory-row"
          to={`/projects/${project.id}`}
        >
          <div>
            <strong>{project.title}</strong>
            <small>{project.id}</small>
          </div>
          <span>v{project.revision}</span>
          <time dateTime={project.updatedAt}>{new Date(project.updatedAt).toLocaleString()}</time>
        </Link>)}
      </div>
      : <EmptyState title="No Projects yet">
        Create the first Project to open a Map workspace.
      </EmptyState>}
  </div>;
}
