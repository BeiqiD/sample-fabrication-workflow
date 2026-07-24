import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { PaginationMeta, SampleSummary } from "../../shared/types";
import { EmptyState } from "../components/EmptyState";
import { PaginationControls } from "../components/PaginationControls";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";
import { pageFromSearchParam, setPageParam } from "../lib/pagination";

const EMPTY_PAGINATION: PaginationMeta = { page: 1, pageSize: 50, total: 0, totalPages: 1 };

function workflowStateText(sample: SampleSummary) {
  if (!sample.latestWorkflowName) return "No process run yet";
  if (sample.latestRunStatus === "active") return sample.currentStepTitle ? `Current step · ${sample.currentStepTitle}` : "Active process run";
  if (sample.latestRunStatus === "complete") return "Process run completed";
  if (sample.latestRunStatus === "cancelled") return "Latest process run cancelled";
  return "Latest process run superseded";
}

export function SamplesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedQuery = searchParams.get("q") ?? "";
  const requestedPage = pageFromSearchParam(searchParams.get("page"));
  const [samples, setSamples] = useState<SampleSummary[]>([]);
  const [query, setQuery] = useState(requestedQuery);
  const [pagination, setPagination] = useState<PaginationMeta>(EMPTY_PAGINATION);
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
      signal: controller.signal,
    }).then((result) => {
      if (requestedPage > result.pagination.totalPages) {
        setSearchParams((current) => setPageParam(current, "page", result.pagination.totalPages), { replace: true });
        return;
      }
      setSamples(result.samples);
      setPagination(result.pagination);
      setError("");
    }).catch((error: Error) => {
      if (error.name !== "AbortError") setError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [requestedPage, requestedQuery, setSearchParams]);

  function changePage(page: number) {
    setSearchParams(setPageParam(searchParams, "page", page));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return <div className="page samples-page">
    <div className="page-heading">
      <div><p className="eyebrow">Permanent archive</p><h1>Samples</h1><p className="lead">Browse sample identity, location, processing state, and complete history.</p></div>
      <div className="header-actions"><Link className="button primary" to="/samples/new">New sample</Link></div>
    </div>
    <label className="search-box">
      <span>Search</span>
      <input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search samples…" />
    </label>
    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading…</p> : samples.length ? <div className="sample-directory">
      <div className="sample-directory-head" aria-hidden="true"><span>Sample</span><span>Status / location</span><span>Latest process run</span><span>Updated</span></div>
      {samples.map((sample) => <Link to={`/samples/${sample.id}`} className="sample-directory-row" key={sample.id}>
        <div className="sample-directory-identity"><div className="sample-identity"><span className="sample-code">{sample.code}</span>{sample.pinned && <span className="sample-pinned">Pinned</span>}</div><strong>{sample.title}</strong>{sample.parentId && <small>Child sample</small>}</div>
        <div className="sample-directory-state"><StatusPill status={sample.status} /><span>{sample.location || "No location"}</span></div>
        <div className="sample-directory-workflow"><strong>{sample.latestWorkflowName || "—"}{sample.latestWorkflowVersion != null ? ` · v${sample.latestWorkflowVersion}` : ""}</strong><small>{workflowStateText(sample)}</small></div>
        <time>{new Date(sample.updatedAt).toLocaleDateString()}</time>
      </Link>)}
    </div> : <EmptyState title={query ? "No matching samples" : "No samples yet"}>
      {query ? "Try another code, name, process template, or location." : "Create the first sample to start its event log."}
    </EmptyState>}
    <PaginationControls pagination={pagination} label="Sample pages" disabled={loading} onPageChange={changePage} />
  </div>;
}
