import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SampleSummary } from "../../shared/types";
import { EmptyState } from "../components/EmptyState";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";

function SampleStateThumbnail({ sample }: { sample: SampleSummary }) {
  const [imageFailed, setImageFailed] = useState(false);
  const thumbnailKey = sample.currentStateThumbnailKey;

  useEffect(() => setImageFailed(false), [thumbnailKey]);

  if (thumbnailKey && !imageFailed) return <div className="sample-state-thumbnail has-image">
    <img
      src={`/api/assets/${thumbnailKey}`}
      alt={sample.currentStateStepTitle ? `Current state after ${sample.currentStateStepTitle}` : `Current state of ${sample.code}`}
      loading="lazy"
      onError={() => setImageFailed(true)}
    />
    <span>Current state</span>
  </div>;

  const hasRecipe = Boolean(sample.currentRecipeName);
  return <div
    className={`sample-state-thumbnail placeholder ${hasRecipe ? "missing-image" : "no-recipe"}`}
    role="img"
    aria-label={hasRecipe ? "No state image available" : "No recipe assigned"}
  >
    <svg aria-hidden="true" viewBox="0 0 48 48">
      <path d="M9 16 24 8l15 8-15 8-15-8Z" />
      <path d="m9 24 15 8 15-8M9 32l15 8 15-8" />
    </svg>
    <span>{hasRecipe ? "No state image" : "No recipe"}</span>
  </div>;
}

function recipeStateText(sample: SampleSummary) {
  if (!sample.currentRecipeName) return "Assign a recipe from the sample page";
  if (sample.currentRecipeStatus === "active") return sample.currentStepTitle ? `Current step · ${sample.currentStepTitle}` : "Active recipe";
  if (sample.currentRecipeStatus === "complete") return "Recipe completed";
  if (sample.currentRecipeStatus === "cancelled") return "Latest recipe cancelled";
  return "Latest recipe superseded";
}

export function HomePage() {
  const [samples, setSamples] = useState<SampleSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setLoading(true);
      api.listSamples(query).then(({ samples }) => {
        setSamples(samples);
        setError("");
      }).catch((error: Error) => setError(error.message)).finally(() => setLoading(false));
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [query]);

  return <div className="page narrow-page">
    <div className="page-heading">
      <div><p className="eyebrow">Workspace</p><h1>Samples</h1></div>
      <div className="header-actions"><Link className="button" to="/samples/new">New sample</Link><Link className="button primary" to="/entry">Sample record</Link></div>
    </div>
    <label className="search-box">
      <span>Search</span>
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Code, title, recipe, or location" />
    </label>
    {error && <p className="error-banner">{error}</p>}
    {loading ? <p className="muted">Loading…</p> : samples.length ? <div className="sample-list">
      {samples.map((sample) => <Link to={`/samples/${sample.id}`} className="sample-row" key={sample.id}>
        <SampleStateThumbnail sample={sample} />
        <div className="sample-main">
          <div className="sample-identity"><span className="sample-code">{sample.code}</span>{sample.pinned && <span className="sample-pinned">Pinned</span>}</div>
          <strong className="sample-title">{sample.title}</strong>
          <span className="sample-location">{sample.location || "No location"}{sample.parentId ? " · Child sample" : ""}</span>
          <div className={`sample-recipe ${sample.currentRecipeName ? "" : "unassigned"}`}>
            <span>{sample.currentRecipeStatus === "active" ? "Current recipe" : sample.currentRecipeName ? "Latest recipe" : "Recipe"}</span>
            <strong>{sample.currentRecipeName || "No recipe assigned"}{sample.currentRecipeVersion != null ? ` · v${sample.currentRecipeVersion}` : ""}</strong>
            <small>{recipeStateText(sample)}</small>
          </div>
        </div>
        <div className="sample-row-side"><StatusPill status={sample.status} /><time>Updated {new Date(sample.updatedAt).toLocaleDateString()}</time></div>
      </Link>)}
    </div> : <EmptyState title={query ? "No matching samples" : "No samples yet"}>
      {query ? "Try another code, title, recipe, or location." : "Create the first sample to start its event log."}
    </EmptyState>}
  </div>;
}
