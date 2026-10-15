import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isCreateProjectInput, type CreateProjectInput, type ProjectRecord } from "../../shared/project-api";
import { createProjectApiId, ProjectApiError, projectApi, projectDirectorySubject } from "../lib/project-client";
import { authenticationSnapshot, subscribeAuthentication, usesLocalAuthentication } from "../lib/authentication-client";
import "../project.css";

type ProjectDirectoryState = "loading" | "ready" | "error";
const creationIntentKey = (subject: string) => `project-directory-create-intent:${subject}`;

function savedCreationIntent(subject: string): CreateProjectInput | null {
  try {
    const input: unknown = JSON.parse(sessionStorage.getItem(creationIntentKey(subject)) || "null");
    if (isCreateProjectInput(input) && Object.keys(input).length === 3) return input;
  } catch { /* Browser storage is not an authority for a Project mutation. */ }
  return null;
}

function forgetCreationIntent(subject: string, input: CreateProjectInput) {
  try {
    const current = savedCreationIntent(subject);
    if (current?.id === input.id && current.operationId === input.operationId && current.title === input.title) {
      sessionStorage.removeItem(creationIntentKey(subject));
    }
  } catch { /* Retaining a confirmed intent cannot authorize automatic replay. */ }
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [directoryState, setDirectoryState] = useState<ProjectDirectoryState>("loading");
  const [loadError, setLoadError] = useState("");
  const [pendingCreation, setPendingCreation] = useState<CreateProjectInput | null>(null);
  const pendingCreationRef = useRef(pendingCreation);
  const [creationSubject, setCreationSubject] = useState<string | null>(null);
  const creationSubjectRef = useRef<string | null>(null), identityFence = useRef(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const creationBusy = useRef(false), mounted = useRef(true);
  const directoryRequest = useRef<AbortController | null>(null);

  const loadProjects = useCallback(async () => {
    directoryRequest.current?.abort();
    const controller = new AbortController();
    directoryRequest.current = controller;
    const signal = controller.signal;
    const identity = identityFence.current;
    const previousSubject = creationSubjectRef.current;
    creationSubjectRef.current = null; setCreationSubject(null);
    setDirectoryState("loading");
    setLoadError("");
    try {
      const result = await projectApi.list(signal);
      if (signal.aborted || directoryRequest.current !== controller || identity !== identityFence.current) return;
      setProjects(result.projects);
      const subject = projectDirectorySubject(result), retained = subject ? savedCreationIntent(subject) : null;
      creationSubjectRef.current = subject; setCreationSubject(subject);
      pendingCreationRef.current = retained; setPendingCreation(retained);
      if (retained) { setCreateOpen(true); setTitle(retained.title); }
      else if (previousSubject !== subject) { setCreateOpen(false); setTitle(""); setCreateError(""); }
      setDirectoryState("ready");
    } catch (caught) {
      if (signal.aborted || directoryRequest.current !== controller || (caught instanceof Error && caught.name === "AbortError")) return;
      setLoadError(caught instanceof Error ? caught.message : "Projects could not be loaded");
      setDirectoryState("error");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadProjects();
    let principal = JSON.stringify(authenticationSnapshot());
    const unsubscribe = usesLocalAuthentication() ? subscribeAuthentication(() => {
      const current = JSON.stringify(authenticationSnapshot()); if (current === principal) return;
      principal = current; identityFence.current++;
      directoryRequest.current?.abort();
      creationSubjectRef.current = null; pendingCreationRef.current = null;
      setCreationSubject(null); setPendingCreation(null); setCreateOpen(false); setTitle(""); setCreateError("");
      creationBusy.current = false; setCreating(false);
    }) : () => {};
    return () => { mounted.current = false; identityFence.current++; directoryRequest.current?.abort(); unsubscribe(); };
  }, [loadProjects]);

  function openCreateForm() {
    if (creating) return;
    setCreateError("");
    if (pendingCreationRef.current) setTitle(pendingCreationRef.current.title);
    setCreateOpen(true);
  }

  function closeCreateForm() {
    if (creating) return;
    setCreateOpen(false);
    setTitle(pendingCreationRef.current?.title ?? "");
    setCreateError("");
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    const subject = creationSubjectRef.current;
    if (!normalizedTitle || !subject || creationBusy.current) return;
    const identity = identityFence.current, retrying = !!pendingCreationRef.current;
    const input = pendingCreationRef.current ?? {
      id: createProjectApiId("project"), title: normalizedTitle,
      operationId: createProjectApiId("operation"),
    };
    creationBusy.current = true;
    setCreating(true);
    setCreateError("");
    try {
      if (!mounted.current || identity !== identityFence.current || creationSubjectRef.current !== subject) return;
      // Retain the exact input before POST. The server compares the same
      // expected subject against its own current authenticated request actor.
      try { sessionStorage.setItem(creationIntentKey(subject), JSON.stringify(input)); }
      catch { throw new Error("Project creation cannot be retained in this browser. No request was sent."); }
      pendingCreationRef.current = input; setPendingCreation(input);
      const result = await projectApi.create(input, subject);
      if (!result.project || result.project.id !== input.id || result.project.title !== input.title) {
        throw new Error("The Project creation response did not match the original request.");
      }
      forgetCreationIntent(subject, input);
      if (!mounted.current || identity !== identityFence.current || creationSubjectRef.current !== subject) return;
      pendingCreationRef.current = null;
      setPendingCreation(null);
      navigate(`/projects/${result.project.id}`);
    } catch (caught) {
      if (caught instanceof ProjectApiError && caught.creationSubjectChanged && mounted.current && identity === identityFence.current) {
        creationSubjectRef.current = null; setCreationSubject(null); pendingCreationRef.current = null; setPendingCreation(null); setTitle("");
      }
      if (!retrying && caught instanceof ProjectApiError && (caught.status === 400 || caught.mutationDisposition === "authoritative-rejection")) {
        forgetCreationIntent(subject, input);
        if (mounted.current && identity === identityFence.current && creationSubjectRef.current === subject) {
          pendingCreationRef.current = null; setPendingCreation(null);
        }
      }
      if (!mounted.current || identity !== identityFence.current) return;
      setCreateError(caught instanceof Error ? caught.message : "The Project could not be created");
    } finally {
      if (identity === identityFence.current) { creationBusy.current = false; if (mounted.current) setCreating(false); }
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
        <button type="button" className="button" disabled={creating || directoryState === "loading"} onClick={() => void loadProjects()}>Refresh Projects</button>
        <button
          type="button"
          className={createOpen ? "button" : "button primary"}
          aria-controls="project-create-form"
          aria-expanded={createOpen}
          disabled={creating || !creationSubject || !!pendingCreation && !createOpen}
          onClick={createOpen ? closeCreateForm : openCreateForm}
        >{createOpen ? "Close new Project form" : "New Project"}</button>
      </div>
    </div>

    {directoryState === "ready" && !creationSubject && <p role="status">Refresh Projects to check your sign-in before creating a workspace.</p>}

    {pendingCreation && <div className="card project-directory-state" role="status">
      <p>Creation of <strong>{pendingCreation.title}</strong> is unconfirmed. Retry the original request to check its result; the same Project identity will be used.</p>
      {!createOpen && <button type="button" className="button primary" onClick={openCreateForm}>Review unconfirmed Project</button>}
    </div>}

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
          readOnly={!!pendingCreation}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. Topological laser fabrication"
        />
      </label>
      <div className="form-actions">
        <button type="button" className="button" disabled={creating} onClick={closeCreateForm}>Cancel</button>
        <button type="submit" className="button primary" disabled={!title.trim() || creating || !creationSubject}>
          {creating ? "Creating…" : pendingCreation ? "Retry Project creation" : "Create Project"}
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
      </div> : projects.length > 0 ? <div className="project-directory">
        <div className="project-directory-head" aria-hidden="true">
          <span>Project</span><span>Created</span><span>Updated</span>
        </div>
        <div className="project-directory-list" role="list" aria-label="Active Projects">
          {projects.map((project) => <div key={project.id} role="listitem">
            <Link
              className="project-directory-row"
              to={`/projects/${project.id}`}
            >
              <div className="project-directory-identity">
                <strong>{project.title}</strong>
                <small>{project.id}</small>
              </div>
              <div className="project-directory-date">
                <span className="project-directory-date-label">Created </span>
                <time dateTime={project.createdAt}>{new Date(project.createdAt).toLocaleString()}</time>
              </div>
              <div className="project-directory-date">
                <span className="project-directory-date-label">Updated </span>
                <time dateTime={project.updatedAt}>{new Date(project.updatedAt).toLocaleString()}</time>
              </div>
            </Link>
          </div>)}
        </div>
      </div> : <div className="project-directory-state empty">
        <div>
          <h3>No Projects yet</h3>
          <p>Create the first Project to open a Map workspace for references, Markdown, and files.</p>
        </div>
        {!createOpen && <button type="button" className="button primary" disabled={!!pendingCreation || !creationSubject} onClick={openCreateForm}>Create first Project</button>}
      </div>}
    </section>
  </div>;
}
