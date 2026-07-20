import { useState } from "react";
import { exportAll } from "../lib/exportAll";

export function ExportPage() {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState("");

  async function startExport() {
    setExporting(true); setError(""); setProgress(null);
    try { await exportAll((completed, total) => setProgress({ completed, total })); }
    catch (error) { setError((error as Error).message); }
    finally { setExporting(false); }
  }

  return <div className="page narrow-page">
    <p className="eyebrow">Backup</p><h1>Export all data</h1>
    <p className="lead">Download a versioned ZIP containing every database table and every stored asset. Files use relative paths and contain no temporary or authentication URLs.</p>
    <section className="card export-card">
      <h2>Full system archive</h2>
      <p className="muted">Includes samples, timeline history, process runs, template versions, FabuBlox manifests and source workbooks, layer images, and comment images with thumbnails.</p>
      <button className="button primary" disabled={exporting} onClick={() => void startExport()}>{exporting ? "Building archive…" : "Download full ZIP"}</button>
      {progress && <p className="muted">Assets: {progress.completed} / {progress.total}</p>}
      {error && <p className="error-banner">{error}</p>}
    </section>
  </div>;
}
