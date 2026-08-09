import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { ReferenceSearchSurface } from "../components/ReferenceSearchSurface";
import { shouldAutoFocusPageField } from "../lib/page-load-autofocus";
import {
  referenceSearchParamsFromState,
  referenceSearchStateFromParams,
  type ReferenceSearchUiState,
} from "../lib/reference-search-ui";

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const serializedParams = searchParams.toString();
  const value = useMemo(
    () => referenceSearchStateFromParams(new URLSearchParams(serializedParams)),
    [serializedParams],
  );

  function commitSearch(next: ReferenceSearchUiState) {
    setSearchParams(referenceSearchParamsFromState(next));
  }

  return <div className="page reference-search-page">
    <div className="page-heading">
      <div>
        <p className="eyebrow">Research index</p>
        <h1>Search</h1>
        <p className="lead">Find stable references across samples, process history, comments, files, and exact recipe revisions.</p>
      </div>
    </div>
    <ReferenceSearchSurface
      value={value}
      onChange={commitSearch}
      autoFocus={shouldAutoFocusPageField()}
    />
  </div>;
}
