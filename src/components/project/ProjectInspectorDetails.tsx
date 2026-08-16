import { useState } from "react";
import { Link } from "react-router-dom";
import type { ProjectSnapshot } from "../../../shared/project-api";
import {
  projectInspectorEdgeDirectionLabel,
  projectInspectorProjection,
  projectInspectorRelationshipAriaLabel,
  type ProjectInspectorAction,
  type ProjectInspectorContext,
} from "../../lib/project-inspector-model";
import type { ProjectNodeDescriptor } from "../../lib/project-map-model";
import "./project-inspector-details.css";

export interface ProjectInspectorDetailsProps {
  snapshot: ProjectSnapshot;
  descriptor: ProjectNodeDescriptor;
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
}: ProjectInspectorDetailsProps) {
  const projection = projectInspectorProjection(snapshot, descriptor);
  const [failedMediaUrl, setFailedMediaUrl] = useState<string | null>(null);
  if (!projection) {
    return <>
      <span className="meta-badge">{descriptor.kind}</span>
      <h2>{descriptor.title}</h2>
      <p className="project-inspector-excerpt">The authoritative Project occurrence is unavailable.</p>
    </>;
  }

  const media = projection.media?.url === failedMediaUrl ? null : projection.media;
  return <>
    <span className="meta-badge">{projection.kindLabel}</span>
    <h2>{projection.title}</h2>
    {projection.subtitle && <p className="card-meta">{projection.subtitle}</p>}
    {projection.excerpt && <p className="project-inspector-excerpt">{projection.excerpt}</p>}

    <section className="project-inspector-section" aria-labelledby="project-inspector-occurrence-heading">
      <h3 id="project-inspector-occurrence-heading">Project occurrence</h3>
      <dl>
        {projection.occurrenceFields.map((field) => <div key={field.label}>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>)}
      </dl>
      {projection.relationships.length > 0 && <ul className="project-inspector-relationships">
        {projection.relationships.map((relationship) => <li
          key={relationship.edgeId}
          aria-label={projectInspectorRelationshipAriaLabel(relationship)}
        >
          <span>{projectInspectorEdgeDirectionLabel(relationship)}</span>
          <strong>{relationship.relatedTitle}</strong>
          <small>{relationship.label}</small>
        </li>)}
      </ul>}
    </section>

    <section className="project-inspector-section" aria-labelledby="project-inspector-identity-heading">
      <h3 id="project-inspector-identity-heading">{projection.identityHeading}</h3>
      <dl>
        {[...projection.identityFields, ...projection.detailFields].map((field, index) => <div
          key={`${field.label}-${index}`}
        >
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>)}
      </dl>
    </section>

    {projection.contexts.length > 0 && <section
      className="project-inspector-section"
      aria-labelledby="project-inspector-context-heading"
    >
      <h3 id="project-inspector-context-heading">Source hierarchy</h3>
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

    {media && <img
      className="project-inspector-media"
      src={media.url}
      alt={media.alt}
      onError={() => setFailedMediaUrl(media.url)}
    />}

    {projection.primaryAction && <ProjectInspectorActionLink
      action={projection.primaryAction}
      className="button wide"
    />}
  </>;
}
