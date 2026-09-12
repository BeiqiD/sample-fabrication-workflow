import { lazy, memo, Suspense } from "react";
import type { ResolvedReferenceSource } from "../../shared/reference-types";
import "./reference-excerpt.css";

const RichExcerpt = lazy(() => import("./ReferenceExcerptRichText"));

export interface ReferenceExcerptProps {
  source: string | null | undefined;
  format?: ResolvedReferenceSource["excerptFormat"];
  className?: string;
  scrollRegionLabel?: string;
}

export const ReferenceExcerpt = memo(function ReferenceExcerpt({
  source,
  format,
  className = "",
  scrollRegionLabel,
}: ReferenceExcerptProps) {
  if (!source?.trim()) return null;
  const readingRegion = scrollRegionLabel ? {
    role: "region",
    tabIndex: 0,
    "aria-label": scrollRegionLabel,
    "data-project-reading-content": "true",
  } : {};
  if (format !== "markdown") return <p className={className} {...readingRegion}>{source}</p>;
  return <div className={`reference-rich-excerpt ${className}`.trim()} {...readingRegion}>
    <Suspense fallback={<span className="muted" role="status">Loading preview…</span>}>
      <RichExcerpt source={source} />
    </Suspense>
  </div>;
});
