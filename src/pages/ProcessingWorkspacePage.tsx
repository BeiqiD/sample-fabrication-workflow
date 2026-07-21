import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { PlanUpdatePreview, ProcessingSampleDetail, SampleSummary } from "../../shared/types";
import { MultiSampleRunGrid } from "../components/MultiSampleRunGrid";
import { StatusPill } from "../components/StatusPill";
import { api, type TemplateRecord } from "../lib/api";

const MAX_VISIBLE_SAMPLES = 8;

export function ProcessingWorkspacePage() {
  const { sampleId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const additionalKey = searchParams.get("with") || "";
  const requestedRunId = searchParams.get("run") || "";
  const additionalIds = additionalKey.split(",").map((id) => id.trim()).filter((id, index, ids) => id && id !== sampleId && ids.indexOf(id) === index).slice(0, MAX_VISIBLE_SAMPLES - 1);
  const [samples, setSamples] = useState<ProcessingSampleDetail[]>([]);
  const sample = samples.find((item) => item.id === sampleId) || null;
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [templateVersionId, setTemplateVersionId] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [planPreview, setPlanPreview] = useState<PlanUpdatePreview | null>(null);
  const [showSamplePicker, setShowSamplePicker] = useState(false);
  const [sampleQuery, setSampleQuery] = useState("");
  const [sampleResults, setSampleResults] = useState<SampleSummary[]>([]);

  const load = useCallback(async () => {
    try {
      const details = await Promise.all([sampleId, ...additionalIds].map((id) => api.getProcessingSample(id)));
      setSamples(details);
      setError("");
    } catch (error) { setError((error as Error).message); }
  // additionalKey is the stable URL representation of additionalIds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId, additionalKey]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.listTemplates().then(({ templates }) => setTemplates(templates)).catch((error: Error) => setError(error.message)); }, []);
  const activeRun = sample?.runs.find((run) => run.status === "active") ?? null;
  const selectedRun = sample?.runs.find((run) => run.id === requestedRunId) ?? activeRun ?? sample?.runs[0] ?? null;

  useEffect(() => {
    setPlanPreview(null);
    if (!sample || !activeRun || selectedRun?.id !== activeRun.id || !templateVersionId) return;
    api.previewPlanUpdate(sample.id, activeRun.id, templateVersionId).then(setPlanPreview).catch((error: Error) => setError(error.message));
  }, [sample, activeRun, selectedRun, templateVersionId]);

  useEffect(() => {
    if (!showSamplePicker) return;
    const timeout = window.setTimeout(() => {
      api.listSamples(sampleQuery).then(({ samples }) => setSampleResults(samples)).catch((error: Error) => setError(error.message));
    }, 160);
    return () => window.clearTimeout(timeout);
  }, [sampleQuery, showSamplePicker]);

  function updateSearchParams(updates: { with?: string[]; run?: string }) {
    const next = new URLSearchParams(searchParams);
    if (updates.with) {
      if (updates.with.length) next.set("with", updates.with.join(",")); else next.delete("with");
    }
    if (updates.run !== undefined) {
      if (updates.run) next.set("run", updates.run); else next.delete("run");
    }
    setSearchParams(next, { replace: true });
  }

  function addVisibleSample(id: string) {
    if (samples.length >= MAX_VISIBLE_SAMPLES || id === sampleId || additionalIds.includes(id)) return;
    updateSearchParams({ with: [...additionalIds, id] });
    setShowSamplePicker(false);
    setSampleQuery("");
  }

  function removeVisibleSample(id: string) {
    updateSearchParams({ with: additionalIds.filter((sample) => sample !== id) });
  }

  async function assignTemplate() {
    if (!templateVersionId) return;
    setAssigning(true); setError("");
    try {
      const result = await api.assignTemplate(sampleId, templateVersionId);
      setTemplateVersionId("");
      updateSearchParams({ run: result.id });
      await load();
    } catch (error) { setError((error as Error).message); }
    finally { setAssigning(false); }
  }

  async function updatePlan() {
    if (!templateVersionId || !activeRun || !planPreview?.compatible) return;
    setAssigning(true); setError("");
    try {
      await api.applyPlanUpdate(sampleId, activeRun.id, templateVersionId);
      setTemplateVersionId(""); setPlanPreview(null);
      await load();
    } catch (error) { setError((error as Error).message); }
    finally { setAssigning(false); }
  }

  if (!sample) return <div className="page"><p>{error || "Loading processing workspace…"}</p></div>;
  const includedIds = new Set(samples.map((item) => item.id));
  const availableResults = sampleResults.filter((result) => !includedIds.has(result.id));
  const assignableTemplates = activeRun
    ? templates.filter((template) => template.recipeFamilyId === activeRun.recipeFamilyId && template.id !== activeRun.templateVersionId)
    : templates;
  const selectedIsActive = selectedRun?.status === "active";

  return <div className="page processing-workspace-page sample-page">
    <Link className="back-link" to="/processing">← Processing</Link>
    <div className="sample-header">
      <div className="sample-header-copy"><p className="eyebrow">Processing · {sample.code}</p><h1>{sample.title}</h1><p className="lead">Execute the selected run; sample metadata and the permanent timeline stay in the sample archive.</p></div>
      <div className="header-actions"><StatusPill status={sample.status} /><Link className="button" to={`/samples/${sample.id}`}>Open sample</Link></div>
    </div>
    {error && <p className="error-banner">{error}</p>}

    <section className="execution-workspace">
      <div className="execution-heading">
        <div><p className="eyebrow">Execution workspace</p><h2>Samples in this view</h2><p>Use checked columns for common confirmation and comments. Every correction remains sample-specific.</p></div>
        <button className="button primary" disabled={samples.length >= MAX_VISIBLE_SAMPLES || !selectedIsActive} onClick={() => setShowSamplePicker((value) => !value)}>+ Add sample</button>
      </div>
      <div className="visible-samples">
        {samples.map((item, index) => <div className="visible-sample" key={item.id}><span>{item.code}</span><small>{item.title}</small>{index > 0 && <button type="button" aria-label={`Remove ${item.code} from view`} onClick={() => removeVisibleSample(item.id)}>×</button>}</div>)}
      </div>
      {showSamplePicker && <div className="card sample-picker-popover">
        <label>Find another sample<input autoFocus value={sampleQuery} onChange={(event) => setSampleQuery(event.target.value)} placeholder="Code, title, or location" /></label>
        <div>{availableResults.length ? availableResults.map((result) => <button type="button" key={result.id} onClick={() => addVisibleSample(result.id)}><strong>{result.code}</strong><span>{result.title}</span><small>{result.location || "No location"}</small></button>) : <p className="muted">No samples to add.</p>}</div>
      </div>}

      {sample.runs.length > 0 && <div className="run-selector card"><label>Run<select value={selectedRun?.id || ""} onChange={(event) => updateSearchParams({ run: event.target.value })}>{sample.runs.map((run) => <option key={run.id} value={run.id}>{run.status === "active" ? "Active" : run.status} · {run.templateName} v{run.templateVersion} · run {run.sequenceNo}</option>)}</select></label>{!selectedIsActive && <span>This completed run is read-only.</span>}</div>}

      {(!selectedRun || selectedIsActive) && <div className="card assign-template"><div><strong>{activeRun ? `Update the active plan for ${sample.code}` : `Start processing ${sample.code}`}</strong><small>{activeRun ? `Only another version of ${activeRun.templateName} can reconcile unfinished work. Completed history is protected.` : sample.runs.length ? "Starts a successor run connected to the last actual step." : "Starts the first run for this physical sample."}</small></div><select value={templateVersionId} onChange={(event) => setTemplateVersionId(event.target.value)}><option value="">{activeRun ? "Choose another version of this workflow…" : "Choose process, module, or recipe…"}</option>{assignableTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.templateType} v{template.version} · {template.stepCount} steps</option>)}</select><button className="button" disabled={!templateVersionId || assigning || Boolean(activeRun && !planPreview?.compatible)} onClick={() => void (activeRun ? updatePlan() : assignTemplate())}>{assigning ? "Saving…" : activeRun ? "Apply plan update" : sample.runs.length ? "Start successor run" : "Assign"}</button>{activeRun && planPreview && <small className={planPreview.compatible ? "muted" : "error-text"}>{planPreview.compatible ? `${planPreview.preservedCount} linked · ${planPreview.additionCount} new · ${planPreview.supersededCount} replaced` : "This version conflicts with executed history and cannot be applied in place."}</small>}</div>}

      {selectedRun ? <section className="runs-section"><MultiSampleRunGrid key={`${selectedRun.id}:${samples.map((item) => item.id).join(",")}`} primaryRun={selectedRun} columns={samples.map((item) => ({ sample: item, run: item.id === sample.id ? selectedRun : item.runs.find((candidate) => candidate.recipeFamilyId === selectedRun.recipeFamilyId && candidate.status === selectedRun.status) ?? null }))} onSaved={load} readOnly={!selectedIsActive} /></section> : <div className="card empty-run-message"><h2>No assigned workflow yet</h2><p>Assign one above to start the execution grid.</p></div>}
    </section>
  </div>;
}
