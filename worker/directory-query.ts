import { SAMPLE_DIRECTORY_SORTS, type PaginationMeta, type SampleDirectorySort } from "../shared/types";
import { escapedLikePattern } from "./request-guards";

export const DEFAULT_DIRECTORY_PAGE_SIZE = 50;
export const MAX_DIRECTORY_PAGE_SIZE = 100;

function positiveInteger(value: string | null | undefined, fallback: number) {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPagination(
  pageValue: string | null | undefined,
  pageSizeValue: string | null | undefined,
  defaultPageSize = DEFAULT_DIRECTORY_PAGE_SIZE,
) {
  const page = positiveInteger(pageValue, 1);
  const requestedPageSize = positiveInteger(pageSizeValue, defaultPageSize);
  const pageSize = Math.min(requestedPageSize, MAX_DIRECTORY_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paginationMeta(totalValue: number, page: number, pageSize: number): PaginationMeta {
  const total = Math.max(0, Number(totalValue) || 0);
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function searchTokens(value: string | null | undefined) {
  return [...new Set((value ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}

export function likeBindings(tokens: string[]) {
  return tokens.map((token) => escapedLikePattern(token));
}

export function repeatedLikeSql(haystackSql: string, tokens: string[]) {
  return tokens.map(() => `${haystackSql} LIKE ? ESCAPE '\\'`).join(" AND ");
}

export type ProcessingDirectoryFilter = "active" | "complete" | "cancelled" | "all";

export function processingDirectoryFilter(value: string | null | undefined): ProcessingDirectoryFilter {
  return value === "complete" || value === "cancelled" || value === "all" ? value : "active";
}

export function sampleDirectorySort(value: string | null | undefined, hasQuery: boolean): SampleDirectorySort {
  const fallback: SampleDirectorySort = hasQuery ? "relevance" : "updated-desc";
  if (!(SAMPLE_DIRECTORY_SORTS as readonly string[]).includes(value ?? "")) return fallback;
  return value === "relevance" && !hasQuery ? fallback : value as SampleDirectorySort;
}

export function directoryFilterValue(value: string | null | undefined) {
  return (value ?? "").trim().slice(0, 160);
}
