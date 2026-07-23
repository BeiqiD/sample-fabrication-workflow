import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FabubloxImporter } from "../components/FabubloxImporter";
import type { TemplateRecord } from "../lib/api";
import { api } from "../lib/api";
import { groupTemplateVersions } from "../lib/template-groups";

function initialSubstrateLabel(template: TemplateRecord) {
  if (template.initialSubstrateStep) {
    return template.initialStateImageKeys.length ? "Step 0 defined" : "Step 0 · no diagram";
  }
  return template.initialStateHash ? "Legacy definition" : "Step 0 missing";
}

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

  const templateFamilies = groupTemplateVersions(templates);

  return <div className="page templates-page">
    <div className="page-heading"><div><p className="eyebrow">Reusable fabrication plans</p><h1>Process templates</h1></div><button type="button" className={importing ? "button" : "button primary"} onClick={() => setSearchParams(importing ? {} : { import: "1" })}>{importing ? "Close import" : "Import workbook"}</button></div>
    {error && <p className="error-banner">{error}</p>}
    {notice && <p className="success-banner">{notice}</p>}
    {imported && <p className="success-banner">Imported <strong>{imported.name} v{imported.version}</strong>. <Link to={`/templates/${imported.id}`}>Open the new version →</Link></p>}
    {importing && <FabubloxImporter templates={templates} onImported={importCompleted} />}
    {templateFamilies.length ? <div className="template-family-list">{templateFamilies.map((family) => <section className="card template-family-card" key={family.recipeFamilyId}>
      <header className="template-family-heading">
        <div className="card-copy"><p className="card-label">{family.templateType} template</p><h2 className="card-title">{family.name}</h2><p className="card-meta">Latest version v{family.latestVersion}</p></div>
        <span className="meta-badge">{family.versions.length} version{family.versions.length === 1 ? "" : "s"}</span>
      </header>
      <div className="template-version-list">{family.versions.map((template, index) => <article className="template-version-row" key={template.id}>
        <div className="template-version-identity">
          <div className="card-title-line"><strong>v{template.version}</strong>{index === 0 && <span className="meta-badge">Latest</span>}</div>
          <small>{template.sourceFilename || "Manually created version"}</small>
        </div>
        <div className="template-version-fact"><small>Initial substrate</small><span>{initialSubstrateLabel(template)}</span></div>
        <div className="template-version-fact"><small>State</small><span className={`template-state ${template.locked ? "locked" : "draft"}`}>{template.locked ? "Locked" : "Editable"}</span></div>
        <div className="template-version-fact"><small>Steps</small><span>{template.stepCount}</span></div>
        <div className="template-row-actions"><Link className="text-button" to={`/templates/${template.id}`}>{template.locked ? "View" : "Edit"} →</Link>{!template.locked && <button type="button" className="text-button danger-text" disabled={removingId === template.id} onClick={() => void removeUnused(template)}>{removingId === template.id ? "Deleting…" : "Delete"}</button>}</div>
      </article>)}</div>
    </section>)}</div> : <div className="card"><p className="muted padded">No active process templates yet.</p></div>}
  </div>;
}
