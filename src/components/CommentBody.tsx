import { lazy, Suspense } from "react";

const LazyRichText = lazy(() => import("./RichText")
  .then((module) => ({ default: module.RichText })));

export interface CommentBodyProps {
  source: string;
  className?: string;
  scrollable?: boolean;
}

export function CommentBody({ source, className = "", scrollable = false }: CommentBodyProps) {
  if (!source.trim()) return null;
  const classes = `comment-rich-text ${className}`.trim();
  const content = <Suspense fallback={<p className={`comment-rich-text-fallback ${className}`.trim()}>{source}</p>}>
    <LazyRichText source={source} mode="comment" className={classes} />
  </Suspense>;
  return scrollable
    ? <div className="comment-body-scroll" tabIndex={0} role="region" aria-label="Comment content">{content}</div>
    : content;
}
