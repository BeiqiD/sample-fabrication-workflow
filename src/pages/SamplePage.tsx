import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SampleDetail } from "../../shared/types";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";
import { exportSample } from "../lib/exportSample";
import { compressImage } from "../lib/images";

export function SamplePage() {
  const { sampleId = "" } = useParams();
  const [sample, setSample] = useState<SampleDetail | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api.getSample(sampleId).then(setSample).catch((error: Error) => setError(error.message)), [sampleId]);
  useEffect(() => { void load(); }, [load]);

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = String(data.get("body") || "").trim();
    const image = fileRef.current?.files?.[0];
    if (!body && !image) return;
    setSaving(true);
    try {
      let assetKey: string | undefined;
      if (image) {
        const compressed = await compressImage(image);
        assetKey = (await api.uploadAsset(compressed, compressed.name)).key;
      }
      await api.createEvent(sampleId, { kind: image ? "image" : "comment", body, assetKey });
      form.reset();
      await load();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  if (!sample) return <div className="page"><p>{error || "Loading sample…"}</p></div>;
  return <div className="page sample-page">
    <Link className="back-link" to="/">← Samples</Link>
    <div className="sample-header">
      <div><p className="eyebrow">{sample.code}</p><h1>{sample.title}</h1><p className="lead">{sample.description || "No description"}</p></div>
      <div className="header-actions"><StatusPill status={sample.status} /><button className="button" disabled={exporting} onClick={() => {
        setExporting(true);
        void exportSample(sample).catch((error: Error) => setError(error.message)).finally(() => setExporting(false));
      }}>{exporting ? "Exporting…" : "Export ZIP"}</button></div>
    </div>
    <div className="detail-grid">
      <aside className="card facts">
        <h2>Details</h2>
        <dl><dt>Location</dt><dd>{sample.location || "—"}</dd><dt>Parent</dt><dd>{sample.parent ? <Link to={`/samples/${sample.parent.id}`}>{sample.parent.code}</Link> : "—"}</dd><dt>Children</dt><dd>{sample.children.length ? sample.children.map((child) => <Link key={child.id} to={`/samples/${child.id}`}>{child.code}</Link>) : "—"}</dd><dt>Created</dt><dd>{new Date(sample.createdAt).toLocaleString()}</dd></dl>
      </aside>
      <section>
        <form className="card composer" onSubmit={addComment}>
          <label>Add a record<textarea name="body" rows={3} placeholder="Comment, observation, or step note…" /></label>
          <div className="composer-actions"><input ref={fileRef} name="image" type="file" accept="image/*" capture="environment" /><button className="button primary" disabled={saving}>{saving ? "Saving…" : "Add to timeline"}</button></div>
        </form>
        {error && <p className="error-banner">{error}</p>}
        <div className="timeline">
          {sample.events.map((event) => <article className="event" key={event.id}>
            <div className="event-dot" />
            <div className="event-content"><div className="event-meta"><span>{event.kind}</span><time>{new Date(event.createdAt).toLocaleString()}</time></div>{event.body && <p>{event.body}</p>}{event.assetKey && <img src={`/api/assets/${event.assetKey}`} alt={event.body || "Sample record"} loading="lazy" />}</div>
          </article>)}
        </div>
      </section>
    </div>
  </div>;
}
