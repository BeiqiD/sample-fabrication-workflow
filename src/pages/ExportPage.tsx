import { useEffect, useRef, useState } from "react";
import { exportAll } from "../lib/exportAll";

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
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<PreparedArchive | null>(null);
  const archiveUrl = useRef<string | null>(null);
  const requestId = useRef(0);
  const busy = useRef(false);

  useEffect(() => () => {
    requestId.current += 1;
    if (archiveUrl.current) URL.revokeObjectURL(archiveUrl.current);
    archiveUrl.current = null;
  }, []);

  async function startExport() {
    if (busy.current) return;
    busy.current = true;
    const request = ++requestId.current;
    if (archiveUrl.current) URL.revokeObjectURL(archiveUrl.current);
    archiveUrl.current = null;
    setExporting(true); setError(""); setProgress(null); setPrepared(null);
    try {
      const result = await exportAll((completed, total) => {
        if (requestId.current === request) setProgress({ completed, total });
      });
      // A completed build must not start a download after the page was left.
      if (requestId.current !== request) return;
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
      if (requestId.current === request) setError(error instanceof Error ? error.message : "Full export failed.");
    } finally {
      if (requestId.current === request) {
        busy.current = false;
        setExporting(false);
      }
    }
  }

  return <div className="page export-page">
    <p className="eyebrow">Backup</p><h1>Export all data</h1>
    <p className="lead">Download a versioned ZIP containing every database table and every available stored asset. Missing or unavailable bytes are recorded as warnings without discarding the database backup.</p>
    <section className="card export-card">
      <h2 className="card-title">Full system archive</h2>
      <p className="muted">Includes samples, timeline history, process runs, template versions, FabuBlox manifests and source workbooks, layer images, comment files, final blob outcomes, and export warnings.</p>
      <button className="button primary" disabled={exporting} onClick={() => void startExport()}>{exporting ? "Building archive…" : "Download full ZIP"}</button>
      {exporting && progress && <p className="muted" role="status">Assets processed: {progress.completed} / {progress.total}. Building archive…</p>}
      {prepared && <div>
        <p role="status">Archive ready. Assets included: {prepared.packaged} / {prepared.total}.</p>
        {prepared.warningCount > 0 && <p className="warning-card" role="status">
          {prepared.warningCount} asset{prepared.warningCount === 1 ? " was" : "s were"} not included. The database backup is included; see export-warnings.json in the ZIP for details.
        </p>}
        <a className="button" href={prepared.url} download={prepared.filename}>Download prepared ZIP</a>
        <p className="muted">If the automatic download did not start, use this link to download the same archive. It remains available until you build another archive or leave this page.</p>
      </div>}
      {error && <p className="error-banner" role="alert">{error}</p>}
    </section>
  </div>;
}
