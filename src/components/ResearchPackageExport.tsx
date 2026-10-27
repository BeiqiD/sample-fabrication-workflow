import { Link } from "react-router-dom";
import { researchExportHref, type ProcessingExportOrigin, type ResearchPackageRoot } from "../lib/research-export-context";
import { ActionIcon } from "./ActionIcon";
import "./research-package-export.css";

export type { ProcessingExportOrigin, ResearchPackageRoot } from "../lib/research-export-context";

interface ResearchExportActionProps {
  root: ResearchPackageRoot;
  origin?: ProcessingExportOrigin;
  disabled?: boolean;
  compact?: boolean;
  mobileIconOnly?: boolean;
}

export function ResearchReportLink({ root, origin, disabled = false, compact = false, mobileIconOnly = false }: ResearchExportActionProps) {
  const href = researchExportHref(root, "report", origin);
  const className = `button research-export-action research-report-link${compact ? " compact-button" : ""}${mobileIconOnly ? " research-export-mobile-icon" : ""}`;
  const title = origin?.type === "processing"
    ? "Review a report of the primary sample's recorded history across its runs"
    : "Review an offline HTML and Markdown report";
  const content = <><ActionIcon name="report" /><span className="research-export-action-label">Offline report</span></>;
  return disabled || !href ? <span className={className} role="link" aria-label="Offline report" aria-disabled="true" title={title}>{content}</span>
    : <Link className={className} to={href} aria-label="Offline report" title={title}>{content}</Link>;
}

/** Context only selects a root. Settings Data shows the server's scope preview
 * before accepting work; following a link never starts an export. */
export function ResearchPackageExport({ root, origin, disabled = false, compact = false, mobileIconOnly = false }: ResearchExportActionProps) {
  const href = researchExportHref(root, "data_package", origin);
  const className = `button research-export-action${compact ? " compact-button" : ""}${mobileIconOnly ? " research-export-mobile-icon" : ""}`;
  const title = "Review a native package with research records and files";
  const content = <><ActionIcon name="package" /><span className="research-export-action-label">Data package</span></>;
  return <span className={`research-package-context-actions${mobileIconOnly ? " research-package-mobile-icons" : ""}`}>
    {disabled || !href ? <span className={className} role="link" aria-label="Data package" aria-disabled="true" title={title}>{content}</span>
      : <Link className={className} to={href} aria-label="Data package" title={title}>{content}</Link>}
    <ResearchReportLink root={root} origin={origin} disabled={disabled} compact={compact} mobileIconOnly={mobileIconOnly} />
  </span>;
}
