import {
  isSampleStatus,
  SAMPLE_DIRECTORY_SORTS,
  type SampleDirectorySort,
  type SampleStatus,
} from "../../shared/types";

export interface SampleDirectorySettings {
  status: SampleStatus | "";
  location: string;
  parent: string;
  workflow: string;
  sort: SampleDirectorySort;
}

export const SAMPLE_DIRECTORY_SORT_OPTIONS: ReadonlyArray<{ value: SampleDirectorySort; label: string }> = [
  { value: "relevance", label: "Best match" },
  { value: "updated-desc", label: "Updated · newest first" },
  { value: "updated-asc", label: "Updated · oldest first" },
  { value: "created-desc", label: "Created · newest first" },
  { value: "created-asc", label: "Created · oldest first" },
  { value: "code-asc", label: "Sample ID · A–Z" },
  { value: "code-desc", label: "Sample ID · Z–A" },
];

export function defaultSampleDirectorySort(hasQuery: boolean): SampleDirectorySort {
  return hasQuery ? "relevance" : "updated-desc";
}

export function sampleDirectorySortFromParam(value: string | null, hasQuery: boolean): SampleDirectorySort {
  const fallback = defaultSampleDirectorySort(hasQuery);
  if (!(SAMPLE_DIRECTORY_SORTS as readonly string[]).includes(value ?? "")) return fallback;
  return value === "relevance" && !hasQuery ? fallback : value as SampleDirectorySort;
}

export function sampleDirectorySettings(searchParams: URLSearchParams): SampleDirectorySettings {
  const hasQuery = Boolean(searchParams.get("q")?.trim());
  const rawStatus = searchParams.get("status");
  return {
    status: isSampleStatus(rawStatus) ? rawStatus : "",
    location: searchParams.get("location")?.trim() ?? "",
    parent: searchParams.get("parent")?.trim() ?? "",
    workflow: searchParams.get("process")?.trim() ?? "",
    sort: sampleDirectorySortFromParam(searchParams.get("sort"), hasQuery),
  };
}

export function hasExplicitSampleDirectorySort(searchParams: URLSearchParams) {
  const rawSort = searchParams.get("sort");
  if (!(SAMPLE_DIRECTORY_SORTS as readonly string[]).includes(rawSort ?? "")) return false;
  const hasQuery = Boolean(searchParams.get("q")?.trim());
  return sampleDirectorySortFromParam(rawSort, hasQuery) !== defaultSampleDirectorySort(hasQuery);
}

export function activeSampleDirectorySettingCount(searchParams: URLSearchParams) {
  const settings = sampleDirectorySettings(searchParams);
  return [
    settings.status,
    settings.location,
    settings.parent,
    settings.workflow,
    hasExplicitSampleDirectorySort(searchParams),
  ].filter(Boolean).length;
}

export function applySampleDirectorySettings(
  searchParams: URLSearchParams,
  settings: SampleDirectorySettings,
) {
  const next = new URLSearchParams(searchParams);
  const values: Array<[string, string]> = [
    ["status", settings.status],
    ["location", settings.location.trim()],
    ["parent", settings.parent.trim()],
    ["process", settings.workflow.trim()],
  ];
  for (const [key, value] of values) {
    if (value) next.set(key, value); else next.delete(key);
  }
  const defaultSort = defaultSampleDirectorySort(Boolean(next.get("q")?.trim()));
  if (settings.sort === defaultSort) next.delete("sort"); else next.set("sort", settings.sort);
  next.delete("page");
  return next;
}

export function clearSampleDirectorySetting(searchParams: URLSearchParams, key: "status" | "location" | "parent" | "process" | "sort") {
  const next = new URLSearchParams(searchParams);
  next.delete(key);
  next.delete("page");
  return next;
}

export function clearAllSampleDirectorySettings(searchParams: URLSearchParams) {
  const next = new URLSearchParams(searchParams);
  for (const key of ["status", "location", "parent", "process", "sort", "page"]) next.delete(key);
  return next;
}
