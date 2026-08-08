import { useEffect, useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type {
  ReferenceSearchResult,
  SearchReferencesResponse,
} from "../../shared/reference-search";
import {
  REFERENCE_TARGET_TYPES,
  type ReferenceTarget,
  type ReferenceTargetType,
} from "../../shared/reference-types";
import { searchReferences } from "../lib/reference-api";
import {
  REFERENCE_SEARCH_MATCH_LABELS,
  REFERENCE_SEARCH_TYPE_LABELS,
  activeReferenceSearchFilterCount,
  defaultReferenceSearchUiState,
  normalizeReferenceSearchUiState,
  orderedReferenceSearchTypes,
  referenceSearchInputFromState,
  referenceSearchUiStateEquals,
  referenceTargetEquals,
  validateReferenceSearchUiState,
  type ReferenceSearchUiState,
} from "../lib/reference-search-ui";
import { EmptyState } from "./EmptyState";

type ReferenceSearchSurfaceCommonProps = {
  value: ReferenceSearchUiState;
  onChange: (next: ReferenceSearchUiState) => void;
  autoFocus?: boolean;
};

type ReferenceSearchSurfaceBrowseProps = ReferenceSearchSurfaceCommonProps & {
  mode?: "browse";
  selectedTarget?: never;
  onSelect?: never;
};

type ReferenceSearchSurfaceSelectProps = ReferenceSearchSurfaceCommonProps & {
  mode: "select";
  selectedTarget?: ReferenceTarget | null;
  onSelect: (target: ReferenceTarget) => void;
};

export type ReferenceSearchSurfaceProps =
  | ReferenceSearchSurfaceBrowseProps
  | ReferenceSearchSurfaceSelectProps;

function copySearchState(state: ReferenceSearchUiState): ReferenceSearchUiState {
  return { ...state, types: [...state.types] };
}

function formatTimestamp(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function resultContext(result: ReferenceSearchResult) {
  const first = result.resolution.contexts[0];
  return first?.segments.map((segment) => segment.label) ?? [];
}

function ReferenceSearchResultCard({
  result,
  mode,
  selected,
  onSelect,
}: {
  result: ReferenceSearchResult;
  mode: "browse" | "select";
  selected: boolean;
  onSelect?: (target: ReferenceTarget) => void;
}) {
  const source = result.resolution.source;
  const context = resultContext(result);
  const additionalContexts = Math.max(0, result.resolution.contexts.length - 1);
  const matchedAt = formatTimestamp(result.match.matchedAt);

  return <article className={`card reference-search-result${selected ? " selected" : ""}`}>
    <div className="reference-search-result-heading">
      <div className="reference-search-result-copy">
        <div className="reference-search-result-badges">
          <span className="reference-search-type-badge">
            {REFERENCE_SEARCH_TYPE_LABELS[result.target.type]}
          </span>
          <span className="reference-search-match-badge">
            {REFERENCE_SEARCH_MATCH_LABELS[result.match.tier]}
          </span>
          {matchedAt && <time dateTime={result.match.matchedAt ?? undefined}>{matchedAt}</time>}
        </div>
        <h2>{source?.title || result.target.id}</h2>
        {source?.subtitle && <p className="reference-search-result-subtitle">{source.subtitle}</p>}
      </div>
      <div className="reference-search-result-actions">
        {mode === "select" && <button
          type="button"
          className={`button compact-button${selected ? " selected" : ""}`}
          aria-pressed={selected}
          onClick={() => onSelect?.(result.target)}
        >{selected ? "Selected" : "Select"}</button>}
        {result.resolution.destination.openSourceUrl && <Link
          className="button compact-button"
          to={result.resolution.destination.openSourceUrl}
        >Open source</Link>}
        <Link
          className="button compact-button"
          to={result.resolution.destination.referenceUrl}
        >Reference details</Link>
      </div>
    </div>

    {source?.excerpt && <p className="reference-search-result-excerpt">{source.excerpt}</p>}

    <div className="reference-search-result-footer">
      <code>{result.target.id}</code>
      {context.length > 0 && <p className="reference-search-context">
        <span>{context.map((segment, index) => <span key={`${index}:${segment}`}>
          {index > 0 && <span aria-hidden="true"> › </span>}
          {segment}
        </span>)}</span>
        {additionalContexts > 0 && <small>+{additionalContexts} {additionalContexts === 1 ? "context" : "contexts"}</small>}
      </p>}
    </div>
  </article>;
}

export function ReferenceSearchSurface(props: ReferenceSearchSurfaceProps) {
  const mode = props.mode ?? "browse";
  const filterPanelId = useId();
  const validationId = useId();
  const [draft, setDraft] = useState<ReferenceSearchUiState>(() => copySearchState(props.value));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [response, setResponse] = useState<SearchReferencesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [requestRevision, setRequestRevision] = useState(0);
  const typeKey = props.value.types.join("\u0000");

  useEffect(() => {
    setDraft(copySearchState(props.value));
    setValidationError("");
  }, [props.value.query, props.value.sampleId, props.value.from, props.value.to, typeKey]);

  useEffect(() => {
    const input = referenceSearchInputFromState(props.value);
    if (!input) {
      setResponse(null);
      setLoading(false);
      setError("");
      return;
    }

    const controller = new AbortController();
    setResponse(null);
    setLoading(true);
    setError("");
    searchReferences(input, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setResponse(result);
      })
      .catch((requestError: Error) => {
        if (!controller.signal.aborted && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [props.value.query, props.value.sampleId, props.value.from, props.value.to, typeKey, requestRevision]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = normalizeReferenceSearchUiState(draft);
    const nextError = validateReferenceSearchUiState(next);
    if (nextError) {
      setValidationError(nextError);
      return;
    }
    setValidationError("");
    setFiltersOpen(false);
    if (next.query && referenceSearchUiStateEquals(next, props.value)) {
      setRequestRevision((revision) => revision + 1);
    }
    props.onChange(next);
  }

  function clearSearch() {
    const next = normalizeReferenceSearchUiState({ ...props.value, query: "" });
    setDraft(copySearchState(next));
    setValidationError("");
    setFiltersOpen(false);
    props.onChange(next);
  }

  function toggleType(type: ReferenceTargetType) {
    setDraft((current) => {
      const selected = current.types.includes(type);
      if (selected && current.types.length === 1) return current;
      return {
        ...current,
        types: selected
          ? current.types.filter((candidate) => candidate !== type)
          : orderedReferenceSearchTypes([...current.types, type]),
      };
    });
  }

  function resetFilters() {
    const defaults = defaultReferenceSearchUiState();
    setDraft((current) => ({
      ...current,
      types: defaults.types,
      sampleId: "",
      from: "",
      to: "",
    }));
    setValidationError("");
  }

  const filterCount = activeReferenceSearchFilterCount(filtersOpen ? draft : props.value);
  const committedQuery = props.value.query.trim();
  const resultCount = response?.results.length ?? 0;
  const statusText = loading
    ? "Searching references…"
    : error
      ? "Search failed"
      : response
        ? `${resultCount} ${resultCount === 1 ? "result" : "results"}`
        : committedQuery
          ? "Search ready"
          : "Enter a query to search";

  return <section className="reference-search-surface">
    <form className="reference-search-form" role="search" onSubmit={submit} aria-describedby={validationError ? validationId : undefined}>
      <div className="reference-search-query-row">
        <label className="reference-search-query-field">
          <span>Search references</span>
          <input
            autoFocus={props.autoFocus}
            type="search"
            value={draft.query}
            onChange={(event) => setDraft((current) => ({ ...current, query: event.target.value }))}
            placeholder="Search samples, steps, comments, files, or recipes…"
          />
        </label>
        {draft.query && <button
          type="button"
          className="text-button reference-search-clear"
          aria-label="Clear search"
          onClick={clearSearch}
        >Clear</button>}
        <button type="submit" className="button primary reference-search-submit">Search</button>
      </div>

      <div className="reference-search-toolbar">
        <p aria-live="polite">{statusText}</p>
        <button
          type="button"
          className={`button compact-button reference-search-filter-trigger${filtersOpen ? " selected" : ""}`}
          aria-expanded={filtersOpen}
          aria-controls={filterPanelId}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          Filters
          {filterCount > 0 && <span className="reference-search-filter-count">{filterCount}</span>}
          <span aria-hidden="true">▾</span>
        </button>
      </div>

      {filtersOpen && <div id={filterPanelId} className="card reference-search-filter-panel">
        <fieldset className="reference-search-type-filter">
          <legend>Result types</legend>
          <p>Select one or more stable reference types.</p>
          <div className="reference-search-type-grid">
            {REFERENCE_TARGET_TYPES.map((type) => {
              const checked = draft.types.includes(type);
              return <label key={type}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={checked && draft.types.length === 1}
                  onChange={() => toggleType(type)}
                />
                <span>{REFERENCE_SEARCH_TYPE_LABELS[type]}</span>
              </label>;
            })}
          </div>
        </fieldset>

        <div className="reference-search-filter-grid">
          <label>
            <span>Sample stable ID</span>
            <input
              value={draft.sampleId}
              onChange={(event) => setDraft((current) => ({ ...current, sampleId: event.target.value }))}
              placeholder="Optional exact Sample ID"
            />
            <small>Scopes results to one exact Sample context.</small>
          </label>
          <label>
            <span>Updated from</span>
            <input
              type="date"
              value={draft.from}
              onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
            />
            <small>Inclusive date.</small>
          </label>
          <label>
            <span>Updated to</span>
            <input
              type="date"
              value={draft.to}
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
            />
            <small>Inclusive date.</small>
          </label>
        </div>

        <div className="reference-search-filter-actions">
          <button type="button" className="text-button" onClick={resetFilters}>Reset filters</button>
          <button type="submit" className="button primary compact-button">Apply and search</button>
        </div>
      </div>}

      {validationError && <p id={validationId} className="error-banner reference-search-validation">{validationError}</p>}
    </form>

    {error && <p className="error-banner reference-search-error">{error}</p>}
    {loading && <div className="reference-search-loading" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>}

    {!loading && !error && !committedQuery && <EmptyState title="Search the research record">
      Find stable references across Samples, Runs, Steps, Comments, attachments, execution images, metrology references, and Recipe revisions.
    </EmptyState>}

    {!loading && !error && response?.truncated && <p className="info-banner reference-search-truncated">
      More matches may exist. Narrow the query or filters to inspect a smaller deterministic result set.
    </p>}

    {!loading && !error && response && response.results.length === 0 && <EmptyState title="No matching references">
      Adjust the query or filters. Deleted sources and deleted required ancestors are intentionally excluded from new-reference discovery.
    </EmptyState>}

    {!loading && !error && response && response.results.length > 0 && <div className="reference-search-results">
      {response.results.map((result) => <ReferenceSearchResultCard
        key={`${result.target.type}:${result.target.id}`}
        result={result}
        mode={mode}
        selected={mode === "select" && referenceTargetEquals(props.selectedTarget, result.target)}
        onSelect={mode === "select" ? props.onSelect : undefined}
      />)}
    </div>}
  </section>;
}
