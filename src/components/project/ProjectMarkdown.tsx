import { useMemo } from "react";
import { renderProjectMarkdown } from "../../lib/project-markdown";
import "temml/dist/Temml-Local.css";
import "./project-rich-content.css";

export interface ProjectMarkdownProps {
  source: string;
  className?: string;
  emptyLabel?: string;
}

export function ProjectMarkdown({
  source,
  className = "",
  emptyLabel = "No Markdown content.",
}: ProjectMarkdownProps) {
  const html = useMemo(() => renderProjectMarkdown(source), [source]);
  if (!source.trim()) {
    return <p className={`project-rich-markdown empty ${className}`.trim()}>{emptyLabel}</p>;
  }
  return <div
    className={`project-rich-markdown ${className}`.trim()}
    data-project-rich-markdown="true"
    dangerouslySetInnerHTML={{ __html: html }}
  />;
}
