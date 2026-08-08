import {
  MAX_REFERENCE_SEARCH_QUERY_LENGTH,
  type ReferenceSearchMatchTier,
  type SearchReferencesInput,
} from "../../shared/reference-search";
import {
  MAX_REFERENCE_TARGET_ID_LENGTH,
  REFERENCE_TARGET_TYPES,
  isReferenceTargetType,
  type ReferenceTarget,
  type ReferenceTargetType,
} from "../../shared/reference-types";

export const REFERENCE_SEARCH_TYPE_LABELS = {
  sample: "Sample",
  run: "Run",
  run_step: "Run Step",
  comment: "Comment",
  comment_occurrence: "Comment occurrence",
  comment_attachment: "Comment attachment",
  execution_image: "Execution image",
  metrology_reference: "Metrology reference",
  recipe_revision: "Recipe revision",
} as const satisfies Record<ReferenceTargetType, string>;

export const REFERENCE_SEARCH_MATCH_LABELS = {
  exact_id: "Exact ID",
  exact_primary: "Exact title or filename",
  prefix_primary: "Title or filename prefix",
  content: "Content match",
  metadata: "Context match",
} as const satisfies Record<ReferenceSearchMatchTier, string>;

export interface ReferenceSearchUiState {
  query: string;
  types: ReferenceTargetType[];
  sampleId: string;
  from: string;
  to: string;
}

export function defaultReferenceSearchUiState(): ReferenceSearchUiState {
  return {
    query: "",
    types: [...REFERENCE_TARGET_TYPES],
    sampleId: "",
    from: "",
    to: "",
  };
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidReferenceSearchDate(value: string) {
  if (!value) return true;
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function orderedReferenceSearchTypes(values: readonly unknown[]) {
  const selected = new Set<ReferenceTargetType>();
  for (const value of values) {
    if (isReferenceTargetType(value)) selected.add(value);
  }
  return REFERENCE_TARGET_TYPES.filter((type) => selected.has(type));
}

function dateFromParam(value: string | null) {
  return value && isValidReferenceSearchDate(value) ? value : "";
}

export function referenceSearchStateFromParams(params: URLSearchParams): ReferenceSearchUiState {
  const requestedTypes = params.getAll("type");
  const validTypes = orderedReferenceSearchTypes(requestedTypes);
  return {
    query: params.get("q") ?? "",
    types: requestedTypes.length > 0 && validTypes.length > 0
      ? validTypes
      : [...REFERENCE_TARGET_TYPES],
    sampleId: params.get("sample")?.trim() ?? "",
    from: dateFromParam(params.get("from")),
    to: dateFromParam(params.get("to")),
  };
}

export function normalizeReferenceSearchUiState(
  state: ReferenceSearchUiState,
): ReferenceSearchUiState {
  const types = orderedReferenceSearchTypes(state.types);
  return {
    query: state.query.trim(),
    types: types.length ? types : [],
    sampleId: state.sampleId.trim(),
    from: state.from.trim(),
    to: state.to.trim(),
  };
}

export function validateReferenceSearchUiState(state: ReferenceSearchUiState) {
  const normalized = normalizeReferenceSearchUiState(state);
  if (Array.from(normalized.query).length > MAX_REFERENCE_SEARCH_QUERY_LENGTH) {
    return `Search queries must be ${MAX_REFERENCE_SEARCH_QUERY_LENGTH} characters or fewer.`;
  }
  if (!normalized.types.length) return "Select at least one result type.";
  if (normalized.sampleId.length > MAX_REFERENCE_TARGET_ID_LENGTH) {
    return `Sample IDs must be ${MAX_REFERENCE_TARGET_ID_LENGTH} characters or fewer.`;
  }
  if (!isValidReferenceSearchDate(normalized.from)
    || !isValidReferenceSearchDate(normalized.to)) {
    return "Use valid calendar dates in YYYY-MM-DD format.";
  }
  if (normalized.from && normalized.to && normalized.from > normalized.to) {
    return "The start date must be on or before the end date.";
  }
  return null;
}

export function referenceSearchParamsFromState(state: ReferenceSearchUiState) {
  const normalized = normalizeReferenceSearchUiState(state);
  const params = new URLSearchParams();
  if (normalized.query) params.set("q", normalized.query);
  if (normalized.types.length !== REFERENCE_TARGET_TYPES.length) {
    for (const type of normalized.types) params.append("type", type);
  }
  if (normalized.sampleId) params.set("sample", normalized.sampleId);
  if (normalized.from) params.set("from", normalized.from);
  if (normalized.to) params.set("to", normalized.to);
  return params;
}

export function referenceSearchInputFromState(
  state: ReferenceSearchUiState,
): SearchReferencesInput | null {
  const normalized = normalizeReferenceSearchUiState(state);
  if (!normalized.query) return null;
  return {
    query: normalized.query,
    ...(normalized.types.length === REFERENCE_TARGET_TYPES.length
      ? {}
      : { types: normalized.types }),
    ...(normalized.sampleId ? { sampleId: normalized.sampleId } : {}),
    ...(normalized.from ? { from: normalized.from } : {}),
    ...(normalized.to ? { to: normalized.to } : {}),
  };
}

export function activeReferenceSearchFilterCount(state: ReferenceSearchUiState) {
  const normalized = normalizeReferenceSearchUiState(state);
  return Number(normalized.types.length !== REFERENCE_TARGET_TYPES.length)
    + Number(Boolean(normalized.sampleId))
    + Number(Boolean(normalized.from))
    + Number(Boolean(normalized.to));
}

export function referenceTargetEquals(
  left: ReferenceTarget | null | undefined,
  right: ReferenceTarget | null | undefined,
) {
  return Boolean(left && right && left.type === right.type && left.id === right.id);
}
