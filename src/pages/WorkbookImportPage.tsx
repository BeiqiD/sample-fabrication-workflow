import { lazy, Suspense } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { templateDetailPath, templateDirectorySearch } from "../lib/templateRoutes";
import "../settings-tasks.css";

const FabubloxImporter = lazy(() => import("../components/FabubloxImporter")
  .then(module => ({ default: module.FabubloxImporter })));

export function WorkbookImportPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  return <div className="page workbook-import-page">
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>Workbook import</h1>
      <p className="lead">Bring an existing FabuBlox process into the workspace, then review its template and continue processing here.</p></div></div>
    <Suspense fallback={<p className="muted" role="status">Loading workbook importer…</p>}>
      <FabubloxImporter onImported={async result => { navigate(templateDetailPath(result.templateVersionId, "process")); }} />
    </Suspense>
    <div className="settings-related-tools"><p>Continue in the workspace</p>
      <nav aria-label="Workspace destinations">
        <Link to={`/templates${templateDirectorySearch(searchParams)}`}>Template library</Link>{" · "}
        <Link to="/processing">Processing</Link>
      </nav>
    </div>
  </div>;
}
