import { lazy, memo, Suspense } from "react";

const LazyProjectMarkdown = lazy(() => import("./ProjectMarkdown")
  .then((module) => ({ default: module.ProjectMarkdown })));

// Keep the heavy renderer behind the same lazy boundary on every Project surface.
export const ProjectMarkdownPreview = memo(function ProjectMarkdownPreview({
  source,
}: {
  source: string;
}) {
  return <Suspense fallback={<p className="muted" role="status">Loading note…</p>}>
    <LazyProjectMarkdown source={source} emptyLabel="Empty note" />
  </Suspense>;
});
