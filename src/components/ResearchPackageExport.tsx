import { Link } from "react-router-dom";
import { researchExportHref, type ProcessingExportOrigin, type ResearchPackageRoot } from "../lib/research-export-context";
import "./research-package-export.css";

export type { ProcessingExportOrigin, ResearchPackageRoot } from "../lib/research-export-context";

export function ResearchReportLink({ root, origin, disabled = false, compact = false }: {
  root: ResearchPackageRoot; origin?: ProcessingExportOrigin; disabled?: boolean; compact?: boolean;
}) {
  const href = researchExportHref(root, "report", origin);
  const className = `button research-report-link${compact ? " compact-button" : ""}`;
  return disabled || !href ? <span className={className} aria-disabled="true">Offline report</span>
    : <Link className={className} to={href} title={origin?.type === "processing"
      ? "Review a report of the primary sample's recorded history across its runs"
      : "Review an offline HTML and Markdown report"}>Offline report</Link>;
}

/** Context only selects a root. Settings Data shows the server's scope preview
 * before accepting work; following a link never starts an export. */
export function ResearchPackageExport({ root, origin, disabled = false, compact = false }: {
  root: ResearchPackageRoot; origin?: ProcessingExportOrigin; disabled?: boolean; compact?: boolean;
}) {
  const href = researchExportHref(root, "data_package", origin);
  const className = `button${compact ? " compact-button" : ""}`;
  return <span className="research-package-context-actions">
    {disabled || !href ? <span className={className} aria-disabled="true">Data package</span>
      : <Link className={className} to={href} title="Review a native package with research records and files">Data package</Link>}
    <ResearchReportLink root={root} origin={origin} disabled={disabled} compact={compact} />
  </span>;
}
