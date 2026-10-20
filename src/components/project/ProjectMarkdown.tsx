import { RichText } from "../RichText";

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
  return <RichText
    source={source}
    mode="document"
    className={`project-rich-markdown ${className}`.trim()}
    emptyLabel={emptyLabel}
  />;
}
