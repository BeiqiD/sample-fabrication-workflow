import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { SampleDetail, SampleStatus, SampleSummary } from "../../shared/types";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";
import { sampleDetailsChanged } from "../lib/entry";
import { compressCommentImage } from "../lib/images";

export function EntryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSampleId = searchParams.get("sampleId") || "";
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SampleSummary[]>([]);
  const [selected, setSelected] = useState<SampleDetail | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState("");
  const [formVersion, setFormVersion] = useState(0);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingUploadRef = useRef<{ signature: string; assetKey?: string; thumbnailKey?: string } | null>(null);

  useEffect(() => {
    if (!initialSampleId) return;
    api.getSample(initialSampleId).then((sample) => {
      setSelected(sample);
      setExpectedUpdatedAt(sample.updatedAt);
      setQuery(sample.code);
    }).catch((error: Error) => setError(error.message));
  }, [initialSampleId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearching(true);
      api.listSamples(query).then(({ samples }) => setResults(samples)).catch((error: Error) => setError(error.message)).finally(() => setSearching(false));
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const selectedInResults = useMemo(() => results.some((sample) => sample.id === selected?.id), [results, selected]);

  function choose(sample: SampleSummary) {
    if (dirty && !window.confirm("Discard the information currently entered and switch samples?")) return;
    setError(""); setSuccess(""); setDirty(false);
    pendingUploadRef.current = null;
    setSelected(null);
    setQuery(sample.code);
    setSearchParams({ sampleId: sample.id }, { replace: true });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    const body = String(data.get("body") || "").trim();
    const status = String(data.get("status")) as SampleStatus;
    const location = String(data.get("location") || "");
    const pinned = data.get("pinned") === "on";
    const image = fileRef.current?.files?.[0];
    const detailsChanged = sampleDetailsChanged(selected, { status, location, pinned });
    if (!body && !image && !detailsChanged) {
      setError("Enter a note, select a photo, or change sample details before saving.");
      return;
    }

    setSaving(true); setError(""); setSuccess("");
    try {
      let assetKey: string | undefined;
      let thumbnailKey: string | undefined;
      if (body || image) {
        if (image) {
          const signature = `${selected.id}:${image.name}:${image.size}:${image.lastModified}`;
          if (pendingUploadRef.current?.signature !== signature) pendingUploadRef.current = { signature };
          const pending = pendingUploadRef.current;
          if (!pending.assetKey || !pending.thumbnailKey) {
            const compressed = await compressCommentImage(image);
            if (!pending.assetKey) pending.assetKey = (await api.uploadAsset(compressed.main, compressed.main.name)).key;
            if (!pending.thumbnailKey) pending.thumbnailKey = (await api.uploadAsset(compressed.thumbnail, compressed.thumbnail.name)).key;
          }
          assetKey = pending.assetKey;
          thumbnailKey = pending.thumbnailKey;
        }
      }
      await api.createRecord(selected.id, {
        status, location, pinned, expectedUpdatedAt, body, assetKey, thumbnailKey,
      });
      const refreshed = await api.getSample(selected.id);
      setSelected(refreshed);
      setExpectedUpdatedAt(refreshed.updatedAt);
      setDirty(false);
      pendingUploadRef.current = null;
      setFormVersion((value) => value + 1);
      setSuccess(`Saved to ${refreshed.code} at ${new Date().toLocaleTimeString()}.`);
    } catch (error) {
      setError((error as Error).message);
      const refreshed = await api.getSample(selected.id).catch(() => null);
      if (refreshed) {
        setSelected(refreshed);
        setExpectedUpdatedAt(refreshed.updatedAt);
      }
    } finally { setSaving(false); }
  }

  return <div className="page entry-page">
    <div className="page-heading">
      <div><p className="eyebrow">Bench entry</p><h1>Record information</h1><p className="lead">Choose the sample first, then record observations and current state in one place.</p></div>
      <Link className="button" to="/samples/new">New sample</Link>
    </div>
    <div className="entry-layout">
      <aside className="entry-picker">
        <label className="search-box"><span>Find sample</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Code, title, or location" /></label>
        <div className="card entry-results" aria-busy={searching}>
          {searching && <p className="muted padded">Searching…</p>}
          {!searching && results.map((sample) => <button type="button" className={`entry-result ${selected?.id === sample.id ? "selected" : ""}`} key={sample.id} onClick={() => choose(sample)}>
            <span><strong>{sample.code}</strong><small>{sample.title}</small></span><StatusPill status={sample.status} />
          </button>)}
          {!searching && !results.length && <p className="muted padded">No matching samples.</p>}
          {!searching && selected && !selectedInResults && <button type="button" className="entry-result selected" onClick={() => setQuery(selected.code)}><span><strong>{selected.code}</strong><small>{selected.title}</small></span><StatusPill status={selected.status} /></button>}
        </div>
      </aside>
      <section>
        {!selected ? <div className="card entry-empty"><h2>Select a sample</h2><p className="muted">The selected sample code remains visible during entry to reduce wrong-sample records.</p></div> : <form ref={formRef} key={`${selected.id}:${formVersion}`} className="card entry-form" onSubmit={submit} onChange={() => setDirty(true)}>
          <div className="entry-target"><div><span>Recording to</span><strong>{selected.code}</strong><p>{selected.title}</p></div><Link to={`/samples/${selected.id}`}>Open timeline ↗</Link></div>
          <label>Observation or note<textarea name="body" rows={6} placeholder="What happened, what was measured, or what should happen next?" /></label>
          <label>Photo<input ref={fileRef} name="image" type="file" accept="image/*" capture="environment" /></label>
          <fieldset><legend>Current sample state</legend><div className="entry-state-grid">
            <label>Status<select name="status" defaultValue={selected.status}><option value="active">Active</option><option value="stored">Stored</option><option value="consumed">Consumed</option><option value="lost">Lost</option></select></label>
            <label>Location<input name="location" defaultValue={selected.location || ""} placeholder="Box, lab, or tool" /></label>
          </div><label className="checkbox-label"><input name="pinned" type="checkbox" defaultChecked={selected.pinned} />Keep this sample pinned</label></fieldset>
          {error && <p className="error-banner" role="alert">{error}</p>}
          {success && <p className="success-banner" role="status">{success}</p>}
          <button className="button primary wide entry-submit" disabled={saving}>{saving ? "Saving record…" : `Save to ${selected.code}`}</button>
        </form>}
      </section>
    </div>
  </div>;
}
