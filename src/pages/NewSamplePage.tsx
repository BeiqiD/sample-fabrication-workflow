import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { SampleDetail } from "../../shared/types";
import { api } from "../lib/api";

export function NewSamplePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const parentId = searchParams.get("parentId") || "";
  const [parent, setParent] = useState<SampleDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (parentId) api.getSample(parentId).then(setParent).catch((error: Error) => setError(error.message));
  }, [parentId]);

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
        parentId: parentId || undefined,
      });
      navigate(`/samples/${id}`);
    } catch (error) {
      setError((error as Error).message);
      setSaving(false);
    }
  }

  return <div className="page form-page">
    <p className="eyebrow">Samples</p><h1>{parentId ? "New child sample" : "New sample"}</h1>
    {parentId && <div className="card parent-context"><span>Parent sample</span><strong>{parent ? `${parent.code} · ${parent.title}` : "Loading parent…"}</strong></div>}
    <form className="card form-grid" onSubmit={submit}>
      <label>Sample code<input name="code" required placeholder="e.g. SOD-2026-014" /></label>
      <label>Short title<input name="title" required placeholder="What is this sample?" /></label>
      <label>Current location<input name="location" placeholder="Box, lab, or tool" /></label>
      <label>Description<textarea name="description" rows={5} placeholder="Optional starting context" /></label>
      {error && <p className="error-banner">{error}</p>}
      <div className="form-actions"><Link to={parentId ? `/samples/${parentId}` : "/"} className="button">Cancel</Link><button className="button primary" disabled={saving || Boolean(parentId && !parent)}>{saving ? "Creating…" : "Create sample"}</button></div>
    </form>
  </div>;
}
