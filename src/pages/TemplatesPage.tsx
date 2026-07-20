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
      {templates.length ? <table><thead><tr><th>Name</th><th>Type</th><th>Version</th><th>Imported</th></tr></thead><tbody>{templates.map((template) => <tr key={template.id}><td><strong>{template.name}</strong><small>{template.sourceFilename}</small></td><td>{template.templateType}</td><td>v{template.version}</td><td>{new Date(template.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table> : <p className="muted padded">No imported templates yet.</p>}
    </div>
  </div>;
}
