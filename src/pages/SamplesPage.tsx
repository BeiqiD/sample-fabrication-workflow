import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SampleSummary } from "../../shared/types";
import { EmptyState } from "../components/EmptyState";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";

function workflowStateText(sample: SampleSummary) {
  if (!sample.latestWorkflowName) return "No workflow assigned";
  if (sample.latestRunStatus === "active") return sample.currentStepTitle ? `Current step · ${sample.currentStepTitle}` : "Active workflow";
  if (sample.latestRunStatus === "complete") return "Workflow completed";
  if (sample.latestRunStatus === "cancelled") return "Latest workflow cancelled";
  return "Latest workflow superseded";
}

export function SamplesPage() {
  const [samples, setSamples] = useState<SampleSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setLoading(true);
      api.listSamples(query).then(({ samples }) => {
        setSamples(samples);
        setError("");
      }).catch((error: Error) => setError(error.message)).finally(() => setLoading(false));
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [query]);

  return <div className="page samples-page">
    <div className="page-heading">
      <div><p className="eyebrow">Permanent archive</p><h1>Samples</h1><p className="lead">Browse sample identity, location, processing state, and complete history.</p></div>
      <div className="header-actions"><Link className="button primary" to="/samples/new">New sample</Link></div>
    </div>
    <label className="search-box">
      <span>Search</span>
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Code, title, workflow, or location" />
    </label>
    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading…</p> : samples.length ? <div className="sample-directory">
      <div className="sample-directory-head" aria-hidden="true"><span>Sample</span><span>Status / location</span><span>Latest workflow</span><span>Updated</span></div>
      {samples.map((sample) => <Link to={`/samples/${sample.id}`} className="sample-directory-row" key={sample.id}>
        <div className="sample-directory-identity"><div className="sample-identity"><span className="sample-code">{sample.code}</span>{sample.pinned && <span className="sample-pinned">Pinned</span>}</div><strong>{sample.title}</strong>{sample.parentId && <small>Child sample</small>}</div>
        <div className="sample-directory-state"><StatusPill status={sample.status} /><span>{sample.location || "No location"}</span></div>
        <div className="sample-directory-workflow"><strong>{sample.latestWorkflowName || "—"}{sample.latestWorkflowVersion != null ? ` · v${sample.latestWorkflowVersion}` : ""}</strong><small>{workflowStateText(sample)}</small></div>
        <time>{new Date(sample.updatedAt).toLocaleDateString()}</time>
      </Link>)}
    </div> : <EmptyState title={query ? "No matching samples" : "No samples yet"}>
      {query ? "Try another code, title, workflow, or location." : "Create the first sample to start its event log."}
    </EmptyState>}
  </div>;
}
