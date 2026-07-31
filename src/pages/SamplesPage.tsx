import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  SAMPLE_STATUSES,
  SAMPLE_STATUS_LABELS,
  type PaginationMeta,
  type SampleDirectoryFilterOptions,
  type SampleDirectorySort,
  type SampleStatus,
  type SampleSummary,
} from "../../shared/types";
import { EmptyState } from "../components/EmptyState";
import { PaginationControls } from "../components/PaginationControls";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";
import { shouldAutoFocusPageField } from "../lib/page-load-autofocus";
import { pageFromSearchParam, setPageParam } from "../lib/pagination";
import {
  activeSampleDirectorySettingCount,
  applySampleDirectorySettings,
  clearAllSampleDirectorySettings,
  clearSampleDirectorySetting,
  defaultSampleDirectorySort,
  hasExplicitSampleDirectorySort,
  SAMPLE_DIRECTORY_SORT_OPTIONS,
  sampleDirectorySettings,
  type SampleDirectorySettings,
} from "../lib/sample-directory";

const EMPTY_PAGINATION: PaginationMeta = { page: 1, pageSize: 50, total: 0, totalPages: 1 };
const EMPTY_FILTER_OPTIONS: SampleDirectoryFilterOptions = { locations: [], parents: [], workflows: [] };

function workflowStateText(sample: SampleSummary) {
  if (!sample.latestWorkflowName) return "No process run yet";
  if (sample.latestRunStatus === "active") return sample.currentStepTitle ? `Current step · ${sample.currentStepTitle}` : "Active process run";
  if (sample.latestRunStatus === "complete") return "Process run completed";
  if (sample.latestRunStatus === "cancelled") return "Latest process run cancelled";
  return "Latest process run superseded";
}

function sortLabel(sort: SampleDirectorySort) {
  return SAMPLE_DIRECTORY_SORT_OPTIONS.find((option) => option.value === sort)?.label ?? sort;
}

export function SamplesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedQuery = searchParams.get("q") ?? "";
  const requestedPage = pageFromSearchParam(searchParams.get("page"));
  const settings = sampleDirectorySettings(searchParams);
  const explicitSort = hasExplicitSampleDirectorySort(searchParams);
  const activeSettingCount = activeSampleDirectorySettingCount(searchParams);
  const hasFilters = Boolean(settings.status || settings.location || settings.parent || settings.workflow);
  const [samples, setSamples] = useState<SampleSummary[]>([]);
  const [query, setQuery] = useState(requestedQuery);
  const [pagination, setPagination] = useState<PaginationMeta>(EMPTY_PAGINATION);
  const [filterOptions, setFilterOptions] = useState<SampleDirectoryFilterOptions>(EMPTY_FILTER_OPTIONS);
  const [filterOptionsError, setFilterOptionsError] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draft, setDraft] = useState<SampleDirectorySettings>(settings);
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
    api.listSampleDirectoryOptions(controller.signal).then((result) => {
      setFilterOptions(result);
      setFilterOptionsError(false);
    }).catch((error: Error) => {
      if (error.name !== "AbortError") setFilterOptionsError(true);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.listSamples({
      query: requestedQuery,
      page: requestedPage,
      pageSize: 50,
      sampleStatus: settings.status || undefined,
      location: settings.location,
      parent: settings.parent,
      workflow: settings.workflow,
      sort: settings.sort,
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
  }, [
    requestedPage,
    requestedQuery,
    setSearchParams,
    settings.location,
    settings.parent,
    settings.sort,
    settings.status,
    settings.workflow,
  ]);

  function changePage(page: number) {
    setSearchParams(setPageParam(searchParams, "page", page));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleFilters() {
    if (!filtersOpen) setDraft(settings);
    setFiltersOpen((open) => !open);
  }

  function applyFilters() {
    setSearchParams(applySampleDirectorySettings(searchParams, draft), { replace: true });
    setFiltersOpen(false);
  }

  function removeSetting(key: "status" | "location" | "parent" | "process" | "sort") {
    setSearchParams(clearSampleDirectorySetting(searchParams, key), { replace: true });
    setFiltersOpen(false);
  }

  function clearSettings() {
    setSearchParams(clearAllSampleDirectorySettings(searchParams), { replace: true });
    setFiltersOpen(false);
  }

  function resetDraft() {
    setDraft({
      status: "",
      location: "",
      parent: "",
      workflow: "",
      sort: defaultSampleDirectorySort(Boolean(requestedQuery.trim())),
    });
  }

  const activeChips: Array<{ key: "status" | "location" | "parent" | "process" | "sort"; label: string }> = [];
  if (settings.status) activeChips.push({ key: "status", label: `Status · ${SAMPLE_STATUS_LABELS[settings.status]}` });
  if (settings.location) activeChips.push({ key: "location", label: `Location · ${settings.location}` });
  if (settings.parent) activeChips.push({ key: "parent", label: `Parent · ${settings.parent}` });
  if (settings.workflow) activeChips.push({ key: "process", label: `Process · ${settings.workflow}` });
  if (explicitSort) activeChips.push({ key: "sort", label: sortLabel(settings.sort) });

  return <div className="page samples-page">
    <div className="page-heading">
      <div><p className="eyebrow">Permanent archive</p><h1>Samples</h1><p className="lead">Browse sample identity, location, processing state, and complete history.</p></div>
      <div className="header-actions"><Link className="button primary" to="/samples/new">New sample</Link></div>
    </div>
    <label className="search-box sample-directory-search">
      <span>Search</span>
      <input autoFocus={shouldAutoFocusPageField()} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search samples…" />
    </label>
    <div className="sample-directory-toolbar">
      <p>{loading ? "Loading samples…" : <><strong>{pagination.total}</strong> {pagination.total === 1 ? "sample" : "samples"}</>}</p>
      <button
        type="button"
        className={`button compact-button sample-filter-trigger${filtersOpen ? " selected" : ""}`}
        aria-expanded={filtersOpen}
        aria-controls="sample-filter-panel"
        onClick={toggleFilters}
      >
        Filter &amp; sort
        {activeSettingCount > 0 && <span className="sample-filter-count">{activeSettingCount}</span>}
        <span aria-hidden="true">▾</span>
      </button>
    </div>
    {filtersOpen && <form id="sample-filter-panel" className="card sample-filter-panel" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
      <section>
        <div className="sample-filter-section-heading">
          <p className="card-label">Filter</p>
          <p className="card-meta">Narrow the current search without changing how matching works.</p>
        </div>
        <div className="sample-filter-grid">
          <label className="sample-filter-field">
            <span>Status</span>
            <select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as SampleStatus | "" }))}>
              <option value="">Any status</option>
              {SAMPLE_STATUSES.map((status) => <option value={status} key={status}>{SAMPLE_STATUS_LABELS[status]}</option>)}
            </select>
          </label>
          <label className="sample-filter-field">
            <span>Location</span>
            <input list="sample-location-options" value={draft.location} onChange={(event) => setDraft((current) => ({ ...current, location: event.target.value }))} placeholder="Any location" />
            <datalist id="sample-location-options">{filterOptions.locations.map((location) => <option value={location} key={location} />)}</datalist>
          </label>
          <label className="sample-filter-field">
            <span>Parent</span>
            <input list="sample-parent-options" value={draft.parent} onChange={(event) => setDraft((current) => ({ ...current, parent: event.target.value }))} placeholder="Any parent sample" />
            <datalist id="sample-parent-options">{filterOptions.parents.map((parent) => <option value={parent.code} key={parent.id}>{parent.title}</option>)}</datalist>
          </label>
          <label className="sample-filter-field">
            <span>Latest process</span>
            <input list="sample-process-options" value={draft.workflow} onChange={(event) => setDraft((current) => ({ ...current, workflow: event.target.value }))} placeholder="Any process" />
            <datalist id="sample-process-options">{filterOptions.workflows.map((workflow) => <option value={workflow} key={workflow} />)}</datalist>
          </label>
        </div>
        {filterOptionsError && <p className="sample-filter-options-error">Suggestions are unavailable, but typed filters still work.</p>}
      </section>
      <section>
        <div className="sample-filter-section-heading">
          <p className="card-label">Sort</p>
          <p className="card-meta">Choose which matching samples should appear first.</p>
        </div>
        <label className="sample-filter-field sample-sort-field">
          <span>Sort by</span>
          <select value={draft.sort} onChange={(event) => setDraft((current) => ({ ...current, sort: event.target.value as SampleDirectorySort }))}>
            {SAMPLE_DIRECTORY_SORT_OPTIONS.filter((option) => requestedQuery.trim() || option.value !== "relevance").map((option) =>
              <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
      </section>
      <div className="sample-filter-actions">
        <button type="button" className="text-button" onClick={resetDraft}>Reset</button>
        <button type="submit" className="button primary compact-button">Apply</button>
      </div>
    </form>}
    {activeChips.length > 0 && <div className="sample-filter-summary" aria-label="Active sample filters and sorting">
      <div>{activeChips.map((chip) => <button type="button" key={chip.key} onClick={() => removeSetting(chip.key)} aria-label={`Remove ${chip.label}`}>{chip.label}<span aria-hidden="true">×</span></button>)}</div>
      <button type="button" className="text-button" onClick={clearSettings}>Clear all</button>
    </div>}
    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading…</p> : samples.length ? <div className="sample-directory">
      <div className="sample-directory-head" aria-hidden="true"><span>Sample</span><span>Status / location</span><span>Latest process run</span><span>Updated</span></div>
      {samples.map((sample) => <Link to={`/samples/${sample.id}`} className="sample-directory-row" key={sample.id}>
        <div className="sample-directory-identity"><div className="sample-identity"><span className="sample-code">{sample.code}</span>{sample.pinned && <span className="sample-pinned">Pinned</span>}</div><strong>{sample.title}</strong>{sample.parentId && <small>Child sample</small>}</div>
        <div className="sample-directory-state"><StatusPill status={sample.status} /><span>{sample.location || "No location"}</span></div>
        <div className="sample-directory-workflow"><strong>{sample.latestWorkflowName || "—"}{sample.latestWorkflowVersion != null ? ` · v${sample.latestWorkflowVersion}` : ""}</strong><small>{workflowStateText(sample)}</small></div>
        <time>{new Date(sample.updatedAt).toLocaleDateString()}</time>
      </Link>)}
    </div> : <EmptyState title={requestedQuery || hasFilters ? "No matching samples" : "No samples yet"}>
      {requestedQuery || hasFilters ? "Adjust the search or remove a filter to see more samples." : "Create the first sample to start its event log."}
    </EmptyState>}
    <PaginationControls pagination={pagination} label="Sample pages" disabled={loading} onPageChange={changePage} />
  </div>;
}
