import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type MetrologyTemplateSummary } from "../lib/api";
import { useModalDialog } from "../lib/use-modal-dialog";
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
  const [retry, setRetry] = useState(0);
  const readOwner = JSON.stringify([sampleId, query, retry]);
  const [readState, setReadState] = useState({ owner: readOwner, loading: true, error: "", templates: [] as MetrologyTemplateSummary[] });
  const currentReadOwner = useRef(readOwner);
  currentReadOwner.current = readOwner;
  const loading = readState.owner !== readOwner || readState.loading;
  const readError = readState.owner === readOwner ? readState.error : "";
  const templates = !loading && !readError && readState.owner === readOwner ? readState.templates : [];
  const [startingTemplateId, setStartingTemplateId] = useState("");
  const [error, setError] = useState("");
  const sessionRef = useRef<object | null>(null);
  const operationRef = useRef<object | null>(null);
  const currentSampleId = useRef(sampleId);
  currentSampleId.current = sampleId;
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const starting = Boolean(startingTemplateId);
  function close() {
    if (!operationRef.current) onClose();
  }
  useModalDialog({ dialogRef, initialFocusRef: searchRef, onClose: close, blocked: starting });

  useEffect(() => {
    const session = {};
    sessionRef.current = session;
    setStartingTemplateId("");
    setError("");
    return () => { sessionRef.current = null; operationRef.current = null; };
  }, [sampleId]);

  useEffect(() => {
    const owner = readOwner;
    const controller = new AbortController();
    setReadState({ owner, loading: true, error: "", templates: [] });
    const timeout = window.setTimeout(() => {
      api.listMetrologyTemplates({ query, pageSize: 50, signal: controller.signal })
        .then(({ templates: matchingTemplates }) => {
          if (controller.signal.aborted || currentReadOwner.current !== owner) return;
          setReadState({ owner, loading: false, error: "", templates: matchingTemplates });
        })
        .catch((requestError: Error) => {
          if (!controller.signal.aborted && currentReadOwner.current === owner && requestError.name !== "AbortError") {
            setReadState({ owner, loading: false, error: requestError.message, templates: [] });
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && currentReadOwner.current === owner) {
            setReadState(current => current.owner === owner ? { ...current, loading: false } : current);
          }
        });
    }, query.trim() ? 160 : 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, readOwner]);

  async function startMetrology(templateVersionId: string) {
    if (!sessionRef.current || operationRef.current) return;
    const operation = { session: sessionRef.current, sampleId, onStarted };
    operationRef.current = operation;
    const current = () => sessionRef.current === operation.session && operationRef.current === operation
      && currentSampleId.current === operation.sampleId;
    setStartingTemplateId(templateVersionId);
    setError("");
    try {
      const result = await api.startMetrologyRun(operation.sampleId, { templateVersionId });
      if (current()) await operation.onStarted(result.id);
    } catch (requestError) {
      if (current()) setError((requestError as Error).message);
    } finally {
      if (current()) { operationRef.current = null; setStartingTemplateId(""); }
    }
  }

  return <div
    className="run-start-dialog-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !starting) close();
    }}
  >
    <section
      ref={dialogRef}
      className="run-start-dialog transition-template-dialog standalone-metrology-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="run-start-dialog-heading">
        <div><p className="dialog-kicker">Independent run</p><h2 id={titleId}>Choose a metrology template</h2></div>
        <button type="button" className="drawer-close" disabled={starting} onClick={close} aria-label="Close"><DialogCloseIcon /></button>
      </div>
      <p className="muted">This creates a standalone result record and does not change the active fabrication process or sample structure.</p>
      <label className="search-box metrology-template-search">
        <span>Search templates</span>
        <input ref={searchRef} disabled={starting} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SEM, AFM, XRD…" />
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
        {!loading && !templates.length && !readError && <p className="muted">No matching metrology templates. Create one from Templates first.</p>}
      </div>
      {readError && <div className="error-banner" role="alert"><p>{readError}</p><button type="button" className="button" disabled={loading || starting} onClick={() => setRetry(current => current + 1)}>Retry templates</button></div>}
      {error && <p className="error-banner">{error}</p>}
      <div className="form-actions">
        <Link className="button" to="/templates" aria-disabled={starting || undefined} tabIndex={starting ? -1 : undefined}
          onClick={(event) => { if (operationRef.current) event.preventDefault(); }}>Manage templates</Link>
        <button type="button" className="button" disabled={starting} onClick={close}>Cancel</button>
      </div>
    </section>
  </div>;
}
