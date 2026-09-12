import { lazy, memo, Suspense } from "react";
import type { ResolvedReferenceSource } from "../../shared/reference-types";
import "./reference-excerpt.css";

const RichExcerpt = lazy(() => import("./ReferenceExcerptRichText"));

export interface ReferenceExcerptProps {
  source: string | null | undefined;
  format?: ResolvedReferenceSource["excerptFormat"];
  className?: string;
}

export const ReferenceExcerpt = memo(function ReferenceExcerpt({
  source,
  format,
  className = "",
}: ReferenceExcerptProps) {
  if (!source?.trim()) return null;
  if (format !== "markdown") return <p className={className}>{source}</p>;
  return <div className={`reference-rich-excerpt ${className}`.trim()}>
    <Suspense fallback={<span className="muted" role="status">Loading preview…</span>}>
      <RichExcerpt source={source} />
    </Suspense>
  </div>;
});
