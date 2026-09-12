import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ProjectSnapshot } from "../../../shared/project-api";
import {
  projectInspectorEdgeDirectionLabel,
  projectInspectorProjection,
  projectInspectorRelationshipAriaLabel,
  type ProjectInspectorAction,
  type ProjectInspectorContext,
} from "../../lib/project-inspector-model";
import { projectNodeKindLabel, type ProjectNodeDescriptor } from "../../lib/project-map-model";
import { ReferenceExcerpt } from "../ReferenceExcerpt";
import { ProjectMarkdownPreview } from "./ProjectMarkdownPreview";
import "./project-inspector-details.css";

export interface ProjectInspectorDetailsProps {
  snapshot: ProjectSnapshot;
  descriptor: ProjectNodeDescriptor;
  headerAction?: ReactNode;
  primaryContent?: ReactNode;
  editing?: boolean;
  relatedContent?: ReactNode;
  onFocusItem?: (itemId: string) => void;
}

function ProjectInspectorActionLink({
  action,
  className,
}: {
  action: ProjectInspectorAction;
  className: string;
}) {
  if (action.external || action.label === "Open attachment") {
    return <a
      className={className}
      href={action.href}
      target={action.external ? "_blank" : undefined}
      rel={action.external ? "noreferrer" : undefined}
    >{action.label}</a>;
  }
  return <Link className={className} to={action.href}>{action.label}</Link>;
}

function ContextLink({ context }: { context: ProjectInspectorContext }) {
  if (!context.openSourceUrl) return null;
  const external = /^https?:\/\//i.test(context.openSourceUrl);
  if (external) {
    return <a
      className="project-inspector-context-link"
      href={context.openSourceUrl}
      target="_blank"
      rel="noreferrer"
    >Open exact context</a>;
  }
  return <Link
    className="project-inspector-context-link"
    to={context.openSourceUrl}
  >Open exact context</Link>;
}

export function ProjectInspectorDetails({
  snapshot,
  descriptor,
  headerAction,
  primaryContent,
  editing = false,
  relatedContent,
  onFocusItem,
}: ProjectInspectorDetailsProps) {
  const projection = projectInspectorProjection(snapshot, descriptor);
  const [failedMediaUrl, setFailedMediaUrl] = useState<string | null>(null);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const previewId = useId();
  const previewExpanded = expandedItemId === descriptor.itemId;
  if (!projection) {
    return <>
      <span className="meta-badge">{projectNodeKindLabel(descriptor.kind)}</span>
      <h2>{descriptor.title}</h2>
      <p className="project-inspector-excerpt">The authoritative Project occurrence is unavailable.</p>
    </>;
  }

  const media = projection.media?.url === failedMediaUrl ? null : projection.media;
  return <>
    <header className="project-inspector-summary">
      <div className="project-inspector-summary-row">
        <span className="meta-badge">{projection.kindLabel}</span>
        {!editing && <div className="project-inspector-header-actions">
          {headerAction}
          {descriptor.kind === "reference" && projection.primaryAction && <ProjectInspectorActionLink
            action={projection.primaryAction}
            className="button compact-button project-inspector-header-action"
          />}
        </div>}
      </div>
      {descriptor.kind !== "markdown" && <h2>{projection.title}</h2>}
      {projection.subtitle && <p className="card-meta">{projection.subtitle}</p>}
    </header>

    {((descriptor.kind !== "reference" && projection.primaryAction) || primaryContent) && <div className="project-inspector-primary-actions">
      {!editing && descriptor.kind !== "reference" && projection.primaryAction && <ProjectInspectorActionLink
        action={projection.primaryAction}
        className="button compact-button project-inspector-open-action"
      />}
      {primaryContent}
    </div>}

    {!editing && <>{descriptor.kind === "markdown"
      ? <div className="project-inspector-preview">
        <div
          id={previewId}
          className={`project-inspector-markdown${previewExpanded ? " expanded" : ""}`}
          data-project-reading-content="true"
          tabIndex={0}
          role="region"
          aria-label="Inspector Markdown content"
        ><ProjectMarkdownPreview source={descriptor.markdownSource || ""} /></div>
        <button
          type="button"
          className="button compact-button"
          aria-controls={previewId}
          aria-expanded={previewExpanded}
          onClick={() => setExpandedItemId(previewExpanded ? null : descriptor.itemId)}
        >{previewExpanded ? "Collapse note" : "Expand note"}</button>
      </div>
      : <ReferenceExcerpt
        source={projection.excerpt}
        format={descriptor.excerptFormat}
        className="project-inspector-excerpt"
        scrollRegionLabel="Inspector content preview"
      />}

    {media && <img
      className="project-inspector-media"
      src={media.url}
      alt={media.alt}
      onError={() => setFailedMediaUrl(media.url)}
    />}

    {projection.relationships.length > 0 && <section
      className="project-inspector-section"
      aria-labelledby="project-inspector-relationships-heading"
    >
      <div className="project-inspector-section-heading">
        <h3 id="project-inspector-relationships-heading">Relationships</h3>
        <span>{projection.relationshipSummary}</span>
      </div>
      <ul className="project-inspector-relationships">
        {projection.relationships.map((relationship) => <li
          key={relationship.edgeId}
        >
          {onFocusItem ? <button
            type="button"
            className="project-inspector-relationship-link"
            aria-label={projectInspectorRelationshipAriaLabel(relationship)}
            onClick={() => onFocusItem(relationship.relatedItemId)}
          >
            <span>{projectInspectorEdgeDirectionLabel(relationship)}</span>
            <strong>{relationship.relatedTitle}</strong>
            <small>{relationship.label}</small>
          </button> : <Link
            className="project-inspector-relationship-link"
            aria-label={projectInspectorRelationshipAriaLabel(relationship)}
            to={`/projects/${encodeURIComponent(snapshot.project.id)}?focus=${encodeURIComponent(relationship.relatedItemId)}`}
          >
            <span>{projectInspectorEdgeDirectionLabel(relationship)}</span>
            <strong>{relationship.relatedTitle}</strong>
            <small>{relationship.label}</small>
          </Link>}
        </li>)}
      </ul>
    </section>}

    {relatedContent}

    <details className="project-inspector-disclosure project-inspector-technical-details" key={descriptor.itemId}>
      <summary>Details</summary>
      {projection.contexts.length > 0 && <section>
      <h4>Source hierarchy</h4>
      <ol className="project-inspector-contexts">
        {projection.contexts.map((context, contextIndex) => <li
          key={`${context.label}-${contextIndex}`}
        >
          <strong>{context.label}</strong>
          <ul>
            {context.segments.map((segment, segmentIndex) => <li
              key={`${segment.type}-${segment.id}-${segmentIndex}`}
            >
              <span>{segment.type}</span>
              <span>{segment.label}</span>
              {segment.lifecycle !== "active" && <small>{segment.lifecycle}</small>}
            </li>)}
          </ul>
          <ContextLink context={context} />
        </li>)}
      </ol>
      </section>}

      <section>
      <h4>{projection.identityHeading}</h4>
      <dl>
        {[...projection.identityFields, ...projection.detailFields].map((field, index) => <div
          key={`${field.label}-${index}`}
        >
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>)}
      </dl>
      </section>

      <section>
      <h4>Project details</h4>
      <dl>
        {projection.occurrenceFields.map((field) => <div key={field.label}>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>)}
      </dl>
      </section>
    </details>
    </>}
  </>;
}
