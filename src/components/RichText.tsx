import { useMemo } from "react";
import { renderRichText, type RichTextMode } from "../lib/rich-text";
import "temml/dist/Temml-Local.css";
import "../rich-text.css";

export interface RichTextProps {
  source: string;
  mode?: RichTextMode;
  className?: string;
  emptyLabel?: string | null;
}

export function RichText({
  source,
  mode = "document",
  className = "",
  emptyLabel = null,
}: RichTextProps) {
  const html = useMemo(() => renderRichText(source, mode), [mode, source]);
  const classes = `rich-text rich-text-${mode} ${className}`.trim();
  if (!source.trim()) {
    return emptyLabel === null
      ? null
      : <p className={`${classes} empty`} data-rich-text={mode}>{emptyLabel}</p>;
  }
  return <div
    className={classes}
    data-rich-text={mode}
    dangerouslySetInnerHTML={{ __html: html }}
  />;
}
