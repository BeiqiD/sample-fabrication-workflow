import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { PaginationMeta } from "../../shared/types";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { MetrologyTemplateForm } from "../components/MetrologyTemplateForm";
import { PaginationControls } from "../components/PaginationControls";
import {
  api,
  type MetrologyTemplateInput,
  type MetrologyTemplateSummary,
  type ProcessTemplateFamilySummary,
  type ProcessTemplateVersionSummary,
} from "../lib/api";
import { pageFromSearchParam, setPageParam } from "../lib/pagination";

const FabubloxImporter = lazy(() => import("../components/FabubloxImporter")
  .then((module) => ({ default: module.FabubloxImporter })));
const EMPTY_PROCESS_PAGINATION: PaginationMeta = { page: 1, pageSize: 20, total: 0, totalPages: 1 };
const EMPTY_METROLOGY_PAGINATION: PaginationMeta = { page: 1, pageSize: 25, total: 0, totalPages: 1 };

type PendingTemplateRemoval =
  | { kind: "process"; template: ProcessTemplateVersionSummary }
  | { kind: "metrology"; template: MetrologyTemplateSummary };

function initialSubstrateLabel(template: ProcessTemplateVersionSummary) {
  if (template.hasInitialSubstrateStep) {
    return template.initialStateImageCount ? "Step 0 defined" : "Step 0 · no diagram";
  }
  return template.initialStateHash ? "Legacy definition" : "Step 0 missing";
}

export function TemplatesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedQuery = searchParams.get("q") ?? "";
  const processPage = pageFromSearchParam(searchParams.get("processPage"));
  const metrologyPage = pageFromSearchParam(searchParams.get("metrologyPage"));
  const importing = searchParams.get("import") === "1";
  const [query, setQuery] = useState(requestedQuery);
  const [families, setFamilies] = useState<ProcessTemplateFamilySummary[]>([]);
  const [metrologyTemplates, setMetrologyTemplates] = useState<MetrologyTemplateSummary[]>([]);
  const [processPagination, setProcessPagination] = useState<PaginationMeta>(EMPTY_PROCESS_PAGINATION);
  const [metrologyPagination, setMetrologyPagination] = useState<PaginationMeta>(EMPTY_METROLOGY_PAGINATION);
  const [processLoading, setProcessLoading] = useState(true);
  const [metrologyLoading, setMetrologyLoading] = useState(true);
  const [processError, setProcessError] = useState("");
  const [metrologyError, setMetrologyError] = useState("");
  const [notice, setNotice] = useState("");
  const [removingId, setRemovingId] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<PendingTemplateRemoval | null>(null);
  const [removalError, setRemovalError] = useState("");
  const [creatingMetrology, setCreatingMetrology] = useState(false);
  const [imported, setImported] = useState<{ id: string; name: string; version: number } | null>(null);
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(() => new Set());
  const [familyVersions, setFamilyVersions] = useState<Record<string, ProcessTemplateVersionSummary[]>>({});
  const [loadingFamilyId, setLoadingFamilyId] = useState("");
  const [processRefresh, setProcessRefresh] = useState(0);
  const [metrologyRefresh, setMetrologyRefresh] = useState(0);

  useEffect(() => {
    setQuery(requestedQuery);
    setExpandedFamilies(new Set());
    setFamilyVersions({});
  }, [requestedQuery]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized === requestedQuery) return;
    const timeout = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (normalized) next.set("q", normalized); else next.delete("q");
      next.delete("processPage");
      next.delete("metrologyPage");
      setSearchParams(next, { replace: true });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [query, requestedQuery, searchParams, setSearchParams]);

  useEffect(() => {
    const controller = new AbortController();
    setProcessLoading(true);
    api.listTemplateFamilies({
      query: requestedQuery,
      page: processPage,
      pageSize: 20,
      signal: controller.signal,
    }).then((result) => {
      if (processPage > result.pagination.totalPages) {
        setSearchParams((current) => setPageParam(current, "processPage", result.pagination.totalPages), { replace: true });
        return;
      }
      setFamilies(result.families);
      setProcessPagination(result.pagination);
      setProcessError("");
    }).catch((error: Error) => {
      if (error.name !== "AbortError") setProcessError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setProcessLoading(false);
    });
    return () => controller.abort();
  }, [processPage, processRefresh, requestedQuery, setSearchParams]);

  useEffect(() => {
    const controller = new AbortController();
    setMetrologyLoading(true);
    api.listMetrologyTemplates({
      query: requestedQuery,
      page: metrologyPage,
      pageSize: 25,
      signal: controller.signal,
    }).then((result) => {
      if (metrologyPage > result.pagination.totalPages) {
        setSearchParams((current) => setPageParam(current, "metrologyPage", result.pagination.totalPages), { replace: true });
        return;
      }
      setMetrologyTemplates(result.templates);
      setMetrologyPagination(result.pagination);
      setMetrologyError("");
    }).catch((error: Error) => {
      if (error.name !== "AbortError") setMetrologyError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setMetrologyLoading(false);
    });
    return () => controller.abort();
  }, [metrologyPage, metrologyRefresh, requestedQuery, setSearchParams]);

  function updateSearchParams(mutator: (next: URLSearchParams) => void, replace = false) {
    const next = new URLSearchParams(searchParams);
    mutator(next);
    setSearchParams(next, { replace });
  }

  async function importCompleted(result: { templateVersionId: string; version: number; name: string }) {
    setImported({ id: result.templateVersionId, name: result.name, version: result.version });
    updateSearchParams((next) => {
      next.delete("import");
      next.delete("processPage");
    }, true);
    setExpandedFamilies(new Set());
    setFamilyVersions({});
    setProcessRefresh((value) => value + 1);
  }

  async function createMetrology(input: MetrologyTemplateInput) {
    await api.createMetrologyTemplate(input);
    setCreatingMetrology(false);
    setNotice(`Created ${input.name.trim()}.`);
    updateSearchParams((next) => next.delete("metrologyPage"), true);
    setMetrologyRefresh((value) => value + 1);
  }

  async function removeProcessTemplate(template: ProcessTemplateVersionSummary) {
    setRemovingId(template.id);
    setRemovalError("");
    setNotice("");
    try {
      const result = await api.removeTemplate(template.id);
      setNotice(result.disposition === "deleted"
        ? `Deleted ${template.name} v${template.version}.`
        : `${template.name} was already used and has been removed from future selection; existing records remain unchanged.`);
      setPendingRemoval(null);
      setExpandedFamilies(new Set());
      setFamilyVersions({});
      setProcessRefresh((value) => value + 1);
    } catch (error) {
      setRemovalError((error as Error).message);
    } finally {
      setRemovingId("");
    }
  }

  async function removeMetrologyTemplate(template: MetrologyTemplateSummary) {
    setRemovingId(template.id);
    setRemovalError("");
    setNotice("");
    try {
      const result = await api.removeTemplate(template.id);
      setNotice(result.disposition === "deleted"
        ? `Deleted ${template.name}.`
        : `${template.name} was already used and has been removed from future selection; existing records remain unchanged.`);
      setPendingRemoval(null);
      setMetrologyRefresh((value) => value + 1);
    } catch (error) {
      setRemovalError((error as Error).message);
    } finally {
      setRemovingId("");
    }
  }

  async function toggleFamily(family: ProcessTemplateFamilySummary) {
    if (expandedFamilies.has(family.recipeFamilyId)) {
      setExpandedFamilies((current) => {
        const next = new Set(current);
        next.delete(family.recipeFamilyId);
        return next;
      });
      return;
    }
    setExpandedFamilies((current) => new Set(current).add(family.recipeFamilyId));
    if (familyVersions[family.recipeFamilyId]) return;
    setLoadingFamilyId(family.recipeFamilyId);
    try {
      const result = await api.listTemplateFamilyVersions(family.recipeFamilyId, { query: requestedQuery });
      setFamilyVersions((current) => ({ ...current, [family.recipeFamilyId]: result.versions }));
      setProcessError("");
    } catch (error) {
      setProcessError((error as Error).message);
      setExpandedFamilies((current) => {
        const next = new Set(current);
        next.delete(family.recipeFamilyId);
        return next;
      });
    } finally {
      setLoadingFamilyId("");
    }
  }

  function changePage(key: "processPage" | "metrologyPage", page: number, sectionId: string) {
    setSearchParams(setPageParam(searchParams, key, page));
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const hasQuery = Boolean(requestedQuery);

  return <div className="page templates-page">
    <div className="page-heading">
      <div><p className="eyebrow">Reusable workflow content</p><h1>Templates</h1><p className="lead">Keep fabrication plans and repeatable metrology records in one consistent workspace.</p></div>
    </div>
    {notice && <p className="success-banner">{notice}</p>}
    {imported && <p className="success-banner">Imported <strong>{imported.name} v{imported.version}</strong>. <Link to={`/templates/${imported.id}`}>Open the new version →</Link></p>}
    <label className="search-box">
      <span>Search templates</span>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search process and metrology templates…" />
    </label>

    <section className="templates-section process-templates-section" id="process-templates">
      <div className="section-heading templates-section-heading">
        <div><h2>Process templates</h2><p>Versioned fabrication plans imported from FabuBlox workbooks. Older versions load only when a family is expanded.</p></div>
        <button type="button" className={importing ? "button" : "button primary"} onClick={() => updateSearchParams((next) => {
          if (importing) next.delete("import"); else next.set("import", "1");
        })}>{importing ? "Close import" : "Import workbook"}</button>
      </div>
      {importing && <Suspense fallback={<div className="card"><p className="muted padded">Loading workbook importer…</p></div>}>
        <FabubloxImporter onImported={importCompleted} />
      </Suspense>}
      {processError && <p className="error-banner">{processError}</p>}
      {processLoading ? <p className="muted">Loading process templates…</p> : families.length ? <div className="template-family-list">
        {families.map((family) => {
          const expanded = expandedFamilies.has(family.recipeFamilyId);
          const versions = expanded ? familyVersions[family.recipeFamilyId] : undefined;
          const visibleVersions = versions ?? [family.latest];
          return <section className="card template-family-card" key={family.recipeFamilyId}>
            <header className="template-family-heading">
              <div className="card-copy"><p className="card-label">{family.templateType} template</p><h3 className="card-title">{family.name}</h3><p className="card-meta">Latest version v{family.latestVersion}</p></div>
              <div className="template-family-actions">
                <span className="meta-badge">{family.versionCount} version{family.versionCount === 1 ? "" : "s"}</span>
                {family.versionCount > 1 && <button type="button" className="text-button" disabled={loadingFamilyId === family.recipeFamilyId} onClick={() => void toggleFamily(family)}>
                  {loadingFamilyId === family.recipeFamilyId ? "Loading…" : expanded ? "Show latest only" : "Show all versions"}
                </button>}
              </div>
            </header>
            <div className="template-version-list">{visibleVersions.map((template) => <article className="template-version-row" key={template.id}>
              <Link className="template-version-link" to={`/templates/${template.id}`} aria-label={`Open ${template.name} version ${template.version}`}>
                <div className="template-version-identity">
                  <div className="card-title-line"><strong>v{template.version}</strong>{template.version === family.latestVersion && <span className="meta-badge">Latest</span>}</div>
                  <small>{template.sourceFilename || "Manually created version"}</small>
                </div>
                <div className="template-version-fact"><small>Initial substrate</small><span>{initialSubstrateLabel(template)}</span></div>
                <div className="template-version-fact"><small>State</small><span className={`template-state ${template.locked ? "locked" : "draft"}`}>{template.locked ? "Locked" : "Editable"}</span></div>
                <div className="template-version-fact"><small>Steps</small><span>{template.stepCount}</span></div>
              </Link>
              <div className="template-row-actions">
                <Link className="text-button template-row-edit" to={`/templates/${template.id}`}>{template.locked ? "View" : "Edit"} →</Link>
                {!template.locked && <button type="button" className="text-button danger-text" disabled={removingId === template.id} onClick={() => { setRemovalError(""); setPendingRemoval({ kind: "process", template }); }}>{removingId === template.id ? "Deleting…" : "Delete"}</button>}
              </div>
            </article>)}</div>
          </section>;
        })}
      </div> : <div className="card"><p className="muted padded">{hasQuery ? "No matching process templates." : "No active process templates yet."}</p></div>}
      <PaginationControls pagination={processPagination} label="Process template pages" disabled={processLoading} onPageChange={(page) => changePage("processPage", page, "process-templates")} />
    </section>

    <section className="templates-section metrology-templates-section" id="metrology-templates">
      <div className="section-heading templates-section-heading">
        <div><h2>Metrology templates</h2><p>Flat, reusable records for results, comments, and attachments. They do not change the sample structure.</p></div>
        <button type="button" className="button primary" aria-expanded={creatingMetrology} onClick={() => setCreatingMetrology((open) => !open)}>{creatingMetrology ? "Close" : "New metrology template"}</button>
      </div>
      {creatingMetrology && <MetrologyTemplateForm title="New metrology template" submitLabel="Save template" onCancel={() => setCreatingMetrology(false)} onSubmit={createMetrology} />}
      {metrologyError && <p className="error-banner">{metrologyError}</p>}
      {metrologyLoading ? <p className="muted">Loading metrology templates…</p> : metrologyTemplates.length ? <div className="metrology-template-list">
        {metrologyTemplates.map((template) => <article className="card metrology-template-row" id={`metrology-template-${template.id}`} key={template.id}>
          <Link className="metrology-template-link" to={`/templates/metrology/${template.id}`} aria-label={`Open ${template.name} metrology template`}>
            <div className="metrology-template-identity"><p className="card-label">Metrology</p><h3 className="card-title">{template.name}</h3></div>
            <div className="metrology-template-summary">
              <span><small>Tool</small><strong>{template.toolName || "Optional"}</strong></span>
              <span><small>Default content</small><strong>{template.hasDefaultContent ? "Defined" : "Empty"}</strong></span>
            </div>
          </Link>
          <div className="template-row-actions">
            <Link className="text-button template-row-edit" to={`/templates/metrology/${template.id}`}>Edit →</Link>
            <button type="button" className="text-button danger-text" disabled={removingId === template.id} onClick={() => { setRemovalError(""); setPendingRemoval({ kind: "metrology", template }); }}>{removingId === template.id ? "Deleting…" : "Delete"}</button>
          </div>
        </article>)}
      </div> : <div className="card"><p className="muted padded">{hasQuery ? "No matching metrology templates." : "No metrology templates yet."}</p></div>}
      <PaginationControls pagination={metrologyPagination} label="Metrology template pages" disabled={metrologyLoading} onPageChange={(page) => changePage("metrologyPage", page, "metrology-templates")} />
    </section>
    {pendingRemoval && <ConfirmDeleteDialog
      title={pendingRemoval.kind === "process" ? "Delete this process template version?" : "Delete this metrology template?"}
      description={pendingRemoval.kind === "process"
        ? "The unused version will be permanently deleted. If it has already been used, existing records will remain and it will only be removed from future selection. Its import source and shared files will be retained."
        : "The template will be removed from future use. Existing records and runs will remain unchanged."}
      summary={pendingRemoval.kind === "process"
        ? `${pendingRemoval.template.name} · v${pendingRemoval.template.version}`
        : pendingRemoval.template.name}
      deleting={removingId === pendingRemoval.template.id}
      error={removalError}
      eyebrow={pendingRemoval.kind === "process" ? "Delete process template" : "Delete metrology template"}
      confirmLabel="Delete template"
      onCancel={() => { setPendingRemoval(null); setRemovalError(""); }}
      onConfirm={() => void (pendingRemoval.kind === "process"
        ? removeProcessTemplate(pendingRemoval.template)
        : removeMetrologyTemplate(pendingRemoval.template))}
    />}
  </div>;
}
