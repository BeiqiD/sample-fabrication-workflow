import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export function NewSamplePage() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const { id } = await api.createSample({
        code: String(form.get("code")),
        title: String(form.get("title")),
        description: String(form.get("description")),
        location: String(form.get("location")),
      });
      navigate(`/samples/${id}`);
    } catch (error) {
      setError((error as Error).message);
      setSaving(false);
    }
  }

  return <div className="page form-page">
    <p className="eyebrow">Samples</p><h1>New sample</h1>
    <form className="card form-grid" onSubmit={submit}>
      <label>Sample code<input name="code" required placeholder="e.g. SOD-2026-014" /></label>
      <label>Short title<input name="title" required placeholder="What is this sample?" /></label>
      <label>Current location<input name="location" placeholder="Box, lab, or tool" /></label>
      <label>Description<textarea name="description" rows={5} placeholder="Optional starting context" /></label>
      {error && <p className="error-banner">{error}</p>}
      <div className="form-actions"><Link to="/" className="button">Cancel</Link><button className="button primary" disabled={saving}>{saving ? "Creating…" : "Create sample"}</button></div>
    </form>
  </div>;
}
