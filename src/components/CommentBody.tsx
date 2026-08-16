import { lazy, Suspense } from "react";

const LazyRichText = lazy(() => import("./RichText")
  .then((module) => ({ default: module.RichText })));

export interface CommentBodyProps {
  source: string;
  className?: string;
}

export function CommentBody({ source, className = "" }: CommentBodyProps) {
  if (!source.trim()) return null;
  const classes = `comment-rich-text ${className}`.trim();
  return <Suspense fallback={<p className={`comment-rich-text-fallback ${className}`.trim()}>{source}</p>}>
    <LazyRichText source={source} mode="comment" className={classes} />
  </Suspense>;
}
