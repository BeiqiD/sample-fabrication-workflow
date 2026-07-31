import { type FormEvent, useState } from "react";
import type { MetrologyTemplateInput } from "../lib/api";

const EMPTY_TEMPLATE: MetrologyTemplateInput = {
  name: "",
  toolName: "",
  parametersText: "",
  commentsText: "",
};

export function MetrologyTemplateForm({
  initialValue = EMPTY_TEMPLATE,
  title,
  submitLabel,
  onSubmit,
  onCancel,
  embedded = false,
  autoFocusTitle = true,
}: {
  initialValue?: MetrologyTemplateInput;
  title: string;
  submitLabel: string;
  onSubmit: (input: MetrologyTemplateInput) => Promise<void>;
  onCancel: () => void;
  embedded?: boolean;
  autoFocusTitle?: boolean;
}) {
  const [name, setName] = useState(initialValue.name);
  const [toolName, setToolName] = useState(initialValue.toolName);
  const [parametersText, setParametersText] = useState(initialValue.parametersText);
  const [commentsText, setCommentsText] = useState(initialValue.commentsText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Template title is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit({ name, toolName, parametersText, commentsText });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return <form className={embedded ? "metrology-template-form embedded" : "card metrology-template-form"} onSubmit={save}>
    <div className="metrology-form-heading">
      <div><p className="card-label">Metrology template</p><h3 className="card-title">{title}</h3></div>
    </div>
    <label><span>Template title</span><input autoFocus={autoFocusTitle} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Raman" /></label>
    <label><span>Tool <small className="optional-label">Optional</small></span><input value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder="Instrument or tool" /></label>
    <label><span>Parameters <small className="optional-label">Optional</small></span><textarea rows={3} value={parametersText} onChange={(event) => setParametersText(event.target.value)} placeholder="Default settings, if useful" /></label>
    <label><span>Comments <small className="optional-label">Optional</small></span><textarea rows={4} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} placeholder="Default note for this record" /></label>
    {error && <p className="error-banner">{error}</p>}
    <div className="form-actions">
      <button type="button" className="button" disabled={saving} onClick={onCancel}>Cancel</button>
      <button type="submit" className="button primary" disabled={saving || !name.trim()}>{saving ? "Saving…" : submitLabel}</button>
    </div>
  </form>;
}
