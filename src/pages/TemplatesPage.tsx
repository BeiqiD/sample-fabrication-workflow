import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FabubloxImporter } from "../components/FabubloxImporter";
import type { TemplateRecord } from "../lib/api";
import { api } from "../lib/api";

export function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removingId, setRemovingId] = useState("");
  const [imported, setImported] = useState<{ id: string; name: string; version: number } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const importing = searchParams.get("import") === "1";
  const load = useCallback(async () => {
    const result = await api.listTemplates();
    setTemplates(result.templates);
  }, []);
  useEffect(() => { void load().catch((error: Error) => setError(error.message)); }, [load]);

  async function importCompleted(result: { templateVersionId: string; version: number; name: string }) {
    setImported({ id: result.templateVersionId, name: result.name, version: result.version });
    setSearchParams({}, { replace: true });
    try { await load(); }
    catch (error) { setError(`The import succeeded, but the template list could not be refreshed: ${(error as Error).message}`); }
  }

  async function removeUnused(template: TemplateRecord) {
    if (!window.confirm(`Permanently delete unused ${template.name} v${template.version}? Its import source and shared files will be retained.`)) return;
    setRemovingId(template.id); setError(""); setNotice("");
    try {
      const result = await api.removeTemplate(template.id);
      setNotice(result.disposition === "deleted"
        ? `Deleted ${template.name} v${template.version}.`
        : `${template.name} v${template.version} was used by a process run and has been archived instead.`);
      try { await load(); }
      catch (error) { setError(`The template was removed, but the list could not be refreshed: ${(error as Error).message}`); }
    } catch (error) { setError((error as Error).message); }
    finally { setRemovingId(""); }
  }

  return <div className="page narrow-page templates-page">
    <div className="page-heading"><div><p className="eyebrow">Reusable fabrication plans</p><h1>Process templates</h1></div><button type="button" className={importing ? "button" : "button primary"} onClick={() => setSearchParams(importing ? {} : { import: "1" })}>{importing ? "Close import" : "Import workbook"}</button></div>
    {error && <p className="error-banner">{error}</p>}
    {notice && <p className="success-banner">{notice}</p>}
    {imported && <p className="success-banner">Imported <strong>{imported.name} v{imported.version}</strong>. <Link to={`/templates/${imported.id}`}>Open the new version →</Link></p>}
    {importing && <FabubloxImporter templates={templates} onImported={importCompleted} />}
    <div className="card table-card template-table-card">
      {templates.length ? <table className="template-table"><thead><tr><th>Name</th><th>Version</th><th>Initial substrate</th><th>State</th><th>Steps</th><th /></tr></thead><tbody>{templates.map((template) => <tr key={template.id}><td className="template-name-cell"><Link className="template-name-link" to={`/templates/${template.id}`}>{template.name}</Link><small>{template.sourceFilename}</small></td><td data-label="Version">v{template.version}</td><td data-label="Initial substrate">{template.initialStateHash ? "Defined" : "No diagram"}</td><td data-label="State"><span className={`template-state ${template.locked ? "locked" : "draft"}`}>{template.locked ? "Locked" : "Editable"}</span></td><td data-label="Steps">{template.stepCount}</td><td className="template-actions-cell"><div className="template-row-actions"><Link className="text-button" to={`/templates/${template.id}`}>{template.locked ? "View" : "Edit"} →</Link>{!template.locked && <button type="button" className="text-button danger-text" disabled={removingId === template.id} onClick={() => void removeUnused(template)}>{removingId === template.id ? "Deleting…" : "Delete"}</button>}</div></td></tr>)}</tbody></table> : <p className="muted padded">No active process templates yet.</p>}
    </div>
  </div>;
}
