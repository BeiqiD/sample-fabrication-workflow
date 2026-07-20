import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { TemplateRecord } from "../lib/api";
import { api } from "../lib/api";

export function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { api.listTemplates().then(({ templates }) => setTemplates(templates)).catch((error: Error) => setError(error.message)); }, []);
  return <div className="page narrow-page">
    <div className="page-heading"><div><p className="eyebrow">FabuBlox</p><h1>Templates</h1></div><Link className="button primary" to="/imports/fabublox">Import workbook</Link></div>
    {error && <p className="error-banner">{error}</p>}
    <div className="card table-card">
      {templates.length ? <table><thead><tr><th>Name</th><th>Type</th><th>Version</th><th>State</th><th>Steps</th><th /></tr></thead><tbody>{templates.map((template) => <tr key={template.id}><td><strong>{template.name}</strong><small>{template.sourceFilename}</small></td><td>{template.templateType}</td><td>v{template.version}</td><td><span className={`template-state ${template.locked ? "locked" : "draft"}`}>{template.locked ? "Locked" : "Editable"}</span></td><td>{template.stepCount}</td><td><Link className="text-button" to={`/templates/${template.id}`}>{template.locked ? "View" : "Edit"} →</Link></td></tr>)}</tbody></table> : <p className="muted padded">No active templates yet.</p>}
    </div>
  </div>;
}
