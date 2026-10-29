import { useEffect, useRef, useState } from "react";
import { exportAll } from "../lib/exportAll";
import type { FullExportProgress } from "../lib/full-export-safety";
import { settingsDestinations } from "../lib/settingsDestinations";
import "../settings-tasks.css";

type PreparedArchive = {
  url: string;
  filename: string;
  packaged: number;
  total: number;
  warningCount: number;
};

export function ExportPage() {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [stageProgress, setStageProgress] = useState<FullExportProgress | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<PreparedArchive | null>(null);
  const archiveUrl = useRef<string | null>(null);
  const requestId = useRef(0);
  const busy = useRef(false);
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => {
    requestId.current += 1;
    active.current?.abort(); active.current = null;
    if (archiveUrl.current) URL.revokeObjectURL(archiveUrl.current);
    archiveUrl.current = null;
  }, []);

  function cancelExport() {
    requestId.current += 1;
    active.current?.abort(); active.current = null; busy.current = false;
    setExporting(false); setProgress(null); setStageProgress(null); setError("");
    setMessage("Export cancelled. You can start another export.");
  }

  async function startExport() {
    if (busy.current) return;
    busy.current = true;
    const request = ++requestId.current;
    const controller = new AbortController(); active.current = controller;
    if (archiveUrl.current) URL.revokeObjectURL(archiveUrl.current);
    archiveUrl.current = null;
    setExporting(true); setError(""); setMessage(""); setProgress(null); setStageProgress(null); setPrepared(null);
    try {
      const result = await exportAll((completed, total) => {
        if (requestId.current === request && !controller.signal.aborted) setProgress({ completed, total });
      }, { signal: controller.signal, onStageProgress: value => {
        if (requestId.current === request && !controller.signal.aborted) setStageProgress(value);
      } });
      // A completed build must not start a download after the page was left.
      if (requestId.current !== request || controller.signal.aborted) return;
      const url = URL.createObjectURL(result.archive);
      archiveUrl.current = url;
      setPrepared({ url, filename: result.filename, total: result.results.length,
        packaged: result.results.filter((entry) => entry.outcome === "packaged").length,
        warningCount: result.warnings.length });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.append(anchor);
      try { anchor.click(); }
      catch { setError("The automatic download could not start. Use the download link below."); }
      finally { anchor.remove(); }
    } catch (error) {
      if (requestId.current === request) {
        if (controller.signal.aborted || error instanceof Error && error.name === "AbortError") setMessage("Export cancelled. You can start another export.");
        else setError(error instanceof Error ? error.message : "Full export failed.");
      }
    } finally {
      if (requestId.current === request) {
        busy.current = false;
        active.current = null;
        setExporting(false);
      }
    }
  }

  const phaseText = stageProgress?.stage === "preparing" ? "Preparing export manifest…"
    : stageProgress?.stage === "reading" ? `Reading attachments: ${stageProgress.completed} / ${stageProgress.total} processed; ${(stageProgress.bytesRead / 1_000_000).toFixed(1)} MB read…`
      : stageProgress?.stage === "verifying" ? `Verifying attachments: ${stageProgress.completed} / ${stageProgress.total} processed…`
        : stageProgress?.stage === "compressing" ? `Compressing archive… ${Math.round(stageProgress.percent ?? 0)}%`
          : progress ? `Assets processed: ${progress.completed} / ${progress.total}. Building archive…` : "Building archive…";

  return <div className="page export-page">
    <div className="page-heading"><div><h1>{settingsDestinations.archive.label}</h1>
      <p className="lead">Download a versioned ZIP of samples, Projects, process records and available files.</p></div></div>
    <section className="card export-card">
      <h2 className="card-title">Build a browser archive</h2>
      <p className="muted">Keep this page open while building the archive. Leaving cancels the export and releases any prepared download.</p>
      <button className="button primary" disabled={exporting} onClick={() => void startExport()}>{exporting ? "Building archive…" : "Download full ZIP"}</button>
      {exporting && <button className="button" onClick={cancelExport}>Cancel export</button>}
      {exporting && <p className="muted" role="status">{phaseText}</p>}
      {message && <p className="muted" role="status">{message}</p>}
      {prepared && <div>
        <p role="status">Archive ready. Assets included: {prepared.packaged} / {prepared.total}.</p>
        {prepared.warningCount > 0 && <p className="warning-card" role="status">
          {prepared.warningCount} asset{prepared.warningCount === 1 ? " was" : "s were"} not included. The database backup is included; see export-warnings.json in the ZIP for details.
        </p>}
        <a className="button" href={prepared.url} download={prepared.filename}>Download prepared ZIP</a>
        <p className="muted">If the automatic download did not start, use this link to download the same archive. It remains available until you build another archive or leave this page.</p>
      </div>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      <details className="settings-task-details export-archive-details"><summary>Archive contents and limits</summary>
        <p className="muted">System storage configuration and credentials are excluded. Missing or unavailable files are recorded as warnings without discarding the content backup.</p>
        <p className="muted">Includes samples, timeline history, process runs, template versions, FabuBlox manifests and source workbooks, layer images, comment files, final blob outcomes, and export warnings.</p>
        <p className="muted">Browser export limits: 50 MB of asset bytes, 8 MB of metadata and a 64 MB ZIP. Exceeding a limit stops the export. For larger backups, use a configured system backup workflow.</p>
        <p><a href={settingsDestinations.recovery.to}>System backup and recovery</a> provides administrator-managed, durable backup jobs and isolated installation recovery.</p>
      </details>
    </section>
  </div>;
}
