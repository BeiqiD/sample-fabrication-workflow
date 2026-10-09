import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { PlanUpdatePreview, ProcessingSampleDetail, RunStartPreview, SampleSummary } from "../../shared/types";
import { ActionIcon } from "../components/ActionIcon";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { DialogCloseIcon } from "../components/DialogCloseIcon";
import { MultiSampleRunGrid } from "../components/MultiSampleRunGrid";
import { ProcessingActionIcon } from "../components/ProcessingActionIcon";
import { ProcessingReferenceSourceFocus } from "../components/ReferenceSourceFocus";
import { ReadStatus } from "../components/ReadStatus";
import { RunActionMenu, type RunActionMenuItem } from "../components/RunActionMenu";
import { StandaloneMetrologyDialog } from "../components/StandaloneMetrologyDialog";
import { StartProcessRunDialog } from "../components/StartProcessRunDialog";
import { StatusPill } from "../components/StatusPill";
import {
  api,
  type ProcessTemplateFamilySummary,
  type ProcessTemplateVersionSummary,
} from "../lib/api";
import { correspondingRunForSelectedRun } from "../lib/correspondingRun";
import {
  availableProcessTemplateVersions,
  selectedProcessTemplateVersionId,
} from "../lib/process-template-picker";
import { sampleRunControlActionIds, sampleRunControlTitle } from "../lib/sample-run-selection";
import { useModalDialog } from "../lib/use-modal-dialog";

const MAX_VISIBLE_SAMPLES = 8;
type TransitionMode = "start" | "update" | "reopen";
type OwnedPreview<T> = { owner: string; value: T };

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
  const requestedStepId = searchParams.get("step") || "";
  const requestedFocus = searchParams.get("focus");
  const requestedAction = searchParams.get("action") || "";
  const additionalIds = additionalKey.split(",").map((id) => id.trim()).filter((id, index, ids) => id && id !== sampleId && ids.indexOf(id) === index).slice(0, MAX_VISIBLE_SAMPLES - 1);
  const readKey = JSON.stringify([sampleId, additionalKey]);
  const [loadedSamples, setSamples] = useState<ProcessingSampleDetail[]>([]);
  const [loadedReadKey, setLoadedReadKey] = useState("");
  const samples = loadedReadKey === readKey ? loadedSamples : [];
  const sample = samples.find((item) => item.id === sampleId) || null;
  const [readError, setError] = useState("");
  const [readState, setReadState] = useState({ key: readKey, loading: true });
  const currentSource = useRef(readKey);
  currentSource.current = readKey;
  const readGeneration = useRef(0);
  const loading = readState.key !== readKey || readState.loading;
  const error = readState.key === readKey ? readError : "";
  const [loadedProcessFamilies, setProcessFamilies] = useState<OwnedPreview<ProcessTemplateFamilySummary[]> | null>(null);
  const [processFamilyQuery, setProcessFamilyQuery] = useState("");
  const [selectedProcessFamilyId, setSelectedProcessFamilyId] = useState("");
  const [selectedProcessFamily, setSelectedProcessFamily] = useState<ProcessTemplateFamilySummary | null>(null);
  const [loadedProcessVersions, setProcessVersions] = useState<OwnedPreview<ProcessTemplateVersionSummary[]> | null>(null);
  const [processFamiliesLoading, setProcessFamiliesLoading] = useState(false);
  const [processVersionsLoading, setProcessVersionsLoading] = useState(false);
  const [templateSelection, setTemplateSelection] = useState<OwnedPreview<string> | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [loadedPlanPreview, setPlanPreview] = useState<OwnedPreview<PlanUpdatePreview> | null>(null);
  const [loadedRunStartPreview, setRunStartPreview] = useState<OwnedPreview<RunStartPreview> | null>(null);
  const [runStartFailure, setRunStartFailure] = useState<OwnedPreview<string> | null>(null);
  const [transition, setTransition] = useState<{ mode: TransitionMode; sampleId: string; session: number } | null>(null);
  const transitionSequence = useRef(0);
  const transitionMode = transition?.sampleId === sampleId ? transition.mode : null;
  const [startPreviewRequest, setStartPreviewRequest] = useState<{ owner: string; generation: number } | null>(null);
  const startPreviewInFlight = useRef<typeof startPreviewRequest>(null);
  const startPreviewGeneration = useRef(0);
  const previewLifetime = useRef(true);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const transitionDialogRef = useRef<HTMLElement>(null);
  const processFamilySearchRef = useRef<HTMLInputElement>(null);
  const transitionCancelRef = useRef<HTMLButtonElement>(null);
  const transitionReturnFocusRef = useRef<HTMLElement>(null);
  const returnTransitionFocus = useRef(false);
  const [showSamplePicker, setShowSamplePicker] = useState(false);
  const [sampleQuery, setSampleQuery] = useState("");
  const [sampleResults, setSampleResults] = useState<SampleSummary[]>([]);
  const [samplePickerState, setSamplePickerState] = useState({ key: "", loading: true, error: "" });
  const [samplePickerRetry, setSamplePickerRetry] = useState(0);
  const [showMetrologyPicker, setShowMetrologyPicker] = useState(false);
  const [confirmingRunFinish, setConfirmingRunFinish] = useState(false);
  const [finishRunError, setFinishRunError] = useState("");
  const [confirmingRunDelete, setConfirmingRunDelete] = useState(false);
  const [deleteRunError, setDeleteRunError] = useState("");

  const load = useCallback(async (propagateError = false) => {
    if (currentSource.current !== readKey) {
      if (propagateError) throw new Error("The processing view changed before attachment state could be refreshed.");
      return;
    }
    const generation = ++readGeneration.current;
    setReadState({ key: readKey, loading: true });
    setError("");
    try {
      const details = await Promise.all([sampleId, ...additionalIds].map((id) => api.getProcessingSample(id)));
      if (generation !== readGeneration.current || currentSource.current !== readKey) {
        if (propagateError) throw new Error("The processing view changed before attachment state could be refreshed.");
        return;
      }
      setSamples(details);
      setLoadedReadKey(readKey);
      setError("");
    } catch (error) {
      if (generation === readGeneration.current && currentSource.current === readKey) {
        setError((error as Error).message);
      }
      if (propagateError) throw error;
    } finally {
      if (generation === readGeneration.current && currentSource.current === readKey) {
        setReadState({ key: readKey, loading: false });
      }
    }
  // additionalKey is the stable URL representation of additionalIds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId, additionalKey, readKey]);

  useEffect(() => {
    void load();
    return () => { readGeneration.current += 1; };
  }, [load]);
  const activeRun = sample?.runs.find((run) => run.runKind === "process" && run.status === "active") ?? null;
  const selectedRun = sample?.runs.find((run) => run.id === requestedRunId) ?? activeRun ?? sample?.runs[0] ?? null;
  const samplePickerKey = JSON.stringify([selectedRun?.id, selectedRun?.recipeFamilyId, selectedRun?.runKind, selectedRun?.status, sampleQuery]);
  const samplePickerLoading = samplePickerState.key !== samplePickerKey || samplePickerState.loading;
  const samplePickerError = samplePickerState.key === samplePickerKey ? samplePickerState.error : "";
  const transitionTargetRun = transitionMode === "update" ? activeRun : transitionMode === "reopen" ? selectedRun : null;
  // A new opening is a new session, even when every business identifier is unchanged.
  const transitionOwner = transitionMode && sample ? JSON.stringify([
    transition?.session, sample.id, sample.updatedAt, selectedRun?.id, selectedRun?.status,
    transitionMode, transitionTargetRun?.id, transitionTargetRun?.status,
    transitionTargetRun?.currentPlanRevisionId, transitionTargetRun?.templateVersionId,
  ]) : null;
  const familiesOwner = transitionMode === "start" && transitionOwner
    ? JSON.stringify([transitionOwner, processFamilyQuery]) : null;
  const versionsFamilyId = transitionMode === "start" ? selectedProcessFamilyId : transitionTargetRun?.recipeFamilyId;
  const versionsOwner = transitionOwner
    ? JSON.stringify([transitionOwner, versionsFamilyId, transitionTargetRun?.templateVersion]) : null;
  const processFamilies = loadedProcessFamilies?.owner === familiesOwner ? loadedProcessFamilies.value : [];
  const processVersions = loadedProcessVersions?.owner === versionsOwner ? loadedProcessVersions.value : [];
  const templateVersionId = templateSelection?.owner === versionsOwner ? templateSelection.value : "";
  const previewOwner = versionsOwner && templateVersionId ? JSON.stringify([versionsOwner, templateVersionId]) : null;
  const currentPreviewOwner = useRef(previewOwner);
  currentPreviewOwner.current = previewOwner;
  const currentPickerOwners = useRef({ families: familiesOwner, versions: versionsOwner });
  currentPickerOwners.current = { families: familiesOwner, versions: versionsOwner };
  const planPreview = loadedPlanPreview?.owner === previewOwner
    && loadedPlanPreview.value.nextTemplateVersionId === templateVersionId ? loadedPlanPreview.value : null;
  const runStartPreview = loadedRunStartPreview?.owner === previewOwner
    && loadedRunStartPreview.value.template.id === templateVersionId ? loadedRunStartPreview.value : null;
  const errorOwner = previewOwner ?? transitionOwner;
  const runStartError = runStartFailure && (runStartFailure.owner === previewOwner || runStartFailure.owner === transitionOwner)
    ? runStartFailure.value : "";
  const previewLoading = startPreviewRequest !== null && startPreviewRequest.owner === previewOwner;
  const transitionBusy = assigning || previewLoading;

  function setTemplateVersionId(id: string, owner = versionsOwner) {
    setTemplateSelection(owner && id ? { owner, value: id } : null);
  }
  function setRunStartError(message: string, owner = errorOwner) {
    setRunStartFailure(owner && message ? { owner, value: message } : null);
  }
  function closeTransition() {
    currentPreviewOwner.current = null;
    returnTransitionFocus.current = true;
    setTransition(null);
    setPlanPreview(null);
    setRunStartPreview(null);
    setRunStartError("");
  }
  useModalDialog({
    dialogRef: transitionDialogRef,
    initialFocusRef: transitionMode === "start" ? processFamilySearchRef : transitionCancelRef,
    returnFocusRef: transitionReturnFocusRef,
    enabled: Boolean(sample && transitionMode && !runStartPreview),
    blocked: transitionBusy,
    onClose: closeTransition,
  });
  useEffect(() => {
    previewLifetime.current = true;
    return () => { previewLifetime.current = false; };
  }, []);
  useEffect(() => {
    if (transition && transition.sampleId !== sampleId) closeTransition();
  // The source identity, rather than a refresh of its data, closes the session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId]);
  useEffect(() => {
    const target = transitionReturnFocusRef.current;
    if (!transitionMode && !transitionBusy && returnTransitionFocus.current && target?.isConnected && !target.matches(":disabled")) {
      returnTransitionFocus.current = false;
      target.focus({ preventScroll: true });
    }
  }, [transitionMode, transitionBusy]);
  const gridColumns = useMemo(() => {
    if (!sample || !selectedRun) return [];
    return samples.map((item) => ({
      sample: item,
      run: item.id === sample.id
        ? selectedRun
        : correspondingRunForSelectedRun(selectedRun, sample.runs, item.runs),
    }));
  }, [sample, samples, selectedRun]);

  useEffect(() => {
    setShowSamplePicker(false);
    setSampleQuery("");
    setSampleResults([]);
    setConfirmingRunFinish(false);
    setFinishRunError("");
    setConfirmingRunDelete(false);
    setDeleteRunError("");
  }, [selectedRun?.id]);

  useEffect(() => {
    if (!sample || requestedAction !== "start" || activeRun || transitionMode) return;
    openTransition("start");
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    setSearchParams(next, { replace: true });
  }, [sample, requestedAction, activeRun, transitionMode, searchParams, setSearchParams]);

  useEffect(() => {
    setPlanPreview(null);
    setRunStartPreview(current => current?.owner === previewOwner ? current : null);
    if (startPreviewInFlight.current && startPreviewInFlight.current.owner !== previewOwner) {
      startPreviewInFlight.current = null;
      setStartPreviewRequest(null);
    }
    setRunStartError("");
    if (!sample || !transitionTargetRun || !templateVersionId || !previewOwner) return;
    const owner = previewOwner;
    let active = true;
    api.previewPlanUpdate(sample.id, transitionTargetRun.id, templateVersionId)
      .then(value => {
        if (active && currentPreviewOwner.current === owner) setPlanPreview({ owner, value });
      })
      .catch((error: Error) => {
        if (active && currentPreviewOwner.current === owner) setRunStartError(error.message, owner);
      });
    return () => { active = false; };
  // Stable ownership includes the sample state, selected run, plan revision and incoming version.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewOwner]);

  useEffect(() => {
    if (!showSamplePicker) return;
    if (!selectedRun) {
      setSampleResults([]);
      return;
    }
    const controller = new AbortController();
    setSamplePickerState({ key: samplePickerKey, loading: true, error: "" });
    const timeout = window.setTimeout(() => {
      api.listSamples({
        query: sampleQuery,
        pageSize: 20,
        matchingRun: {
          recipeFamilyId: selectedRun.recipeFamilyId,
          runKind: selectedRun.runKind,
          status: selectedRun.status,
        },
        signal: controller.signal,
      })
        .then(({ samples }) => {
          if (controller.signal.aborted) return;
          setSampleResults(samples);
          setSamplePickerState({ key: samplePickerKey, loading: false, error: "" });
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted && error.name !== "AbortError") {
            setSamplePickerState({ key: samplePickerKey, loading: false, error: error.message });
          }
        });
    }, sampleQuery.trim() ? 160 : 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sampleQuery, selectedRun?.recipeFamilyId, selectedRun?.runKind, selectedRun?.status, samplePickerKey, samplePickerRetry, showSamplePicker]);

  useEffect(() => {
    if (transitionMode !== "start" || !familiesOwner) return;
    const owner = familiesOwner;
    const controller = new AbortController();
    setProcessFamiliesLoading(true);
    const timeout = window.setTimeout(() => {
      api.listTemplateFamilies({ query: processFamilyQuery, pageSize: 50, signal: controller.signal })
        .then(({ families }) => {
          if (controller.signal.aborted || currentPickerOwners.current.families !== owner) return;
          setProcessFamilies({ owner, value: families });
          setRunStartError("");
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted && currentPickerOwners.current.families === owner && error.name !== "AbortError") setRunStartError(error.message, transitionOwner);
        })
        .finally(() => {
          if (!controller.signal.aborted && currentPickerOwners.current.families === owner) setProcessFamiliesLoading(false);
        });
    }, processFamilyQuery.trim() ? 160 : 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [processFamilyQuery, transitionMode, familiesOwner]);

  useEffect(() => {
    if (!transitionMode || !versionsOwner) return;
    const owner = versionsOwner;
    const familyId = versionsFamilyId;
    if (!familyId) {
      setProcessVersions(null);
      setTemplateVersionId("");
      setProcessVersionsLoading(false);
      return;
    }
    const controller = new AbortController();
    setProcessVersionsLoading(true);
    api.listTemplateFamilyVersions(familyId, { signal: controller.signal })
      .then(({ versions }) => {
        if (controller.signal.aborted || currentPickerOwners.current.versions !== owner) return;
        const availableVersions = availableProcessTemplateVersions(
          versions,
          transitionTargetRun?.templateVersion,
        );
        setProcessVersions({ owner, value: availableVersions });
        setTemplateSelection(current => ({ owner, value: selectedProcessTemplateVersionId(availableVersions, current?.owner === owner ? current.value : "") }));
        setRunStartError("");
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted && currentPickerOwners.current.versions === owner && error.name !== "AbortError") setRunStartError(error.message, transitionOwner);
      })
      .finally(() => {
        if (!controller.signal.aborted && currentPickerOwners.current.versions === owner) setProcessVersionsLoading(false);
      });
    return () => controller.abort();
  }, [
    selectedProcessFamilyId,
    transitionMode,
    transitionTargetRun?.recipeFamilyId,
    transitionTargetRun?.templateVersion,
    versionsFamilyId,
    versionsOwner,
  ]);

  function updateSearchParams(updates: { with?: string[]; run?: string }) {
    const next = new URLSearchParams(searchParams);
    if (updates.with) {
      if (updates.with.length) next.set("with", updates.with.join(",")); else next.delete("with");
    }
    if (updates.run !== undefined) {
      if (updates.run) next.set("run", updates.run); else next.delete("run");
      next.delete("step");
      next.delete("focus");
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
    const owner = previewOwner;
    if (!templateVersionId || !owner || assigning || startPreviewInFlight.current?.owner === owner) return;
    const request = { owner, generation: ++startPreviewGeneration.current };
    startPreviewInFlight.current = request;
    setStartPreviewRequest(request); setError("");
    const isCurrent = () => previewLifetime.current && currentPreviewOwner.current === owner && startPreviewInFlight.current === request;
    try {
      const preview = await api.previewRunStart(sampleId, templateVersionId);
      if (!isCurrent()) return;
      setRunStartPreview({ owner, value: preview });
      setRunStartError("", owner);
    } catch (error) { if (isCurrent()) setRunStartError((error as Error).message, owner); }
    finally {
      if (isCurrent()) { startPreviewInFlight.current = null; setStartPreviewRequest(null); }
    }
  }

  async function confirmProcessTransition() {
    if (!previewOwner || currentPreviewOwner.current !== previewOwner || !templateVersionId || !runStartPreview || !runStartPreview.canConfirm || !transitionMode
      || (transitionMode !== "start" && !planPreview?.compatible)) return;
    setAssigning(true); setRunStartError("");
    try {
      const currentPlanRevisionId = (transitionMode === "update" ? activeRun : selectedRun)?.currentPlanRevisionId;
      const substrateConfirmation = {
        confirmed: true as const,
        expectedSampleUpdatedAt: runStartPreview.sampleUpdatedAt,
        expectedPreviousStateHash: runStartPreview.sampleCurrentState.hash,
        expectedTemplateStructureKey: runStartPreview.comparisonTarget?.key ?? null,
        expectedTemplateStateHash: runStartPreview.comparisonTarget?.stateHash ?? null,
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
      closeTransition();
      setTemplateVersionId("");
      setPlanPreview(null);
      await load();
    } catch (error) { setRunStartError((error as Error).message); }
    finally { setAssigning(false); }
  }

  async function finishActiveRun() {
    if (!sample || !activeRun) return;
    setAssigning(true); setFinishRunError(""); setError("");
    try {
      await api.finishProcessRun(sample.id, activeRun.id, {
        expectedSampleUpdatedAt: sample.updatedAt,
        confirmSkipUnfinishedSteps: unfinishedCurrentSteps.length > 0,
      });
      setTemplateVersionId("");
      setConfirmingRunFinish(false);
      await load();
    } catch (error) { setFinishRunError((error as Error).message); }
    finally { setAssigning(false); }
  }

  async function deleteSelectedRun() {
    if (!sample || !selectedRun) return;
    setAssigning(true); setDeleteRunError(""); setError("");
    try {
      await api.deleteRun(sample.id, selectedRun.id, {
        expectedSampleUpdatedAt: sample.updatedAt,
      });
      const nextRun = sample.runs.find((run) => run.id !== selectedRun.id) ?? null;
      setConfirmingRunDelete(false);
      updateSearchParams({ run: nextRun?.id ?? "" });
      await load();
    } catch (error) { setDeleteRunError((error as Error).message); }
    finally { setAssigning(false); }
  }

  function openTransition(mode: TransitionMode) {
    transitionReturnFocusRef.current = workspaceRef.current?.querySelector<HTMLElement>(mode === "start"
      ? 'button[aria-label="Start run"]' : 'button[aria-label="Run actions"]') ?? null;
    returnTransitionFocus.current = false;
    setTransition({ mode, sampleId, session: ++transitionSequence.current });
    setProcessFamilyQuery("");
    setSelectedProcessFamilyId("");
    setSelectedProcessFamily(null);
    setProcessFamilies(null);
    setProcessVersions(null);
    setProcessFamiliesLoading(mode === "start");
    setProcessVersionsLoading(mode !== "start");
    setTemplateVersionId("");
    setPlanPreview(null);
    setRunStartPreview(null);
    setRunStartError("");
    setError("");
  }

  function selectProcessFamily(family: ProcessTemplateFamilySummary) {
    const owner = transitionOwner ? JSON.stringify([transitionOwner, family.recipeFamilyId, transitionTargetRun?.templateVersion]) : null;
    setSelectedProcessFamilyId(family.recipeFamilyId);
    setSelectedProcessFamily(family);
    setProcessVersions(owner ? { owner, value: [family.latest] } : null);
    setTemplateVersionId(family.latest.id, owner);
    setPlanPreview(null);
    setRunStartPreview(null);
    setRunStartError("");
  }

  if (!sample) return <div ref={workspaceRef} className="page processing-workspace-page sample-page">
    <Link className="back-link" to="/processing">← Processing</Link>
    <div className="page-heading"><div><p className="eyebrow">Cleanroom workspace</p><h1>Processing workspace</h1></div></div>
    <ReadStatus loading={loading} error={error} loadingMessage="Loading processing workspace…" errorTitle="Could not load processing workspace" onRetry={() => void load()} />
  </div>;
  const includedIds = new Set(samples.map((item) => item.id));
  const availableResults = !samplePickerLoading && !samplePickerError ? sampleResults.filter((result) => !includedIds.has(result.id)) : [];
  const selectedIsActive = selectedRun?.status === "active";
  const selectedRunIsEditable = selectedIsActive
    || (selectedRun?.runKind === "metrology" && selectedRun.status === "complete");
  const processRuns = sample.runs.filter((run) => run.runKind === "process");
  const processStartLabel = processRuns.length ? "Start new process" : "Start first process";
  const selectedRunLabel = selectedRun
    ? `${selectedRun.runKind === "metrology" ? "Metrology" : "Process"} ${selectedRun.sequenceNo} · ${selectedRun.templateName}${selectedRun.runKind === "process" ? ` v${selectedRun.templateVersion}` : ""}`
    : "No run yet";
  const selectedRunState = selectedRun
    ? `${processRunStatus(selectedRun.status)}${selectedIsActive ? "" : selectedRunIsEditable ? " · results editable" : " · read-only"}`
    : "Not started";
  const unfinishedCurrentSteps = activeRun?.steps.filter((step) =>
    step.entryKind === "fabrication" && step.planStatus === "current"
      && step.status !== "done" && step.status !== "skipped") ?? [];
  const { runActions, startActions } = sampleRunControlActionIds({
    selectedRun,
    activeProcessRun: activeRun,
    latestProcessRun: processRuns[0] ?? null,
  });
  const runActionItems: RunActionMenuItem[] = runActions.map((action) => {
    if (action === "update_plan") return {
      id: action,
      label: "Update future plan",
      icon: <ActionIcon name="plan-update" />,
      disabled: transitionBusy,
      onSelect: () => openTransition("update"),
    };
    if (action === "finish_run") return {
      id: action,
      label: "Finish run",
      description: unfinishedCurrentSteps.length
        ? `Skip ${unfinishedCurrentSteps.length} unfinished step${unfinishedCurrentSteps.length === 1 ? "" : "s"}`
        : "Complete this active run",
      icon: <ProcessingActionIcon name="done" />,
      danger: unfinishedCurrentSteps.length > 0,
      disabled: transitionBusy,
      onSelect: () => {
        setFinishRunError("");
        setConfirmingRunFinish(true);
      },
    };
    if (action === "reopen_process") return {
      id: action,
      label: "Reopen with updated template",
      icon: <ActionIcon name="plan-update" />,
      disabled: transitionBusy,
      onSelect: () => openTransition("reopen"),
    };
    if (action === "delete_run") return {
      id: action,
      label: "Delete run",
      description: "Permanently remove this run",
      icon: <ActionIcon name="delete" />,
      danger: true,
      disabled: transitionBusy,
      onSelect: () => {
        setDeleteRunError("");
        setConfirmingRunDelete(true);
      },
    };
    return {
      id: action,
      label: "View active process",
      icon: <ActionIcon name="process" />,
      disabled: transitionBusy,
      onSelect: () => activeRun && updateSearchParams({ run: activeRun.id }),
    };
  });
  const startActionItems: RunActionMenuItem[] = startActions.map((action) => action === "start_process"
    ? {
      id: action,
      label: processStartLabel,
      icon: <ActionIcon name="process" />,
      disabled: transitionBusy,
      onSelect: () => openTransition("start"),
    }
    : {
      id: action,
      label: "Start metrology",
      icon: <ActionIcon name="metrology" />,
      disabled: transitionBusy,
      onSelect: () => setShowMetrologyPicker(true),
    });

  return <div ref={workspaceRef} className="page processing-workspace-page sample-page">
    <Link className="back-link" to="/processing">← Processing</Link>
    <div className="sample-header">
      <div className="sample-header-copy"><p className="eyebrow">Processing · {sample.code}</p><h1>{sample.title}</h1><p className="lead">Execute the selected run; sample metadata and the permanent timeline stay in the sample archive.</p></div>
      <div className="header-actions"><StatusPill status={sample.status} /><Link className="button" to={`/samples/${sample.id}`}>Open sample</Link></div>
    </div>
    <ReadStatus loading={loading} error={error} loadingMessage="Loading processing workspace…" errorTitle="Could not load processing workspace" onRetry={() => void load()} />

    <section className="execution-workspace">
      <div className="execution-heading">
        <div><h2>Samples in this view</h2><p>Use checked columns for common confirmation and comments. Every correction remains sample-specific.</p></div>
        <button className="button primary" aria-expanded={showSamplePicker} aria-controls="sample-picker-popover" disabled={samples.length >= MAX_VISIBLE_SAMPLES || !selectedRunIsEditable} onClick={() => setShowSamplePicker((value) => !value)}>+ Add sample</button>
      </div>
      <div className="visible-samples">
        {samples.map((item, index) => <div className="visible-sample" key={item.id}><strong>{item.title}</strong><small>{item.code}</small>{index > 0 && <button type="button" aria-label={`Remove ${item.title} (${item.code}) from view`} onClick={() => removeVisibleSample(item.id)}>×</button>}</div>)}
      </div>
      {showSamplePicker && <div className="card sample-picker-popover" id="sample-picker-popover">
        <label>{selectedRun?.runKind === "metrology" ? "Find a sample with matching metrology" : "Find a sample assigned to this process"}<input autoFocus value={sampleQuery} onChange={(event) => setSampleQuery(event.target.value)} placeholder="Search matching samples…" /></label>
        <ReadStatus loading={samplePickerLoading} error={samplePickerError} loadingMessage="Loading matching samples…" errorTitle="Could not load matching samples" density="compact" onRetry={() => setSamplePickerRetry((value) => value + 1)} />
        {!samplePickerLoading && !samplePickerError && <div>{availableResults.length ? availableResults.map((result) => <button type="button" key={result.id} onClick={() => addVisibleSample(result.id)}><strong>{result.code}</strong><span>{result.title}</span><small>{result.location || "No location"}</small></button>) : <p className="muted">No matching samples to add.</p>}</div>}
      </div>}

      <div className="run-controls card">
        <div className="run-controls-heading">
          <h3 className="card-title run-controls-title">{sampleRunControlTitle(selectedRun?.runKind)}</h3>
          <span className={`run-status run-controls-status${selectedRun ? ` run-status-${selectedRun.status}` : ""}`}>{selectedRunState}</span>
        </div>
        <div className="run-controls-picker">
          {sample.runs.length > 1
            ? <select aria-label="Viewing run" value={selectedRun?.id || ""} onChange={(event) => updateSearchParams({ run: event.target.value })}>{sample.runs.map((run) => <option key={run.id} value={run.id}>{run.runKind === "metrology" ? "Metrology" : "Process"} {run.sequenceNo} · {run.templateName}{run.runKind === "process" ? ` v${run.templateVersion}` : ""} · {processRunStatus(run.status)}</option>)}</select>
            : <strong title={selectedRunLabel}>{selectedRunLabel}</strong>}
        </div>
        <div className="run-control-menus">
          <RunActionMenu label="Run actions" icon={<ActionIcon name="actions" />} items={runActionItems} disabled={transitionBusy} />
          <RunActionMenu label="Start run" icon={<ActionIcon name="start" />} items={startActionItems} disabled={transitionBusy} primary />
        </div>
      </div>

      {selectedRun ? <section className="runs-section">
        <MultiSampleRunGrid key={`${selectedRun.id}:${samples.map((item) => item.id).join(",")}`} primaryRun={selectedRun} columns={gridColumns} onSaved={load} onAttachmentChanged={() => load(true)} readOnly={!selectedRunIsEditable} />
        <ProcessingReferenceSourceFocus
          focusValue={requestedFocus}
          sampleId={sampleId}
          stepId={requestedStepId}
          columns={gridColumns}
        />
      </section> : <div className="card empty-run-message"><h3 className="card-title">No run yet</h3><p>Start a process or an independent metrology run to create an execution record.</p></div>}
      {showMetrologyPicker && <StandaloneMetrologyDialog
        sampleId={sampleId}
        onClose={() => setShowMetrologyPicker(false)}
        onStarted={async (runId) => {
          setShowMetrologyPicker(false);
          updateSearchParams({ run: runId });
          await load();
        }}
      />}
      {confirmingRunFinish && <ConfirmDeleteDialog
        eyebrow="Finish process run"
        title={unfinishedCurrentSteps.length
          ? `Skip ${unfinishedCurrentSteps.length} unfinished step${unfinishedCurrentSteps.length === 1 ? "" : "s"}?`
          : "Finish this process run?"}
        description={unfinishedCurrentSteps.length
          ? "Finishing now will mark every unfinished current step as skipped and complete the run."
          : "The run will be completed and its execution history will become read-only."}
        summary={`${selectedRunLabel}${unfinishedCurrentSteps.length
          ? ` · ${unfinishedCurrentSteps.length} unfinished step${unfinishedCurrentSteps.length === 1 ? "" : "s"} will be skipped`
          : ""}`}
        deleting={transitionBusy}
        error={finishRunError}
        confirmLabel={unfinishedCurrentSteps.length
          ? `Finish and skip ${unfinishedCurrentSteps.length} step${unfinishedCurrentSteps.length === 1 ? "" : "s"}`
          : "Finish run"}
        busyLabel="Finishing…"
        onCancel={() => {
          setConfirmingRunFinish(false);
          setFinishRunError("");
        }}
        onConfirm={() => void finishActiveRun()}
      />}
      {confirmingRunDelete && selectedRun && <ConfirmDeleteDialog
        eyebrow={`Delete ${selectedRun.runKind} run`}
        title={`Delete this ${selectedRun.runKind} run?`}
        description="The run and its steps, comments, attachment associations, plan revisions, and verification records will be removed. Existing timeline entries remain as read-only history; detached files follow the normal retention period before cleanup."
        summary={selectedRunLabel}
        deleting={transitionBusy}
        error={deleteRunError}
        confirmLabel="Delete run"
        busyLabel="Deleting…"
        onCancel={() => {
          setConfirmingRunDelete(false);
          setDeleteRunError("");
        }}
        onConfirm={() => void deleteSelectedRun()}
      />}
      {transitionMode && !runStartPreview && <div className="run-start-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !transitionBusy) closeTransition(); }}>
        <section ref={transitionDialogRef} className="run-start-dialog transition-template-dialog" role="dialog" aria-modal="true" aria-labelledby="transition-template-title">
          <div className="run-start-dialog-heading"><div><p className="dialog-kicker">{transitionMode === "start" ? processRuns.length ? "Start new process" : "Start first process" : transitionMode === "reopen" ? "Reopen process run" : "Update future plan"}</p><h2 id="transition-template-title">Choose the incoming process template</h2></div><button type="button" className="drawer-close" disabled={transitionBusy} onClick={closeTransition} aria-label="Close"><DialogCloseIcon /></button></div>
          <p className="muted">{transitionMode === "start" ? "This creates an independent process run. Earlier runs remain completed." : "Only a newer version of the same process template can continue this run; completed steps remain frozen."}</p>
          <div className={`process-template-picker ${transitionMode === "start" ? "" : "fixed-family"}`}>
            {transitionMode === "start" && <section className="process-template-picker-column">
              <div className="process-template-picker-heading"><small>1 · Process family</small><strong>{selectedProcessFamily?.name || "Choose a family"}</strong></div>
              <label className="search-box process-family-search"><span>Search process families</span><input ref={processFamilySearchRef} autoFocus value={processFamilyQuery} onChange={(event) => setProcessFamilyQuery(event.target.value)} placeholder="Etch, bonding, lithography…" /></label>
              <div className="template-picker-list process-family-list">
                {processFamilies.map((family) => <button type="button" className={selectedProcessFamilyId === family.recipeFamilyId ? "selected" : ""} aria-pressed={selectedProcessFamilyId === family.recipeFamilyId} key={family.recipeFamilyId} disabled={transitionBusy} onClick={() => selectProcessFamily(family)}>
                  <span><strong>{family.name}</strong><small>{family.versionCount} version{family.versionCount === 1 ? "" : "s"} · latest v{family.latestVersion}</small></span>
                  <span>{selectedProcessFamilyId === family.recipeFamilyId ? "Selected" : "Select"}</span>
                </button>)}
                {processFamiliesLoading && !processFamilies.length && <p className="muted">Loading process families…</p>}
                {!processFamiliesLoading && !processFamilies.length && <p className="muted">No matching process families.</p>}
              </div>
            </section>}
            <section className="process-template-picker-column">
              <div className="process-template-picker-heading">
                <small>{transitionMode === "start" ? "2 · Version" : "Process family · newer version"}</small>
                <strong>{transitionMode === "start" ? selectedProcessFamily?.name || "Select a family first" : transitionTargetRun?.templateName}</strong>
                {transitionTargetRun && <span>Current version · v{transitionTargetRun.templateVersion}</span>}
              </div>
              <div className="template-picker-list process-version-list">
                {processVersions.map((version) => <button type="button" className={templateVersionId === version.id ? "selected" : ""} aria-pressed={templateVersionId === version.id} key={version.id} disabled={transitionBusy} onClick={() => { setTemplateVersionId(version.id); setRunStartError(""); }}>
                  <span><strong>Version {version.version}</strong><small>{version.stepCount} executable steps{version.sourceFilename ? ` · ${version.sourceFilename}` : ""}</small></span>
                  <span>{templateVersionId === version.id ? "Selected" : "Use"}</span>
                </button>)}
                {processVersionsLoading && !processVersions.length && (transitionMode !== "start" || selectedProcessFamilyId) && <p className="muted">Loading versions…</p>}
                {!processVersionsLoading && !processVersions.length && transitionMode === "start" && !selectedProcessFamilyId && <p className="muted">Choose a process family to see its versions.</p>}
                {!processVersionsLoading && !processVersions.length && transitionMode !== "start" && <p className="muted">No newer version is available for this process family.</p>}
              </div>
            </section>
          </div>
          {!processFamiliesLoading && !processFamilies.length && !selectedProcessFamilyId && !processFamilyQuery.trim() && transitionMode === "start" && <p className="warning-card compact-warning">No process templates are available.</p>}
          {!processVersionsLoading && !processVersions.length && transitionMode !== "start" && <p className="warning-card compact-warning">Import a newer version of this process template before updating or reopening the run.</p>}
          {(transitionMode === "update" || transitionMode === "reopen") && planPreview && <div className={`transition-plan-summary ${planPreview.compatible ? "" : "has-conflict"}`}><strong>{planPreview.compatible ? `${planPreview.preservedCount} linked · ${planPreview.additionCount} new · ${planPreview.supersededCount} replaced` : "This version cannot be applied"}</strong><small>{planPreview.blockingReason || `${planPreview.skippedAdditionCount ? `${planPreview.skippedAdditionCount} inserted before the execution boundary will be skipped · ` : ""}${planPreview.historicalDifferences.length} historical difference${planPreview.historicalDifferences.length === 1 ? "" : "s"} retained`}</small></div>}
          {runStartError && <p className="error-banner">{runStartError}</p>}
          <div className="form-actions"><button ref={transitionCancelRef} type="button" className="button" disabled={transitionBusy} onClick={closeTransition}>Cancel</button><button type="button" className="button primary" disabled={!templateVersionId || transitionBusy || Boolean(transitionMode !== "start" && !planPreview?.compatible)} onClick={() => void (transitionMode === "start" ? beginProcessRun() : planPreview && previewOwner && setRunStartPreview({ owner: previewOwner, value: planPreview.substrateTransition }))}>{transitionBusy ? "Loading…" : "Compare structures"}</button></div>
        </section>
      </div>}
      {runStartPreview && transitionMode && <StartProcessRunDialog preview={runStartPreview} action={transitionMode} starting={transitionBusy} error={runStartError} onCancel={() => { setRunStartPreview(null); setRunStartError(""); }} onConfirm={() => void confirmProcessTransition()} />}
    </section>
  </div>;
}
