import { useEffect, useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { ListReferenceChildrenResponse } from "../../shared/reference-children";
import type {
  ReferenceSearchResult,
  SearchReferencesResponse,
} from "../../shared/reference-search";
import {
  REFERENCE_TARGET_TYPES,
  type ReferenceResolution,
  type ReferenceTarget,
  type ReferenceTargetType,
} from "../../shared/reference-types";
import { listReferenceChildren, searchReferences } from "../lib/reference-api";
import {
  writeProjectReferenceResolutionDragPayload,
} from "../lib/project-reference-placement";
import {
  projectReferenceTargetKey,
  type ProjectReferenceSuggestionSeed,
} from "../lib/project-reference-suggestions";
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
  placementDisabled?: never;
  onPlaceAtCenter?: never;
};

type ReferenceSearchSurfaceSelectProps = ReferenceSearchSurfaceCommonProps & {
  mode: "select";
  selectedTarget?: ReferenceTarget | null;
  onSelect: (target: ReferenceTarget) => void;
  placementDisabled?: never;
  onPlaceAtCenter?: never;
};

type ReferenceSearchSurfacePlaceProps = ReferenceSearchSurfaceCommonProps & {
  mode: "place";
  selectedTarget?: never;
  onSelect?: never;
  placementDisabled?: boolean;
  onPlaceAtCenter: (result: ReferenceSearchResult) => void;
  suggestionSeeds?: readonly ProjectReferenceSuggestionSeed[];
  placedTargetCounts?: Readonly<Record<string, number>>;
  onPlaceResolutionAtCenter?: (resolution: ReferenceResolution) => void;
};

export type ReferenceSearchSurfaceProps =
  | ReferenceSearchSurfaceBrowseProps
  | ReferenceSearchSurfaceSelectProps
  | ReferenceSearchSurfacePlaceProps;

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

const PROJECT_REFERENCE_SEARCH_SCOPES: ReadonlyArray<{
  id: string;
  label: string;
  types: readonly ReferenceTargetType[];
}> = [{
  id: "all",
  label: "All",
  types: REFERENCE_TARGET_TYPES,
}, {
  id: "samples",
  label: "Samples",
  types: ["sample"],
}, {
  id: "process",
  label: "Process",
  types: ["run", "run_step"],
}, {
  id: "comments",
  label: "Comments",
  types: ["comment", "comment_occurrence"],
}, {
  id: "files",
  label: "Files & data",
  types: ["comment_attachment", "execution_image", "metrology_reference"],
}, {
  id: "recipes",
  label: "Recipes",
  types: ["recipe_revision"],
}];

type ReferenceSuggestion = {
  seed: ProjectReferenceSuggestionSeed;
  resolution: ReferenceResolution;
};

type ReferenceSuggestionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; suggestions: ReferenceSuggestion[]; failedSeeds: number };

function sameTypes(left: readonly ReferenceTargetType[], right: readonly ReferenceTargetType[]) {
  return left.length === right.length && left.every((type, index) => type === right[index]);
}

function resolutionContext(resolution: ReferenceResolution) {
  const first = resolution.contexts[0];
  return first?.segments.map((segment) => segment.label) ?? [];
}

function ReferencePlacementCard({
  resolution,
  supportingLabel,
  placedCount = 0,
  nested = false,
  placementDisabled,
  onPlace,
}: {
  resolution: ReferenceResolution;
  supportingLabel: string;
  placedCount?: number;
  nested?: boolean;
  placementDisabled?: boolean;
  onPlace: () => void;
}) {
  const title = resolution.source?.title || resolution.target.id;
  const context = resolutionContext(resolution);
  const openUrl = resolution.destination.openSourceUrl
    ?? resolution.destination.referenceUrl;
  const Heading = nested ? "h3" : "h2";

  return <article className="reference-placement-card">
    <div className="reference-placement-card-main">
      <span
        className={`reference-search-drag-handle${placementDisabled ? " disabled" : ""}`}
        draggable={!placementDisabled}
        title={placementDisabled ? "Finish the current reference placement first" : "Drag reference to Map"}
        onDragStart={(event) => {
          if (placementDisabled) {
            event.preventDefault();
            return;
          }
          writeProjectReferenceResolutionDragPayload(event.dataTransfer, resolution);
        }}
        aria-hidden="true"
      >⠿</span>
      <div className="reference-placement-card-copy">
        <div className="reference-placement-card-labels">
          <span className="reference-search-type-badge">
            {REFERENCE_SEARCH_TYPE_LABELS[resolution.target.type]}
          </span>
          <span>{supportingLabel}</span>
          {placedCount > 0 && <span className="reference-placement-card-present">
            {placedCount === 1 ? "On Map" : `${placedCount} on Map`}
          </span>}
        </div>
        <Heading>{title}</Heading>
        {resolution.source?.subtitle && <p>{resolution.source.subtitle}</p>}
      </div>
      <button
        type="button"
        className="button primary compact-button reference-placement-action"
        disabled={placementDisabled}
        aria-label={`Place ${title} at Map center`}
        onClick={onPlace}
      >Place</button>
    </div>
    {resolution.source?.excerpt && <p className="reference-placement-card-excerpt">
      {resolution.source.excerpt}
    </p>}
    <div className="reference-placement-card-footer">
      {context.length > 0 && <p>{context.join(" › ")}</p>}
      <div>
        <Link to={openUrl}>Open</Link>
        {openUrl !== resolution.destination.referenceUrl && <Link
          to={resolution.destination.referenceUrl}
        >Details</Link>}
      </div>
    </div>
  </article>;
}

function ReferenceSearchResultCard({
  result,
  mode,
  selected,
  onSelect,
  placedCount,
  placementDisabled,
  onPlaceAtCenter,
}: {
  result: ReferenceSearchResult;
  mode: "browse" | "select" | "place";
  selected: boolean;
  onSelect?: (target: ReferenceTarget) => void;
  placedCount?: number;
  placementDisabled?: boolean;
  onPlaceAtCenter?: (result: ReferenceSearchResult) => void;
}) {
  const source = result.resolution.source;
  const context = resultContext(result);
  const additionalContexts = Math.max(0, result.resolution.contexts.length - 1);
  const matchedAt = formatTimestamp(result.match.matchedAt);

  if (mode === "place") {
    return <ReferencePlacementCard
      resolution={result.resolution}
      supportingLabel={REFERENCE_SEARCH_MATCH_LABELS[result.match.tier]}
      placedCount={placedCount}
      placementDisabled={placementDisabled}
      onPlace={() => onPlaceAtCenter?.(result)}
    />;
  }

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
  const suggestionHeadingId = useId();
  const [draft, setDraft] = useState<ReferenceSearchUiState>(() => copySearchState(props.value));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [response, setResponse] = useState<SearchReferencesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [requestRevision, setRequestRevision] = useState(0);
  const [suggestionRevision, setSuggestionRevision] = useState(0);
  const [suggestionState, setSuggestionState] = useState<ReferenceSuggestionState>({
    status: "idle",
  });
  const typeKey = props.value.types.join("\u0000");
  const committedQuery = props.value.query.trim();
  const placementProps = props.mode === "place" ? props : null;
  const suggestionSeeds = placementProps?.suggestionSeeds ?? [];
  const suggestionKey = JSON.stringify(suggestionSeeds.map((seed) => ({
    type: seed.target.type,
    id: seed.target.id,
    title: seed.title,
    origin: seed.origin,
  })));

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

  useEffect(() => {
    if (mode !== "place" || committedQuery || suggestionSeeds.length === 0) {
      setSuggestionState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    const seeds = [...suggestionSeeds];
    setSuggestionState({ status: "loading" });
    void Promise.all(seeds.map(async (seed): Promise<{
      seed: ProjectReferenceSuggestionSeed;
      response: ListReferenceChildrenResponse | null;
      error: string | null;
    }> => {
      try {
        const childResponse = await listReferenceChildren({
          parent: seed.target,
          limit: 12,
        }, controller.signal);
        return { seed, response: childResponse, error: null };
      } catch (caught: unknown) {
        if (controller.signal.aborted) return { seed, response: null, error: null };
        return {
          seed,
          response: null,
          error: caught instanceof Error
            ? caught.message
            : "Related references could not be loaded",
        };
      }
    })).then((groups) => {
      if (controller.signal.aborted) return;
      const suggestions: ReferenceSuggestion[] = [];
      const seen = new Set<string>();
      let failedSeeds = 0;
      let firstError = "";
      for (const group of groups) {
        if (group.error) {
          failedSeeds += 1;
          if (!firstError) firstError = group.error;
          continue;
        }
        for (const resolution of group.response?.children ?? []) {
          const key = projectReferenceTargetKey(resolution.target);
          if (seen.has(key)) continue;
          seen.add(key);
          suggestions.push({ seed: group.seed, resolution });
          if (suggestions.length === 18) break;
        }
        if (suggestions.length === 18) break;
      }
      if (failedSeeds === groups.length) {
        setSuggestionState({
          status: "error",
          message: firstError || "Related references could not be loaded",
        });
        return;
      }
      setSuggestionState({ status: "ready", suggestions, failedSeeds });
    });
    return () => controller.abort();
  }, [committedQuery, mode, suggestionKey, suggestionRevision]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeReferenceSearchUiState(draft);
    const next = mode === "place" && !normalized.query
      ? normalizeReferenceSearchUiState({ ...normalized, sampleId: "", from: "", to: "" })
      : normalized;
    const nextError = validateReferenceSearchUiState(next);
    if (nextError) {
      setValidationError(nextError);
      return;
    }
    setValidationError("");
    setFiltersOpen(false);
    if (referenceSearchUiStateEquals(next, props.value)) {
      if (next.query) setRequestRevision((revision) => revision + 1);
      return;
    }
    props.onChange(next);
  }

  function clearSearch() {
    const next = normalizeReferenceSearchUiState({
      ...props.value,
      query: "",
      ...(mode === "place" ? { sampleId: "", from: "", to: "" } : {}),
    });
    setDraft(copySearchState(next));
    setValidationError("");
    setFiltersOpen(false);
    if (!referenceSearchUiStateEquals(next, props.value)) {
      props.onChange(next);
    }
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

  function applyQuickScope(types: readonly ReferenceTargetType[]) {
    const next = normalizeReferenceSearchUiState({ ...draft, types: [...types] });
    setDraft(copySearchState(next));
    setValidationError("");
    if (referenceSearchUiStateEquals(next, props.value)) {
      if (next.query) setRequestRevision((revision) => revision + 1);
      return;
    }
    props.onChange(next);
  }

  function resetFilters() {
    const defaults = defaultReferenceSearchUiState();
    setDraft((current) => ({
      ...current,
      types: mode === "place" ? current.types : defaults.types,
      sampleId: "",
      from: "",
      to: "",
    }));
    setValidationError("");
  }

  const displayedFilterState = filtersOpen ? draft : props.value;
  const filterCount = mode === "place"
    ? Number(Boolean(displayedFilterState.sampleId))
      + Number(Boolean(displayedFilterState.from))
      + Number(Boolean(displayedFilterState.to))
    : activeReferenceSearchFilterCount(displayedFilterState);
  const resultCount = response?.results.length ?? 0;
  const visibleSuggestions = suggestionState.status === "ready"
    ? suggestionState.suggestions.filter((suggestion) => (
      props.value.types.includes(suggestion.resolution.target.type)
    ))
    : [];
  const statusText = loading
    ? "Searching references…"
    : error
      ? "Search failed"
      : response
        ? `${resultCount} ${resultCount === 1 ? "result" : "results"}`
        : committedQuery
          ? "Search ready"
          : mode === "place"
            ? suggestionState.status === "loading"
              ? "Finding related records…"
              : suggestionState.status === "ready"
                ? `${visibleSuggestions.length} suggested`
                : suggestionState.status === "error"
                  ? "Suggestions unavailable"
                  : "Browse or search references"
            : "Enter a query to search";
  const showAdvancedFilterTrigger = mode !== "place"
    || Boolean(draft.query.trim())
    || Boolean(committedQuery)
    || filterCount > 0
    || filtersOpen;

  return <section className={`reference-search-surface${mode === "place" ? " placement" : ""}`}>
    <form className="reference-search-form" role="search" onSubmit={submit} aria-describedby={validationError ? validationId : undefined}>
      <div className="reference-search-query-row">
        <label className="reference-search-query-field">
          <span className={mode === "place" ? "visually-hidden" : undefined}>Search references</span>
          <input
            autoFocus={props.autoFocus}
            type="search"
            value={draft.query}
            onChange={(event) => setDraft((current) => ({ ...current, query: event.target.value }))}
            placeholder={mode === "place"
              ? "Search records…"
              : "Search samples, steps, comments, files, or recipes…"}
          />
        </label>
        {draft.query && <button
          type="button"
          className="text-button reference-search-clear"
          aria-label="Clear search"
          onClick={clearSearch}
        >Clear</button>}
        <button
          type="submit"
          className={`button primary reference-search-submit${mode === "place" ? " compact-button" : ""}`}
        >Search</button>
      </div>

      {mode === "place" && <div
        className="reference-search-scopes"
        role="group"
        aria-label="Reference type"
      >
        {PROJECT_REFERENCE_SEARCH_SCOPES.map((scope) => {
          const selected = sameTypes(draft.types, scope.types);
          return <button
            key={scope.id}
            type="button"
            aria-pressed={selected}
            className={selected ? "selected" : ""}
            onClick={() => applyQuickScope(scope.types)}
          >{scope.label}</button>;
        })}
      </div>}

      <div className="reference-search-toolbar">
        <p aria-live="polite">{statusText}</p>
        {showAdvancedFilterTrigger && <button
          type="button"
          className={`button compact-button reference-search-filter-trigger${filtersOpen ? " selected" : ""}`}
          aria-expanded={filtersOpen}
          aria-controls={filterPanelId}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          {mode === "place" ? "More filters" : "Filters"}
          {filterCount > 0 && <span className="reference-search-filter-count">{filterCount}</span>}
          <span aria-hidden="true">▾</span>
        </button>}
      </div>

      {filtersOpen && <div
        id={filterPanelId}
        className={`card reference-search-filter-panel${mode === "place" ? " compact" : ""}`}
      >
        {mode !== "place" && <fieldset className="reference-search-type-filter">
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
        </fieldset>}

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
          <button type="submit" className="button primary compact-button">Apply</button>
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

    {mode === "place" && !committedQuery && <section
      className="reference-suggestions"
      aria-labelledby={suggestionHeadingId}
    >
      <div className="reference-suggestions-heading">
        <div>
          <h2 id={suggestionHeadingId}>Suggested references</h2>
          <p>Related records from the current selection and this Project.</p>
        </div>
        {visibleSuggestions.length > 0 && <span>{visibleSuggestions.length}</span>}
      </div>
      {suggestionSeeds.length === 0 && <p className="reference-suggestion-empty">
        Search the research record to add the first reference. Once the Project contains a Sample, Run, Step, Comment, or Recipe, related records appear here automatically.
      </p>}
      {suggestionState.status === "loading" && <div
        className="reference-suggestion-loading"
        aria-label="Loading suggested references"
        role="status"
      ><span /><span /></div>}
      {suggestionState.status === "error" && <div className="reference-suggestion-message error">
        <p>{suggestionState.message}</p>
        <button
          type="button"
          className="button compact-button"
          onClick={() => setSuggestionRevision((revision) => revision + 1)}
        >Retry suggestions</button>
      </div>}
      {suggestionState.status === "ready" && suggestionState.failedSeeds > 0 && <div
        className="reference-suggestion-message warning"
      >
        <p>Some related records could not be loaded.</p>
        <button
          type="button"
          className="text-button"
          onClick={() => setSuggestionRevision((revision) => revision + 1)}
        >Retry</button>
      </div>}
      {suggestionState.status === "ready" && visibleSuggestions.length === 0 && <p
        className="reference-suggestion-empty"
      >
        {suggestionState.suggestions.length > 0
          ? "No suggested records match this type. Choose another type or search."
          : "No direct related records are available. Search the research record for another reference."}
      </p>}
      {visibleSuggestions.length > 0 && <div className="reference-suggestion-results">
        {visibleSuggestions.map(({ seed, resolution }) => <ReferencePlacementCard
          key={projectReferenceTargetKey(resolution.target)}
          resolution={resolution}
          supportingLabel={seed.origin === "selection"
            ? `Selected · ${seed.title}`
            : `From ${seed.title}`}
          placedCount={placementProps?.placedTargetCounts?.[
            projectReferenceTargetKey(resolution.target)
          ] ?? 0}
          nested
          placementDisabled={placementProps?.placementDisabled}
          onPlace={() => placementProps?.onPlaceResolutionAtCenter?.(resolution)}
        />)}
      </div>}
    </section>}

    {mode !== "place" && !loading && !error && !committedQuery && <EmptyState title="Search the research record">
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
        placedCount={mode === "place" ? placementProps?.placedTargetCounts?.[
          projectReferenceTargetKey(result.target)
        ] ?? 0 : undefined}
        placementDisabled={mode === "place" ? props.placementDisabled : undefined}
        onPlaceAtCenter={mode === "place" ? props.onPlaceAtCenter : undefined}
      />)}
    </div>}
  </section>;
}
