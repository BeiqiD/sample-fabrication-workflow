import type { PaginationMeta } from "../../shared/types";
import { paginationRange } from "../lib/pagination";

export function PaginationControls({
  pagination,
  label,
  disabled = false,
  onPageChange,
}: {
  pagination: PaginationMeta;
  label: string;
  disabled?: boolean;
  onPageChange: (page: number) => void;
}) {
  if (!pagination.total) return null;
  const { from, to } = paginationRange(pagination);
  return <nav className="pagination-controls" aria-label={label}>
    <p><strong>{from}–{to}</strong> of {pagination.total}</p>
    <div>
      <button type="button" className="button" disabled={disabled || pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)}>Previous</button>
      <span>Page {pagination.page} of {pagination.totalPages}</span>
      <button type="button" className="button" disabled={disabled || pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)}>Next</button>
    </div>
  </nav>;
}
