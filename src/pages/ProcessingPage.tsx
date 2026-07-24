import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { PaginationMeta, SampleListFacets, SampleRun, SampleSummary } from "../../shared/types";
import { EmptyState } from "../components/EmptyState";
import { PaginationControls } from "../components/PaginationControls";
import { SampleStateThumbnail } from "../components/SampleStateThumbnail";
import { api } from "../lib/api";
import { pageFromSearchParam, setPageParam } from "../lib/pagination";

type ProcessingFilter = "active" | "complete" | "cancelled" | "all";

const filters: Array<{ value: ProcessingFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "complete", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];
const EMPTY_PAGINATION: PaginationMeta = { page: 1, pageSize: 50, total: 0, totalPages: 1 };
const EMPTY_FACETS: SampleListFacets = { active: 0, complete: 0, cancelled: 0, all: 0 };

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

export function ProcessingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = searchParams.get("status");
  const filter: ProcessingFilter = isProcessingFilter(requestedFilter) ? requestedFilter : "active";
  const requestedQuery = searchParams.get("q") ?? "";
  const requestedPage = pageFromSearchParam(searchParams.get("page"));
  const [samples, setSamples] = useState<SampleSummary[]>([]);
  const [query, setQuery] = useState(requestedQuery);
  const [pagination, setPagination] = useState<PaginationMeta>(EMPTY_PAGINATION);
  const [counts, setCounts] = useState<SampleListFacets>(EMPTY_FACETS);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setQuery(requestedQuery);
  }, [requestedQuery]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized === requestedQuery) return;
    const timeout = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (normalized) next.set("q", normalized); else next.delete("q");
      next.delete("page");
      setSearchParams(next, { replace: true });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [query, requestedQuery, searchParams, setSearchParams]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.listSamples({
      query: requestedQuery,
      page: requestedPage,
      pageSize: 50,
      view: "processing",
      status: filter,
      signal: controller.signal,
    }).then((result) => {
      if (requestedPage > result.pagination.totalPages) {
        setSearchParams((current) => setPageParam(current, "page", result.pagination.totalPages), { replace: true });
        return;
      }
      setSamples(result.samples);
      setPagination(result.pagination);
      setCounts(result.facets ?? EMPTY_FACETS);
      setError("");
    }).catch((error: Error) => {
      if (error.name !== "AbortError") setError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [filter, requestedPage, requestedQuery, setSearchParams]);

  function selectFilter(nextFilter: ProcessingFilter) {
    const next = new URLSearchParams(searchParams);
    if (nextFilter === "active") next.delete("status"); else next.set("status", nextFilter);
    next.delete("page");
    setSearchParams(next, { replace: true });
  }

  function changePage(page: number) {
    setSearchParams(setPageParam(searchParams, "page", page));
    window.scrollTo({ top: 0, behavior: "smooth" });
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
      <label className="search-box compact-search"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search processing…" /></label>
    </div>
    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading…</p> : samples.length ? <div className="processing-list">
      {samples.map((sample) => <Link to={`/processing/${sample.id}`} className="processing-row" key={sample.id}>
        <SampleStateThumbnail sample={sample} />
        <div className="processing-sample"><strong className="sample-code">{sample.code}</strong><span>{sample.title}</span><small>{sample.location || "No location"}</small></div>
        <div className="processing-workflow"><small>Process template</small><strong>{sample.latestWorkflowName ? `${sample.latestWorkflowName}${sample.latestWorkflowVersion != null ? ` · v${sample.latestWorkflowVersion}` : ""}` : "No process run yet"}</strong><span>{sample.currentStepTitle ? `Next · ${sample.currentStepTitle}` : sample.latestRunStatus === "complete" ? "Process run completed" : "Open to start a process run"}</span></div>
        <div className="processing-row-side"><span className={`run-status run-status-${sample.latestRunStatus || "ready"}`}>{runStatusLabel(sample.latestRunStatus)}</span><time>{new Date(sample.updatedAt).toLocaleDateString()}</time></div>
      </Link>)}
    </div> : <EmptyState title={requestedQuery ? "No matching process runs" : filter === "active" ? "No active processing" : `No ${filter} process runs`}>
      {requestedQuery ? "Try another code, name, process template, or location." : filter === "active" ? "Samples without a process run will also appear here when they are marked active." : "Choose another status to inspect other runs."}
    </EmptyState>}
    <PaginationControls pagination={pagination} label="Processing pages" disabled={loading} onPageChange={changePage} />
  </div>;
}
