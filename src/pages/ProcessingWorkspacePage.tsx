import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { PlanUpdatePreview, ProcessingSampleDetail, RunStartPreview, SampleSummary } from "../../shared/types";
import { MultiSampleRunGrid } from "../components/MultiSampleRunGrid";
import { StartProcessRunDialog } from "../components/StartProcessRunDialog";
import { StatusPill } from "../components/StatusPill";
import { api, type TemplateRecord } from "../lib/api";

const MAX_VISIBLE_SAMPLES = 8;

function processRunStatus(status: ProcessingSampleDetail["runs"][number]["status"]) {
  if (status === "complete") return "Completed";
  if (status === "cancelled") return "Cancelled";
  if (status === "superseded") return "Superseded";
  return "Active";
}

export function ProcessingWorkspacePage() {
  const { sampleId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const additionalKey = searchParams.get("with") || "";
  const requestedRunId = searchParams.get("run") || "";
  const requestedAction = searchParams.get("action") || "";
  const additionalIds = additionalKey.split(",").map((id) => id.trim()).filter((id, index, ids) => id && id !== sampleId && ids.indexOf(id) === index).slice(0, MAX_VISIBLE_SAMPLES - 1);
  const [samples, setSamples] = useState<ProcessingSampleDetail[]>([]);
  const sample = samples.find((item) => item.id === sampleId) || null;
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [templateVersionId, setTemplateVersionId] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [planPreview, setPlanPreview] = useState<PlanUpdatePreview | null>(null);
  const [runStartPreview, setRunStartPreview] = useState<RunStartPreview | null>(null);
  const [runStartError, setRunStartError] = useState("");
  const [transitionMode, setTransitionMode] = useState<"start" | "update" | "reopen" | null>(null);
  const [showSamplePicker, setShowSamplePicker] = useState(false);
  const [sampleQuery, setSampleQuery] = useState("");
  const [sampleResults, setSampleResults] = useState<SampleSummary[]>([]);
  const [showMetrologyPicker, setShowMetrologyPicker] = useState(false);
  const [metrologyQuery, setMetrologyQuery] = useState("");
  const [startingMetrologyId, setStartingMetrologyId] = useState("");

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
  useEffect(() => {
    const controller = new AbortController();
    api.listTemplates(controller.signal).then(({ templates }) => setTemplates(templates)).catch((error: Error) => {
      if (error.name !== "AbortError") setError(error.message);
    });
    return () => controller.abort();
  }, []);
  const activeRun = sample?.runs.find((run) => run.runKind === "process" && run.status === "active") ?? null;
  const selectedRun = sample?.runs.find((run) => run.id === requestedRunId) ?? activeRun ?? sample?.runs[0] ?? null;

  useEffect(() => {
    if (!sample || requestedAction !== "start" || activeRun || transitionMode) return;
    setTransitionMode("start");
    setTemplateVersionId("");
    setPlanPreview(null);
    setRunStartPreview(null);
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    setSearchParams(next, { replace: true });
  }, [sample, requestedAction, activeRun, transitionMode, searchParams, setSearchParams]);

  useEffect(() => {
    setPlanPreview(null);
    setRunStartError("");
    const targetRun = transitionMode === "update" ? activeRun : transitionMode === "reopen" ? selectedRun : null;
    if (!sample || !targetRun || !templateVersionId) return;
    api.previewPlanUpdate(sample.id, targetRun.id, templateVersionId).then(setPlanPreview).catch((error: Error) => setRunStartError(error.message));
  }, [sample, activeRun, selectedRun, templateVersionId, transitionMode]);

  useEffect(() => {
    if (!showSamplePicker) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      api.listSamples({ query: sampleQuery, pageSize: 20, signal: controller.signal })
        .then(({ samples }) => setSampleResults(samples))
        .catch((error: Error) => {
          if (error.name !== "AbortError") setError(error.message);
        });
    }, sampleQuery.trim() ? 160 : 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
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

  async function beginProcessRun() {
    if (!templateVersionId) return;
    setAssigning(true); setError("");
    try {
      const preview = await api.previewRunStart(sampleId, templateVersionId);
      setRunStartPreview(preview);
      setRunStartError("");
    } catch (error) { setRunStartError((error as Error).message); }
    finally { setAssigning(false); }
  }

  async function confirmProcessTransition() {
    if (!templateVersionId || !runStartPreview || !transitionMode) return;
    setAssigning(true); setRunStartError("");
    try {
      const currentPlanRevisionId = (transitionMode === "update" ? activeRun : selectedRun)?.currentPlanRevisionId;
      const substrateConfirmation = {
        confirmed: true as const,
        expectedSampleUpdatedAt: runStartPreview.sampleUpdatedAt,
        expectedPreviousStateHash: runStartPreview.sampleCurrentState.hash,
        expectedTemplateInitialStateHash: runStartPreview.template.initialStateHash,
        expectedLatestRunId: runStartPreview.expectedLatestRunId,
        ...((transitionMode === "update" || transitionMode === "reopen") && currentPlanRevisionId
          ? { expectedCurrentPlanRevisionId: currentPlanRevisionId }
          : {}),
      };
      if (transitionMode === "start") {
        const result = await api.startProcessRun(sampleId, { templateVersionId, substrateConfirmation });
        updateSearchParams({ run: result.id });
      } else {
        const targetRun = transitionMode === "update" ? activeRun : selectedRun;
        if (!targetRun || !planPreview?.compatible) return;
        await api.applyPlanUpdate(sampleId, targetRun.id, { templateVersionId, substrateConfirmation });
        updateSearchParams({ run: targetRun.id });
      }
      setRunStartPreview(null);
      setTransitionMode(null);
      setTemplateVersionId("");
      setPlanPreview(null);
      await load();
    } catch (error) { setRunStartError((error as Error).message); }
    finally { setAssigning(false); }
  }

  async function finishActiveRun() {
    if (!sample || !activeRun) return;
    if (!window.confirm("Finish this process run? Its execution history and initial substrate snapshot will become read-only.")) return;
    setAssigning(true); setError("");
    try {
      await api.finishProcessRun(sample.id, activeRun.id, { expectedSampleUpdatedAt: sample.updatedAt });
      setTemplateVersionId("");
      await load();
    } catch (error) { setError((error as Error).message); }
    finally { setAssigning(false); }
  }

  async function startMetrology(templateVersionId: string) {
    setStartingMetrologyId(templateVersionId); setError("");
    try {
      const result = await api.startMetrologyRun(sampleId, { templateVersionId });
      setShowMetrologyPicker(false);
      setMetrologyQuery("");
      updateSearchParams({ run: result.id });
      await load();
    } catch (error) { setError((error as Error).message); }
    finally { setStartingMetrologyId(""); }
  }

  function openTransition(mode: "start" | "update" | "reopen") {
    setTransitionMode(mode);
    setTemplateVersionId("");
    setPlanPreview(null);
    setRunStartPreview(null);
    setRunStartError("");
    setError("");
  }

  if (!sample) return <div className="page"><p>{error || "Loading processing workspace…"}</p></div>;
  const includedIds = new Set(samples.map((item) => item.id));
  const availableResults = sampleResults.filter((result) => !includedIds.has(result.id));
  const transitionTargetRun = transitionMode === "update" ? activeRun : transitionMode === "reopen" ? selectedRun : null;
  const processTemplates = templates.filter((template) => template.templateKind === "process");
  const metrologyTemplates = templates.filter((template) => template.templateKind === "metrology");
  const visibleMetrologyTemplates = metrologyTemplates.filter((template) =>
    `${template.name} ${template.toolName || ""}`.toLowerCase().includes(metrologyQuery.trim().toLowerCase()));
  const assignableTemplates = transitionTargetRun
    ? processTemplates.filter((template) => template.recipeFamilyId === transitionTargetRun.recipeFamilyId && template.version > transitionTargetRun.templateVersion)
    : processTemplates;
  const selectedIsActive = selectedRun?.status === "active";
  const selectedIsActiveProcess = selectedRun?.runKind === "process" && selectedIsActive;
  const selectedRunIsEditable = selectedIsActive
    || (selectedRun?.runKind === "metrology" && selectedRun.status === "complete");
  const processRuns = sample.runs.filter((run) => run.runKind === "process");
  const selectedIsLatestProcess = selectedRun?.runKind === "process" && selectedRun.id === processRuns[0]?.id;
  const unfinishedCurrentSteps = activeRun?.steps.filter((step) =>
    step.entryKind === "fabrication" && step.planStatus === "current"
      && step.status !== "done" && step.status !== "skipped") ?? [];

  return <div className="page processing-workspace-page sample-page">
    <Link className="back-link" to="/processing">← Processing</Link>
    <div className="sample-header">
      <div className="sample-header-copy"><p className="eyebrow">Processing · {sample.code}</p><h1>{sample.title}</h1><p className="lead">Execute the selected run; sample metadata and the permanent timeline stay in the sample archive.</p></div>
      <div className="header-actions"><StatusPill status={sample.status} /><Link className="button" to={`/samples/${sample.id}`}>Open sample</Link></div>
    </div>
    {error && <p className="error-banner">{error}</p>}

    <section className="execution-workspace">
      <div className="execution-heading">
        <div><h2>Samples in this view</h2><p>Use checked columns for common confirmation and comments. Every correction remains sample-specific.</p></div>
        <button className="button primary" disabled={samples.length >= MAX_VISIBLE_SAMPLES || !selectedRunIsEditable} onClick={() => setShowSamplePicker((value) => !value)}>+ Add sample</button>
      </div>
      <div className="visible-samples">
        {samples.map((item, index) => <div className="visible-sample" key={item.id}><strong>{item.title}</strong><small>{item.code}</small>{index > 0 && <button type="button" aria-label={`Remove ${item.title} (${item.code}) from view`} onClick={() => removeVisibleSample(item.id)}>×</button>}</div>)}
      </div>
      {showSamplePicker && <div className="card sample-picker-popover">
        <label>Find another sample<input autoFocus value={sampleQuery} onChange={(event) => setSampleQuery(event.target.value)} placeholder="Search samples…" /></label>
        <div>{availableResults.length ? availableResults.map((result) => <button type="button" key={result.id} onClick={() => addVisibleSample(result.id)}><strong>{result.code}</strong><span>{result.title}</span><small>{result.location || "No location"}</small></button>) : <p className="muted">No samples to add.</p>}</div>
      </div>}

      {sample.runs.length > 0 && (sample.runs.length > 1
        ? <div className="run-selector card"><label>Viewing run<select value={selectedRun?.id || ""} onChange={(event) => updateSearchParams({ run: event.target.value })}>{sample.runs.map((run) => <option key={run.id} value={run.id}>{run.runKind === "metrology" ? "Metrology" : "Process"} {run.sequenceNo} · {run.templateName}{run.runKind === "process" ? ` v${run.templateVersion}` : ""} · {processRunStatus(run.status)}</option>)}</select></label>{!selectedIsActive && <span>{processRunStatus(selectedRun?.status || "complete")} · {selectedRunIsEditable ? "results editable" : "read-only"}</span>}</div>
        : selectedRun && <div className="run-viewing-card card"><div><p className="card-label">{selectedRun.runKind === "metrology" ? "Metrology run" : "Process run"}</p><h3 className="card-title">Run {selectedRun.sequenceNo} · {selectedRun.templateName}{selectedRun.runKind === "process" ? ` v${selectedRun.templateVersion}` : ""}</h3></div><span className={`run-status run-status-${selectedRun.status}`}>{processRunStatus(selectedRun.status)}</span></div>)}

      <div className="run-workflow-actions card">
        <div><h3 className="card-title">Run actions</h3><p className="card-context">{selectedRun ? `Run ${selectedRun.sequenceNo} · ${selectedRun.templateName}` : "No run yet"}</p><p className="card-meta">{selectedRun?.runKind === "metrology" ? selectedIsActive ? "This metrology run completes when its record is marked Done; its results remain editable afterwards." : selectedRun.status === "complete" ? "The measurement is complete, but results, parameters, comments, and attachments remain editable for post-processing." : `This ${processRunStatus(selectedRun.status).toLowerCase()} metrology run remains read-only.` : selectedIsActiveProcess ? "Update only future work, or finish this processing stage." : selectedRun ? "This completed process run remains read-only unless it is the latest process run and is explicitly reopened." : "Start fabrication from a process template, or run metrology independently."}</p></div>
        <div className="run-workflow-buttons">
          {selectedIsActiveProcess && <button type="button" className="button" onClick={() => openTransition("update")}>Update future plan</button>}
          {selectedIsActiveProcess && <button type="button" className="button" disabled={assigning || unfinishedCurrentSteps.length > 0} title={unfinishedCurrentSteps.length ? "Complete or skip every current fabrication step first" : "Finish this run"} onClick={() => void finishActiveRun()}>Finish run</button>}
          {!activeRun && selectedRun?.status === "complete" && selectedIsLatestProcess && <button type="button" className="button" onClick={() => openTransition("reopen")}>Reopen with updated template</button>}
          {!activeRun && <button type="button" className="button primary" onClick={() => openTransition("start")}>{processRuns.length ? "Start new process" : "Start first process"}</button>}
          <button type="button" className="button" onClick={() => setShowMetrologyPicker(true)}>Start metrology</button>
          {activeRun && !selectedIsActiveProcess && <button type="button" className="button" onClick={() => updateSearchParams({ run: activeRun.id })}>View active process</button>}
        </div>
      </div>

      {selectedRun ? <section className="runs-section"><MultiSampleRunGrid key={`${selectedRun.id}:${samples.map((item) => item.id).join(",")}`} primaryRun={selectedRun} columns={samples.map((item) => ({ sample: item, run: item.id === sample.id ? selectedRun : item.runs.find((candidate) => candidate.runKind === selectedRun.runKind && candidate.recipeFamilyId === selectedRun.recipeFamilyId && candidate.status === selectedRun.status) ?? null }))} onSaved={load} readOnly={!selectedRunIsEditable} /></section> : <div className="card empty-run-message"><h3 className="card-title">No run yet</h3><p>Start a process or an independent metrology run to create an execution record.</p></div>}
      {showMetrologyPicker && <div className="run-start-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !startingMetrologyId) setShowMetrologyPicker(false); }}>
        <section className="run-start-dialog transition-template-dialog standalone-metrology-dialog" role="dialog" aria-modal="true" aria-labelledby="standalone-metrology-title">
          <div className="run-start-dialog-heading"><div><p className="dialog-kicker">Independent run</p><h2 id="standalone-metrology-title">Choose a metrology template</h2></div><button type="button" className="drawer-close" disabled={Boolean(startingMetrologyId)} onClick={() => setShowMetrologyPicker(false)} aria-label="Close">×</button></div>
          <p className="muted">This creates a standalone result record and does not change the active fabrication process or sample structure.</p>
          <label className="search-box metrology-template-search"><span>Search templates</span><input autoFocus value={metrologyQuery} onChange={(event) => setMetrologyQuery(event.target.value)} placeholder="SEM, AFM, XRD…" /></label>
          <div className="metrology-picker-list standalone-metrology-list">
            {visibleMetrologyTemplates.map((template) => <button type="button" key={template.id} disabled={Boolean(startingMetrologyId)} onClick={() => void startMetrology(template.id)}>
              <span><strong>{template.name}</strong><small>{template.toolName || "No default tool"}</small></span>
              <span>{startingMetrologyId === template.id ? "Starting…" : "Start"}</span>
            </button>)}
            {!visibleMetrologyTemplates.length && <p className="muted">No matching metrology templates. Create one from Templates first.</p>}
          </div>
          <div className="form-actions"><Link className="button" to="/templates">Manage templates</Link><button type="button" className="button" disabled={Boolean(startingMetrologyId)} onClick={() => setShowMetrologyPicker(false)}>Cancel</button></div>
        </section>
      </div>}
      {transitionMode && !runStartPreview && <div className="run-start-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !assigning) setTransitionMode(null); }}>
        <section className="run-start-dialog transition-template-dialog" role="dialog" aria-modal="true" aria-labelledby="transition-template-title">
          <div className="run-start-dialog-heading"><div><p className="dialog-kicker">{transitionMode === "start" ? processRuns.length ? "Start new process" : "Start first process" : transitionMode === "reopen" ? "Reopen process run" : "Update future plan"}</p><h2 id="transition-template-title">Choose the incoming process template</h2></div><button type="button" className="drawer-close" disabled={assigning} onClick={() => setTransitionMode(null)} aria-label="Close">×</button></div>
          <p className="muted">{transitionMode === "start" ? "This creates an independent process run. Earlier runs remain completed." : "Only a newer version of the same process template can continue this run; completed steps remain frozen."}</p>
          <label className="transition-template-select">Process template<select autoFocus value={templateVersionId} onChange={(event) => { setTemplateVersionId(event.target.value); setRunStartError(""); }}><option value="">Choose a process template…</option>{assignableTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · v{template.version} · {template.stepCount} executable steps</option>)}</select></label>
          {!assignableTemplates.length && <p className="warning-card compact-warning">{transitionMode === "start" ? "No process templates are available." : "Import a newer version of this process template before updating or reopening the run."}</p>}
          {(transitionMode === "update" || transitionMode === "reopen") && planPreview && <div className={`transition-plan-summary ${planPreview.compatible ? "" : "has-conflict"}`}><strong>{planPreview.compatible ? `${planPreview.preservedCount} linked · ${planPreview.additionCount} new · ${planPreview.supersededCount} replaced` : "This version cannot be applied"}</strong><small>{planPreview.blockingReason || `${planPreview.historicalDifferences.length} historical difference${planPreview.historicalDifferences.length === 1 ? "" : "s"} retained`}</small></div>}
          {runStartError && <p className="error-banner">{runStartError}</p>}
          <div className="form-actions"><button type="button" className="button" disabled={assigning} onClick={() => setTransitionMode(null)}>Cancel</button><button type="button" className="button primary" disabled={!templateVersionId || assigning || Boolean(transitionMode !== "start" && !planPreview?.compatible)} onClick={() => void (transitionMode === "start" ? beginProcessRun() : planPreview && setRunStartPreview(planPreview.substrateTransition))}>{assigning ? "Loading…" : "Compare structures"}</button></div>
        </section>
      </div>}
      {runStartPreview && transitionMode && <StartProcessRunDialog preview={runStartPreview} action={transitionMode} starting={assigning} error={runStartError} onCancel={() => { setRunStartPreview(null); setRunStartError(""); }} onConfirm={() => void confirmProcessTransition()} />}
    </section>
  </div>;
}
