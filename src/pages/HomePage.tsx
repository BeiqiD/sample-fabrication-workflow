import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SampleSummary } from "../../shared/types";
import { EmptyState } from "../components/EmptyState";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";

export function HomePage() {
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

  return <div className="page narrow-page">
    <div className="page-heading">
      <div><p className="eyebrow">Workspace</p><h1>Samples</h1></div>
      <Link className="button primary" to="/samples/new">New sample</Link>
    </div>
    <label className="search-box">
      <span>Search</span>
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Code, title, or location" />
    </label>
    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading…</p> : samples.length ? <div className="sample-list">
      {samples.map((sample) => <Link to={`/samples/${sample.id}`} className="sample-row" key={sample.id}>
        <div className="sample-code">{sample.code}</div>
        <div className="sample-main"><strong>{sample.title}</strong><span>{sample.location || "No location"}</span></div>
        <StatusPill status={sample.status} />
        <time>{new Date(sample.updatedAt).toLocaleDateString()}</time>
      </Link>)}
    </div> : <EmptyState title={query ? "No matching samples" : "No samples yet"}>
      {query ? "Try another code or location." : "Create the first sample to start its event log."}
    </EmptyState>}
  </div>;
}
