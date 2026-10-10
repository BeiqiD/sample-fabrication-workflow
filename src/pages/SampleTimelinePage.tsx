import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SampleDetail, SampleEvent } from "../../shared/types";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { ReadStatus } from "../components/ReadStatus";
import { SampleTimeline } from "../components/SampleTimeline";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";
import { filterSampleHistory, sampleEventCategory, type SampleHistoryFilter } from "../lib/sampleHistory";

const historyFilters: Array<{ value: SampleHistoryFilter; label: string }> = [
  { value: "all", label: "All activity" },
  { value: "notes", label: "Notes" },
  { value: "processing", label: "Processing" },
  { value: "sample", label: "Sample changes" },
];

export function SampleTimelinePage() {
  const { sampleId = "" } = useParams();
  const [loadedSample, setSample] = useState<SampleDetail | null>(null);
  const sample = loadedSample?.id === sampleId ? loadedSample : null;
  const [filter, setFilter] = useState<SampleHistoryFilter>("all");
  const [readState, setReadState] = useState({ sampleId, loading: true, error: "" });
  const currentSource = useRef(sampleId);
  currentSource.current = sampleId;
  const readGeneration = useRef(0);
  const loading = readState.sampleId !== sampleId || readState.loading;
  const error = readState.sampleId === sampleId ? readState.error : "";
  const [recordToDelete, setRecordToDelete] = useState<SampleEvent | null>(null);
  const [assetToDelete, setAssetToDelete] = useState<SampleEvent | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (currentSource.current !== sampleId) return;
    const generation = ++readGeneration.current;
    setReadState({ sampleId, loading: true, error: "" });
    try {
      const detail = await api.getSample(sampleId);
      if (generation !== readGeneration.current || currentSource.current !== sampleId) return;
      setSample(detail);
      setReadState({ sampleId, loading: false, error: "" });
    } catch (error) {
      if (generation === readGeneration.current && currentSource.current === sampleId) {
        setReadState({ sampleId, loading: false, error: (error as Error).message });
      }
    }
  }, [sampleId]);

  useEffect(() => {
    setRecordToDelete(null);
    setAssetToDelete(null);
    setDeleteError("");
    void load();
    return () => { readGeneration.current += 1; };
  }, [load]);

  const counts = useMemo(() => {
    const result = { all: sample?.events.length ?? 0, notes: 0, processing: 0, sample: 0 };
    for (const event of sample?.events ?? []) result[sampleEventCategory(event)] += 1;
    return result;
  }, [sample]);

  async function deleteRecord() {
    if (!sample || !recordToDelete) return;
    setDeleting(true); setDeleteError("");
    try {
      await api.deleteSampleRecord(sample.id, recordToDelete.id);
      setRecordToDelete(null);
      await load();
    } catch (error) { setDeleteError((error as Error).message); }
    finally { setDeleting(false); }
  }

  async function deleteAsset() {
    if (!sample || !assetToDelete) return;
    setDeleting(true); setDeleteError("");
    try {
      await api.deleteEventAsset(sample.id, assetToDelete.id);
      setAssetToDelete(null);
      await load();
    } catch (error) { setDeleteError((error as Error).message); }
    finally { setDeleting(false); }
  }

  if (!sample) return <div className="page sample-timeline-page">
    <Link className="back-link" to={`/samples/${sampleId}`}>← Sample</Link>
    <div className="page-heading"><div><p className="eyebrow">Sample history</p><h1>Timeline</h1></div></div>
    <ReadStatus loading={loading} error={error} loadingMessage="Loading timeline…" errorTitle="Could not load timeline" onRetry={() => void load()} />
  </div>;
  const visibleEvents = filterSampleHistory(sample.events, filter);

  return <div className="page sample-timeline-page">
    <Link className="back-link" to={`/samples/${sample.id}`}>← {sample.code}</Link>
    <div className="sample-header">
      <div className="sample-header-copy">
        <p className="eyebrow">Timeline · {sample.code}</p>
        <h1>{sample.title}</h1>
        <p className="lead">The complete audit history for this sample, including normal processing, confirmations, notes, and changes.</p>
      </div>
      <div className="header-actions"><StatusPill status={sample.status} /><Link className="button" to={`/samples/${sample.id}`}>Open sample</Link></div>
    </div>
    <ReadStatus loading={loading} error={error} loadingMessage="Loading timeline…" errorTitle="Could not load timeline" onRetry={() => void load()} />

    {!loading && !error && <><div className="timeline-page-toolbar">
      <div className="segmented-control timeline-filters" aria-label="Timeline filters">
        {historyFilters.map((option) => <button
          type="button"
          className={filter === option.value ? "selected" : ""}
          aria-pressed={filter === option.value}
          onClick={() => setFilter(option.value)}
          key={option.value}
        >{option.label}<span>{counts[option.value]}</span></button>)}
      </div>
      <p>{visibleEvents.length} {visibleEvents.length === 1 ? "entry" : "entries"}</p>
    </div>

    <section className="card timeline-page-card">
      {visibleEvents.length || !sample.events.length ? <SampleTimeline
        events={visibleEvents}
        onDeleteRecord={(event) => { setDeleteError(""); setRecordToDelete(event); }}
        onDeleteAsset={(event) => { setDeleteError(""); setAssetToDelete(event); }}
      /> : <p className="muted timeline-empty">No {filter === "notes" ? "notes" : filter === "processing" ? "processing activity" : "sample changes"} in this timeline. Choose All activity to see the complete history.</p>}
    </section></>}

    {recordToDelete && <ConfirmDeleteDialog
      title="Delete this sample note?"
      description="The note will disappear from Notes & observations, while the Timeline will retain a deletion audit entry."
      summary={recordToDelete.body?.trim() || (recordToDelete.assetKey ? "Photo observation" : "Empty note")}
      deleting={deleting}
      error={deleteError}
      eyebrow="Delete note"
      confirmLabel="Delete note"
      onCancel={() => { setRecordToDelete(null); setDeleteError(""); }}
      onConfirm={() => void deleteRecord()}
    />}
    {assetToDelete && <ConfirmDeleteDialog
      title="Delete this image attachment?"
      description="The image will be detached from its source record. The Timeline will retain a text-only audit entry."
      summary={assetToDelete.body?.trim() || "Image attachment"}
      deleting={deleting}
      error={deleteError}
      eyebrow="Delete image"
      confirmLabel="Delete image"
      onCancel={() => { setAssetToDelete(null); setDeleteError(""); }}
      onConfirm={() => void deleteAsset()}
    />}
  </div>;
}
