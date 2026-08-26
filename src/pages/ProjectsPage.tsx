import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ProjectRecord } from "../../shared/project-api";
import { createProjectApiId, projectApi } from "../lib/project-client";
import "../project.css";

type ProjectDirectoryState = "loading" | "ready" | "error";

export function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [directoryState, setDirectoryState] = useState<ProjectDirectoryState>("loading");
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    setDirectoryState("loading");
    setLoadError("");
    try {
      const result = await projectApi.list(signal);
      if (signal?.aborted) return;
      setProjects(result.projects);
      setDirectoryState("ready");
    } catch (caught) {
      if (signal?.aborted || (caught instanceof Error && caught.name === "AbortError")) return;
      setLoadError(caught instanceof Error ? caught.message : "Projects could not be loaded");
      setDirectoryState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjects(controller.signal);
    return () => controller.abort();
  }, [loadProjects]);

  function openCreateForm() {
    if (creating) return;
    setCreateError("");
    setCreateOpen(true);
  }

  function closeCreateForm() {
    if (creating) return;
    setCreateOpen(false);
    setTitle("");
    setCreateError("");
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const result = await projectApi.create({
        id: createProjectApiId("project"),
        title: normalizedTitle,
        operationId: createProjectApiId("operation"),
      });
      navigate(`/projects/${result.project.id}`);
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "The Project could not be created");
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
          aria-controls="project-create-form"
          aria-expanded={createOpen}
          disabled={creating}
          onClick={createOpen ? closeCreateForm : openCreateForm}
        >{createOpen ? "Close new Project form" : "New Project"}</button>
      </div>
    </div>

    {createOpen && <form
      id="project-create-form"
      className="card project-create-form"
      aria-labelledby="project-create-title"
      onSubmit={createProject}
    >
      <div className="project-create-form-heading">
        <div>
          <p className="card-label">New research workspace</p>
          <h2 id="project-create-title">Create Project</h2>
        </div>
        <p className="card-meta">Give the workspace a durable research-question or campaign title. Content is added after opening its Map.</p>
      </div>
      <label>
        <span>Project title</span>
        <input
          autoFocus
          value={title}
          maxLength={200}
          disabled={creating}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. Topological laser fabrication"
        />
      </label>
      <div className="form-actions">
        <button type="button" className="button" disabled={creating} onClick={closeCreateForm}>Cancel</button>
        <button type="submit" className="button primary" disabled={!title.trim() || creating}>
          {creating ? "Creating…" : "Create Project"}
        </button>
      </div>
      {createError && <p className="project-create-error" role="alert">{createError}</p>}
    </form>}

    <section className="project-directory-section" aria-labelledby="project-directory-title">
      <div className="project-directory-section-heading">
        <div>
          <p className="card-label">Active workspaces</p>
          <h2 id="project-directory-title">Your Projects</h2>
        </div>
        {directoryState === "ready" && projects.length > 0 && <span className="meta-badge">
          {projects.length} {projects.length === 1 ? "Project" : "Projects"}
        </span>}
      </div>

      {directoryState === "loading" ? <div className="project-directory-state loading" role="status" aria-live="polite">
        <p>Loading Projects…</p>
      </div> : directoryState === "error" ? <div className="project-directory-state error" role="alert">
        <div>
          <h3>Projects could not be loaded</h3>
          <p>{loadError}</p>
        </div>
        <button type="button" className="button" onClick={() => void loadProjects()}>Retry loading Projects</button>
      </div> : projects.length > 0 ? <div className="project-directory" aria-label="Active Projects">
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
      </div> : <div className="project-directory-state empty">
        <div>
          <h3>No Projects yet</h3>
          <p>Create the first Project to open a Map workspace for references, Markdown, and files.</p>
        </div>
        {!createOpen && <button type="button" className="button primary" onClick={openCreateForm}>Create first Project</button>}
      </div>}
    </section>
  </div>;
}
