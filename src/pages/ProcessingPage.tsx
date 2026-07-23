import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { SampleRun, SampleSummary } from "../../shared/types";
import { EmptyState } from "../components/EmptyState";
import { SampleStateThumbnail } from "../components/SampleStateThumbnail";
import { api } from "../lib/api";

type ProcessingFilter = "active" | "complete" | "cancelled" | "all";

const filters: Array<{ value: ProcessingFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "complete", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

function isProcessingFilter(value: string | null): value is ProcessingFilter {
  return value === "active" || value === "complete" || value === "cancelled" || value === "all";
}

function runStatusLabel(status: SampleRun["status"] | null) {
  if (!status) return "Ready to start";
  if (status === "complete") return "Completed";
  if (status === "cancelled") return "Cancelled";
  if (status === "superseded") return "Superseded";
  return "Active";
}

function matchesFilter(sample: SampleSummary, filter: ProcessingFilter) {
  if (filter === "all") return true;
  if (filter === "active") return sample.status === "active" && (sample.latestRunStatus === "active" || !sample.latestRunStatus);
  return sample.latestRunStatus === filter;
}

export function ProcessingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = searchParams.get("status");
  const filter: ProcessingFilter = isProcessingFilter(requestedFilter) ? requestedFilter : "active";
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

  const counts = useMemo(() => Object.fromEntries(filters.map(({ value }) => [
    value,
    samples.filter((sample) => matchesFilter(sample, value)).length,
  ])) as Record<ProcessingFilter, number>, [samples]);
  const visibleSamples = useMemo(() => samples.filter((sample) => matchesFilter(sample, filter)), [filter, samples]);

  function selectFilter(nextFilter: ProcessingFilter) {
    const next = new URLSearchParams(searchParams);
    if (nextFilter === "active") next.delete("status"); else next.set("status", nextFilter);
    setSearchParams(next, { replace: true });
  }

  return <div className="page processing-page">
    <div className="page-heading">
      <div><p className="eyebrow">Cleanroom workspace</p><h1>Processing</h1><p className="lead">Continue active process runs, or open a completed run for reference.</p></div>
      <div className="header-actions"><Link className="button" to="/samples/new">New sample</Link><Link className="button" to="/samples">All samples</Link></div>
    </div>
    <div className="processing-controls">
      <div className="segmented-control" aria-label="Filter processing runs">
        {filters.map(({ value, label }) => <button type="button" className={filter === value ? "selected" : ""} aria-pressed={filter === value} key={value} onClick={() => selectFilter(value)}>{label}<span>{counts[value]}</span></button>)}
      </div>
      <label className="search-box compact-search"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Code, name, process template, or location" /></label>
    </div>
    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading…</p> : visibleSamples.length ? <div className="processing-list">
      {visibleSamples.map((sample) => <Link to={`/processing/${sample.id}`} className="processing-row" key={sample.id}>
        <SampleStateThumbnail sample={sample} />
        <div className="processing-sample"><strong className="sample-code">{sample.code}</strong><span>{sample.title}</span><small>{sample.location || "No location"}</small></div>
        <div className="processing-workflow"><small>Process template</small><strong>{sample.latestWorkflowName ? `${sample.latestWorkflowName}${sample.latestWorkflowVersion != null ? ` · v${sample.latestWorkflowVersion}` : ""}` : "No process run yet"}</strong><span>{sample.currentStepTitle ? `Next · ${sample.currentStepTitle}` : sample.latestRunStatus === "complete" ? "Process run completed" : "Open to start a process run"}</span></div>
        <div className="processing-row-side"><span className={`run-status run-status-${sample.latestRunStatus || "ready"}`}>{runStatusLabel(sample.latestRunStatus)}</span><time>{new Date(sample.updatedAt).toLocaleDateString()}</time></div>
      </Link>)}
    </div> : <EmptyState title={query ? "No matching process runs" : filter === "active" ? "No active processing" : `No ${filter} process runs`}>
      {query ? "Try another code, name, process template, or location." : filter === "active" ? "Samples without a process run will also appear here, ready to start." : "Choose another status to inspect other runs."}
    </EmptyState>}
  </div>;
}
