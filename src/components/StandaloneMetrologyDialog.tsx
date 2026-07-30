import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { api, type MetrologyTemplateSummary } from "../lib/api";
import { DialogCloseIcon } from "./DialogCloseIcon";

interface StandaloneMetrologyDialogProps {
  sampleId: string;
  onClose: () => void;
  onStarted: (runId: string) => void | Promise<void>;
}

export function StandaloneMetrologyDialog({
  sampleId,
  onClose,
  onStarted,
}: StandaloneMetrologyDialogProps) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [templates, setTemplates] = useState<MetrologyTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingTemplateId, setStartingTemplateId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timeout = window.setTimeout(() => {
      api.listMetrologyTemplates({ query, pageSize: 50, signal: controller.signal })
        .then(({ templates: matchingTemplates }) => {
          setTemplates(matchingTemplates);
          setError("");
        })
        .catch((requestError: Error) => {
          if (requestError.name !== "AbortError") setError(requestError.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, query.trim() ? 160 : 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  async function startMetrology(templateVersionId: string) {
    setStartingTemplateId(templateVersionId);
    setError("");
    try {
      const result = await api.startMetrologyRun(sampleId, { templateVersionId });
      await onStarted(result.id);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setStartingTemplateId("");
    }
  }

  const starting = Boolean(startingTemplateId);

  return <div
    className="run-start-dialog-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !starting) onClose();
    }}
  >
    <section
      className="run-start-dialog transition-template-dialog standalone-metrology-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="run-start-dialog-heading">
        <div><p className="dialog-kicker">Independent run</p><h2 id={titleId}>Choose a metrology template</h2></div>
        <button type="button" className="drawer-close" disabled={starting} onClick={onClose} aria-label="Close"><DialogCloseIcon /></button>
      </div>
      <p className="muted">This creates a standalone result record and does not change the active fabrication process or sample structure.</p>
      <label className="search-box metrology-template-search">
        <span>Search templates</span>
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SEM, AFM, XRD…" />
      </label>
      <div className="metrology-picker-list standalone-metrology-list">
        {templates.map((template) => <button
          type="button"
          key={template.id}
          disabled={starting}
          onClick={() => void startMetrology(template.id)}
        >
          <span><strong>{template.name}</strong><small>{template.toolName || "No default tool"}</small></span>
          <span>{startingTemplateId === template.id ? "Starting…" : "Start"}</span>
        </button>)}
        {loading && !templates.length && <p className="muted">Loading metrology templates…</p>}
        {!loading && !templates.length && !error && <p className="muted">No matching metrology templates. Create one from Templates first.</p>}
      </div>
      {error && <p className="error-banner">{error}</p>}
      <div className="form-actions">
        <Link className="button" to="/templates">Manage templates</Link>
        <button type="button" className="button" disabled={starting} onClick={onClose}>Cancel</button>
      </div>
    </section>
  </div>;
}
