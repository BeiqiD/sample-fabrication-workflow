import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DEFAULT_SAMPLE_STATUS, SAMPLE_CREATION_STATUSES, SAMPLE_STATUS_LABELS, type SampleStatus } from "../../shared/types";
import { api } from "../lib/api";
import "../sample-identity-form.css";

export function NewSamplePage() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    try {
      const { id } = await api.createSample({
        code: String(form.get("code")),
        title: String(form.get("title")),
        description: String(form.get("description")),
        location: String(form.get("location")),
        status: String(form.get("status")) as SampleStatus,
      });
      navigate(`/samples/${id}`);
    } catch (error) {
      setError((error as Error).message);
      setSaving(false);
    }
  }

  return <div className="page form-page">
    <p className="eyebrow">Samples</p><h1>New sample</h1>
    <form className="card form-grid sample-identity-form" onSubmit={submit} aria-busy={saving}>
      <label>Sample code<input name="code" required disabled={saving} placeholder="e.g. SOD-2026-014" /></label>
      <label>Sample name<input name="title" required disabled={saving} placeholder="What is this sample?" /></label>
      <label>Status<select name="status" defaultValue={DEFAULT_SAMPLE_STATUS} disabled={saving}>{SAMPLE_CREATION_STATUSES.map((status) => <option value={status} key={status}>{SAMPLE_STATUS_LABELS[status]}</option>)}</select></label>
      <label>Location<input name="location" disabled={saving} placeholder="Box, lab, or tool" /></label>
      <label>Description<textarea name="description" rows={5} disabled={saving} placeholder="Optional starting context" /></label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {saving && <p className="visually-hidden" role="status">Creating sample…</p>}
      <div className="form-actions"><Link to="/samples" className="button" aria-disabled={saving} tabIndex={saving ? -1 : undefined} onClick={(event) => { if (saving) event.preventDefault(); }}>Cancel</Link><button className="button primary" disabled={saving}>{saving ? "Creating…" : "Create sample"}</button></div>
    </form>
  </div>;
}
