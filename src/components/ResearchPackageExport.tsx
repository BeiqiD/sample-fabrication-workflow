import { Link } from "react-router-dom";
import "./research-package-export.css";

export interface ResearchPackageRoot { type: "sample" | "project"; id: string }

/** Context only selects a root. Settings Data shows the server's scope preview
 * before accepting work; following a link never starts an export. */
export function ResearchPackageExport({ root, disabled = false, compact = false }: {
  root: ResearchPackageRoot; disabled?: boolean; compact?: boolean;
}) {
  const query = new URLSearchParams({ rootType: root.type, rootId: root.id });
  const className = `button${compact ? " compact-button" : ""}`;
  return <span className="research-package-context-actions">
    {disabled ? <><span className={className} aria-disabled="true">Data package</span>
      <span className={className} aria-disabled="true">Offline report</span></> : <>
      <Link className={className} to={`/settings/data?${query}&kind=data_package`}
        title="Review a native package with research records and files">Data package</Link>
      <Link className={className} to={`/settings/data?${query}&kind=report`}
        title="Review an offline HTML and Markdown report">Offline report</Link>
    </>}
  </span>;
}
