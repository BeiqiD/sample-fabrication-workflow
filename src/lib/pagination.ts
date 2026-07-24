import type { PaginationMeta } from "../../shared/types";

export function pageFromSearchParam(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function paginationRange(pagination: PaginationMeta) {
  if (!pagination.total) return { from: 0, to: 0 };
  const from = (pagination.page - 1) * pagination.pageSize + 1;
  return { from, to: Math.min(pagination.total, from + pagination.pageSize - 1) };
}

export function setPageParam(searchParams: URLSearchParams, key: string, page: number) {
  const next = new URLSearchParams(searchParams);
  if (page > 1) next.set(key, String(page)); else next.delete(key);
  return next;
}
