import {
  escapeRichTextHtml,
  renderRichText,
  richTextSafeHref,
  richTextSafeImageSrc,
  richTextStartsWithHeading,
} from "./rich-text";

export const escapeProjectMarkdownHtml = escapeRichTextHtml;
export const projectMarkdownSafeHref = richTextSafeHref;
export const projectMarkdownSafeImageSrc = richTextSafeImageSrc;
export const projectMarkdownStartsWithHeading = richTextStartsWithHeading;

export function renderProjectMarkdown(source: string) {
  return renderRichText(source, "document");
}
