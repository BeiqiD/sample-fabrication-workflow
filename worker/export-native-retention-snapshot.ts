import { FILE_AUTHORITY_EXPORT_VIEW_COLUMNS } from "../shared/contracts/export-file-authority";
import type { ExportTables } from "../shared/contracts/export";

const retentionColumns = {
  blob_retention_edges: ["store_kind", "provider", "object_key", "blob_record_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"],
  ...Object.fromEntries(Object.entries(FILE_AUTHORITY_EXPORT_VIEW_COLUMNS).filter(([name]) => name.includes("retention_edges"))),
};
export const NATIVE_RETENTION_VIEW_NAMES = new Set(Object.keys(retentionColumns));
// Materialization evaluates every child/aggregate before returning the first
// row, inside one sqlite3_step and its stable 'now' value. Keep one JSON object
// per edge so the source query respects D1's per-value size bound.
// Select one materialized stream per unique view name. An outer UNION makes D1
// expand the nested views past its compound-select limit even behind CTE
// fences. Equality joins use automatic indexes and preserve every duplicate;
// filtering unmatched names removes empty-view placeholders. The NULL selector
// always produces one clock sentinel, including when all views are empty.
const retentionSources = Object.keys(retentionColumns).map(name => `retention_${name}`);
const retentionJson = `coalesce(${retentionSources.map(name => `${name}.row_json`).join(",")})`;
export const NATIVE_RETENTION_SNAPSHOT_QUERY = `WITH
  snapshot_clock AS MATERIALIZED (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS snapshot_clock),
  ${Object.entries(retentionColumns).map(([name, columns]) => `retention_${name} AS MATERIALIZED
    (SELECT '${name}' AS archive_view,
      json_object(${columns.map(column => `'${column}',${column}`).join(",")}) AS row_json FROM ${name})`).join(",\n  ")},
  retention_selector(archive_view) AS MATERIALIZED
    (VALUES ${Object.keys(retentionColumns).map(name => `('${name}')`).join(",")},(NULL)),
  retention AS MATERIALIZED (
    SELECT retention_selector.archive_view,${retentionJson} AS row_json
    FROM retention_selector
    ${retentionSources.map(name => `LEFT JOIN ${name} ON retention_selector.archive_view=${name}.archive_view`).join("\n    ")}
    WHERE retention_selector.archive_view IS NULL OR ${retentionJson} IS NOT NULL)
  SELECT retention.archive_view,retention.row_json,snapshot_clock.snapshot_clock
  FROM retention CROSS JOIN snapshot_clock ORDER BY archive_view,row_json`;

export function checkedNativeRetentionSnapshot(value: unknown): { snapshotClock: string; tables: ExportTables } {
  const rows = value as Array<{ snapshot_clock?: unknown; archive_view?: unknown; row_json?: unknown }>;
  const clock = rows[0]?.snapshot_clock;
  if (!Array.isArray(rows) || typeof clock !== "string" || !Number.isFinite(Date.parse(clock)) || new Date(clock).toISOString() !== clock)
    throw new Error("Native retention source snapshot was incomplete");
  const tables = Object.fromEntries(Object.keys(retentionColumns).map(name => [name, []])) as ExportTables;
  let sentinel = 0;
  for (const row of rows) {
    if (row.snapshot_clock !== clock) throw new Error("Native retention source clocks differ");
    if (row.archive_view === null && row.row_json === null) { sentinel += 1; continue; }
    if (typeof row.archive_view !== "string" || !NATIVE_RETENTION_VIEW_NAMES.has(row.archive_view) || typeof row.row_json !== "string")
      throw new Error("Native retention source view inventory was incomplete");
    tables[row.archive_view].push(JSON.parse(row.row_json));
  }
  if (sentinel !== 1) throw new Error("Native retention source clock sentinel was incomplete");
  return { snapshotClock: clock, tables };
}
