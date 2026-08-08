import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  isReferenceTarget,
  type ReferenceResolution,
  type ReferenceTargetType,
} from "../../shared/reference-types";
import { resolveReference } from "../lib/reference-api";
import "../reference-page.css";

const REFERENCE_TYPE_LABELS = {
  sample: "Sample",
  run: "Run",
  run_step: "Run Step",
  comment: "Comment",
  comment_occurrence: "Comment occurrence",
  comment_attachment: "Comment attachment",
  execution_image: "Execution image",
  metrology_reference: "Metrology reference",
  recipe_revision: "Recipe revision",
} as const satisfies Record<ReferenceTargetType, string>;

const CONTEXT_SEGMENT_LABELS = {
  sample: "Sample",
  run: "Run",
  run_step: "Step",
  recipe_revision: "Recipe revision",
} as const;

type ReferenceState = {
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
  message: string;
};

function formatTimestamp(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function referenceState(resolution: ReferenceResolution): ReferenceState {
  if (resolution.resolution === "not_found") {
    return {
      label: "Not found",
      tone: "neutral",
      message: "No source object or registry tombstone is available for this stable ID.",
    };
  }
  if (resolution.resolution === "inconsistent") {
    return {
      label: "Inconsistent",
      tone: "danger",
      message: "The reference registry or source structure is inconsistent. Last-known context is shown read-only when available.",
    };
  }
  if (resolution.resolution === "tombstoned") {
    return {
      label: "Tombstoned",
      tone: "neutral",
      message: "The source was permanently removed. Only stable identity and last-known context remain.",
    };
  }
  if (resolution.source?.deletedAt) {
    return {
      label: "Deleted",
      tone: "danger",
      message: "The source is in recoverable deletion. This reference remains available here as a read-only destination.",
    };
  }
  if (resolution.source?.archivedAt) {
    return {
      label: "Archived",
      tone: "warning",
      message: "The source is archived. This destination preserves the exact revision and context without enabling edits.",
    };
  }
  if (resolution.destination.mode === "archived") {
    return {
      label: "Archived context",
      tone: "warning",
      message: "The source is resolved, but every available source path contains a deleted or archived ancestor. The context remains read-only here.",
    };
  }
  return {
    label: "Available",
    tone: "success",
    message: "The source is active. Open the source interface below, or inspect its resolved context on this page.",
  };
}

function segmentLifecycle(segment: ReferenceResolution["contexts"][number]["segments"][number]) {
  if (segment.deletedAt) return "Deleted";
  if (segment.archivedAt) return "Archived";
  return null;
}

export function ReferencePage() {
  const { type = "", id = "" } = useParams();
  const [resolution, setResolution] = useState<ReferenceResolution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const target = { type, id };
    if (!isReferenceTarget(target) || id.trim() !== id) {
      setResolution(null);
      setError("This is not a valid reference target.");
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setResolution(null);
    setError("");
    setLoading(true);
    resolveReference(target, controller.signal)
      .then((result) => setResolution(result))
      .catch((requestError: Error) => {
        if (requestError.name !== "AbortError") setError(requestError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, type]);

  if (loading) {
    return <div className="page reference-page"><p className="muted">Resolving reference…</p></div>;
  }

  if (!resolution) {
    return <div className="page reference-page">
      <Link className="back-link" to="/">← Home</Link>
      <section className="card reference-empty-state">
        <p className="eyebrow">Reference destination</p>
        <h1>Reference unavailable</h1>
        <p className="error-banner">{error || "The reference could not be resolved."}</p>
      </section>
    </div>;
  }

  const state = referenceState(resolution);
  const source = resolution.source;
  const typeLabel = REFERENCE_TYPE_LABELS[resolution.target.type];
  const title = source?.title || `${typeLabel} unavailable`;

  return <div className="page reference-page">
    <Link className="back-link" to="/">← Home</Link>
    <header className="reference-page-heading">
      <div className="reference-page-title">
        <p className="eyebrow">Reference · {typeLabel}</p>
        <h1>{title}</h1>
        {source?.subtitle && <p className="lead">{source.subtitle}</p>}
      </div>
      <div className="reference-page-actions">
        <span className={`reference-state-badge ${state.tone}`}>{state.label}</span>
        {resolution.destination.openSourceUrl && <Link
          className="button primary"
          to={resolution.destination.openSourceUrl}
        >Open source</Link>}
      </div>
    </header>

    <p className={`reference-state-message ${state.tone}`}>{state.message}</p>

    <section className="card reference-summary" aria-labelledby="reference-summary-title">
      <div className="reference-section-heading">
        <div>
          <p className="card-label">Stable identity</p>
          <h2 id="reference-summary-title">Reference summary</h2>
        </div>
        <code>{resolution.target.id}</code>
      </div>
      {source ? <>
        {source.excerpt && <p className="reference-excerpt">{source.excerpt}</p>}
        <dl className="reference-metadata">
          <div><dt>Target type</dt><dd>{typeLabel}</dd></div>
          <div><dt>Source kind</dt><dd>{source.kind || "—"}</dd></div>
          <div><dt>Source state</dt><dd>{source.state || "—"}</dd></div>
          <div><dt>Updated</dt><dd>{formatTimestamp(source.updatedAt)}</dd></div>
          <div><dt>Deleted</dt><dd>{formatTimestamp(source.deletedAt)}</dd></div>
          <div><dt>Archived</dt><dd>{formatTimestamp(source.archivedAt)}</dd></div>
        </dl>
      </> : <p className="muted reference-no-source">No source summary is available for this resolution state.</p>}
    </section>

    <section className="reference-context-section" aria-labelledby="reference-context-title">
      <div className="reference-section-heading">
        <div>
          <p className="card-label">Resolved hierarchy</p>
          <h2 id="reference-context-title">Source context</h2>
        </div>
        <span className="section-count">{resolution.contexts.length}</span>
      </div>

      {resolution.contexts.length ? <div className="reference-context-list">
        {resolution.contexts.map((context, contextIndex) => {
          const contextUrl = resolution.destination.contextOpenSourceUrls[contextIndex] ?? null;
          const contextKey = `${contextIndex}:${context.segments.map((segment) => `${segment.type}:${segment.id}`).join("/")}`;
          return <article className="card reference-context-card" key={contextKey}>
            <div className="reference-context-heading">
              <strong>{resolution.contexts.length === 1 ? "Source path" : `Context ${contextIndex + 1}`}</strong>
              {contextUrl && <Link className="button" to={contextUrl}>Open context</Link>}
            </div>
            <ol className="reference-context-segments">
              {context.segments.map((contextSegment) => {
                const lifecycle = segmentLifecycle(contextSegment);
                return <li key={`${contextSegment.type}:${contextSegment.id}`}>
                  <span className="reference-segment-type">{CONTEXT_SEGMENT_LABELS[contextSegment.type]}</span>
                  <span className="reference-segment-copy">
                    <strong>{contextSegment.label}</strong>
                    <code>{contextSegment.id}</code>
                  </span>
                  {lifecycle && <span className={`reference-segment-lifecycle ${lifecycle.toLowerCase()}`}>{lifecycle}</span>}
                </li>;
              })}
            </ol>
          </article>;
        })}
      </div> : <div className="card reference-empty-context">
        <p className="muted">No source context is available.</p>
      </div>}
    </section>
  </div>;
}
