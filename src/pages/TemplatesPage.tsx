import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FabubloxImporter } from "../components/FabubloxImporter";
import { MetrologyTemplateForm } from "../components/MetrologyTemplateForm";
import type { MetrologyTemplateInput, TemplateRecord } from "../lib/api";
import { api } from "../lib/api";
import { groupTemplateVersions } from "../lib/template-groups";
import { matchesTemplateFamilySearch, matchesTemplateSearch } from "../lib/template-search";

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
  const [creatingMetrology, setCreatingMetrology] = useState(false);
  const [query, setQuery] = useState("");
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

  async function createMetrology(input: MetrologyTemplateInput) {
    const created = await api.createMetrologyTemplate(input);
    setCreatingMetrology(false);
    setNotice(`Created ${input.name.trim()}.`);
    setError("");
    await load();
    document.getElementById(`metrology-template-${created.id}`)?.scrollIntoView({ block: "nearest" });
  }

  async function removeTemplate(template: TemplateRecord) {
    const message = template.templateKind === "metrology"
      ? `Delete the ${template.name} metrology template? Existing records and runs will remain unchanged.`
      : `Permanently delete unused ${template.name} v${template.version}? Its import source and shared files will be retained.`;
    if (!window.confirm(message)) return;
    setRemovingId(template.id); setError(""); setNotice("");
    try {
      const result = await api.removeTemplate(template.id);
      setNotice(result.disposition === "deleted"
        ? `Deleted ${template.templateKind === "metrology" ? template.name : `${template.name} v${template.version}`}.`
        : `${template.name} was already used and has been removed from future selection; existing records remain unchanged.`);
      try { await load(); }
      catch (error) { setError(`The template was removed, but the list could not be refreshed: ${(error as Error).message}`); }
    } catch (error) { setError((error as Error).message); }
    finally { setRemovingId(""); }
  }

  const processTemplates = useMemo(() => templates.filter((template) => template.templateKind === "process"), [templates]);
  const metrologyTemplates = useMemo(() => templates.filter((template) => template.templateKind === "metrology"), [templates]);
  const templateFamilies = useMemo(() => groupTemplateVersions(processTemplates)
    .map((family) => ({
      ...family,
      versions: matchesTemplateFamilySearch(family, query)
        ? family.versions
        : family.versions.filter((template) => matchesTemplateSearch(template, query)),
    }))
    .filter((family) => family.versions.length), [processTemplates, query]);
  const visibleMetrologyTemplates = useMemo(() =>
    metrologyTemplates.filter((template) => matchesTemplateSearch(template, query)), [metrologyTemplates, query]);
  const hasQuery = Boolean(query.trim());

  return <div className="page templates-page">
    <div className="page-heading">
      <div><p className="eyebrow">Reusable workflow content</p><h1>Templates</h1><p className="lead">Keep fabrication plans and repeatable metrology records in one consistent workspace.</p></div>
    </div>
    {error && <p className="error-banner">{error}</p>}
    {notice && <p className="success-banner">{notice}</p>}
    {imported && <p className="success-banner">Imported <strong>{imported.name} v{imported.version}</strong>. <Link to={`/templates/${imported.id}`}>Open the new version →</Link></p>}
    <label className="search-box">
      <span>Search templates</span>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search process and metrology templates…" />
    </label>

    <section className="templates-section process-templates-section">
      <div className="section-heading templates-section-heading">
        <div><h2>Process templates</h2><p>Versioned fabrication plans imported from FabuBlox workbooks.</p></div>
        <button type="button" className={importing ? "button" : "button primary"} onClick={() => setSearchParams(importing ? {} : { import: "1" })}>{importing ? "Close import" : "Import workbook"}</button>
      </div>
      {importing && <FabubloxImporter templates={processTemplates} onImported={importCompleted} />}
      {templateFamilies.length ? <div className="template-family-list">{templateFamilies.map((family) => <section className="card template-family-card" key={family.recipeFamilyId}>
        <header className="template-family-heading">
          <div className="card-copy"><p className="card-label">{family.templateType} template</p><h3 className="card-title">{family.name}</h3><p className="card-meta">Latest version v{family.latestVersion}</p></div>
          <span className="meta-badge">{family.versions.length} version{family.versions.length === 1 ? "" : "s"}</span>
        </header>
        <div className="template-version-list">{family.versions.map((template, index) => <article className="template-version-row" key={template.id}>
          <Link className="template-version-link" to={`/templates/${template.id}`} aria-label={`${template.locked ? "View" : "Edit"} ${template.name} version ${template.version}`}>
            <div className="template-version-identity">
              <div className="card-title-line"><strong>v{template.version}</strong>{index === 0 && <span className="meta-badge">Latest</span>}</div>
              <small>{template.sourceFilename || "Manually created version"}</small>
            </div>
            <div className="template-version-fact"><small>Initial substrate</small><span>{initialSubstrateLabel(template)}</span></div>
            <div className="template-version-fact"><small>State</small><span className={`template-state ${template.locked ? "locked" : "draft"}`}>{template.locked ? "Locked" : "Editable"}</span></div>
            <div className="template-version-fact"><small>Steps</small><span>{template.stepCount}</span></div>
            <span className="text-button template-row-open" aria-hidden="true">{template.locked ? "View" : "Edit"} →</span>
          </Link>
          {!template.locked && <div className="template-row-actions"><button type="button" className="text-button danger-text" disabled={removingId === template.id} onClick={() => void removeTemplate(template)}>{removingId === template.id ? "Deleting…" : "Delete"}</button></div>}
        </article>)}</div>
      </section>)}</div> : <div className="card"><p className="muted padded">{hasQuery ? "No matching process templates." : "No active process templates yet."}</p></div>}
    </section>

    <section className="templates-section metrology-templates-section">
      <div className="section-heading templates-section-heading">
        <div><h2>Metrology templates</h2><p>Flat, reusable records for results, comments, and attachments. They do not change the sample structure.</p></div>
        <button type="button" className="button primary" aria-expanded={creatingMetrology} onClick={() => setCreatingMetrology((open) => !open)}>{creatingMetrology ? "Close" : "New metrology template"}</button>
      </div>
      {creatingMetrology && <MetrologyTemplateForm title="New metrology template" submitLabel="Save template" onCancel={() => setCreatingMetrology(false)} onSubmit={createMetrology} />}
      {visibleMetrologyTemplates.length ? <div className="metrology-template-list">{visibleMetrologyTemplates.map((template) => <article className="card metrology-template-row" id={`metrology-template-${template.id}`} key={template.id}>
        <Link className="metrology-template-link" to={`/templates/metrology/${template.id}`} aria-label={`Edit ${template.name} metrology template`}>
          <div className="metrology-template-identity"><p className="card-label">Metrology</p><h3 className="card-title">{template.name}</h3></div>
          <div className="metrology-template-summary">
            <span><small>Tool</small><strong>{template.toolName || "Optional"}</strong></span>
            <span><small>Default content</small><strong>{template.commentsText || template.parametersText ? "Defined" : "Empty"}</strong></span>
          </div>
          <span className="text-button template-row-open" aria-hidden="true">Edit →</span>
        </Link>
        <div className="template-row-actions"><button type="button" className="text-button danger-text" disabled={removingId === template.id} onClick={() => void removeTemplate(template)}>{removingId === template.id ? "Deleting…" : "Delete"}</button></div>
      </article>)}</div> : <div className="card"><p className="muted padded">{hasQuery ? "No matching metrology templates." : "No metrology templates yet."}</p></div>}
    </section>
  </div>;
}
