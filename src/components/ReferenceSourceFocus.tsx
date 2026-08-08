import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  decodeReferenceSourceFocus,
  encodeReferenceRouteId,
} from "../../shared/reference-destinations";
import type { ReferenceTarget } from "../../shared/reference-types";
import type { SampleDetail } from "../../shared/types";
import type { TemplateDetail } from "../lib/api";
import {
  findMetrologyReferenceFocus,
  findProcessingReferenceFocus,
  findSampleReferenceFocus,
  type ReferenceAttachmentPreview,
} from "../lib/reference-source-focus";
import type { RunGridColumn } from "../lib/runGrid";
import { useModalDialog } from "../lib/use-modal-dialog";
import "../reference-source-focus.css";
import { DialogCloseIcon } from "./DialogCloseIcon";

const FOCUS_CLASS = "reference-source-focus";

function formatBytes(bytes: number) {
  if (!bytes) return "Size unavailable";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function nextFrame(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const frame = window.requestAnimationFrame(() => resolve());
    signal?.addEventListener("abort", () => {
      window.cancelAnimationFrame(frame);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function waitForElement<T extends HTMLElement>(
  find: () => T | null,
  signal: AbortSignal,
  maximumFrames = 120,
) {
  for (let frame = 0; frame < maximumFrames && !signal.aborted; frame += 1) {
    const element = find();
    if (element) return element;
    await nextFrame(signal);
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return null;
}

function scrollToFocusedElement(element: HTMLElement) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "center",
    inline: "center",
  });
  window.requestAnimationFrame(() => {
    const topbarBottom = document.querySelector<HTMLElement>(".topbar")
      ?.getBoundingClientRect().bottom ?? 0;
    const rect = element.getBoundingClientRect();
    const minimumTop = topbarBottom + 16;
    if (rect.top < minimumTop) window.scrollBy({ top: rect.top - minimumTop, behavior: "auto" });
  });
}

function executionImageUrl(preview: Extract<ReferenceAttachmentPreview, { kind: "execution_image" }>) {
  const params = new URLSearchParams({ step: preview.stepId });
  return `/api/references/media/execution_image/${encodeReferenceRouteId(preview.id)}?${params}`;
}

function ReferencePreviewDialog({
  preview,
  onClose,
}: {
  preview: ReferenceAttachmentPreview;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [imageError, setImageError] = useState("");
  useModalDialog({ dialogRef, initialFocusRef: closeButtonRef, onClose });
  const imageUrl = preview.kind === "execution_image"
    ? executionImageUrl(preview)
    : preview.kind === "image"
      ? preview.assetUrl
      : null;

  return createPortal(<div
    className="reference-preview-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
  >
    <section
      ref={dialogRef}
      className={`reference-preview-dialog reference-preview-${preview.kind}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="reference-preview-title"
    >
      <div className="reference-preview-heading">
        <div>
          <p className="dialog-kicker">Referenced {preview.kind === "link" ? "link" : preview.kind === "file" ? "attachment" : "image"}</p>
          <h2 id="reference-preview-title">{preview.title}</h2>
        </div>
        <button ref={closeButtonRef} type="button" className="drawer-close" onClick={onClose} aria-label="Close reference preview">
          <DialogCloseIcon />
        </button>
      </div>

      {imageUrl && <div className="reference-preview-image-stage">
        {imageError
          ? <p className="error-banner">{imageError}</p>
          : <img
            src={imageUrl}
            alt={preview.title}
            onError={() => setImageError("The referenced image is no longer available in this source context.")}
          />}
      </div>}

      {preview.kind === "file" && <div className="reference-preview-copy">
        {preview.description && <p>{preview.description}</p>}
        <dl>
          <div><dt>Filename</dt><dd>{preview.filename}</dd></div>
          <div><dt>Type</dt><dd>{preview.mimeType || "Unknown"}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(preview.byteSize)}</dd></div>
          <div><dt>Status</dt><dd>{preview.status}</dd></div>
        </dl>
      </div>}

      {preview.kind === "link" && <div className="reference-preview-copy">
        {preview.description && <p>{preview.description}</p>}
        <p className="reference-preview-url">{preview.url}</p>
      </div>}

      <div className="reference-preview-actions">
        {imageUrl && !imageError && <a className="button primary" href={imageUrl} target="_blank" rel="noreferrer">Open original</a>}
        {preview.kind === "file" && preview.downloadUrl && preview.status === "ready"
          && <a className="button primary" href={preview.downloadUrl} download={preview.filename}>Download file</a>}
        {preview.kind === "link" && preview.status === "ready"
          && <a className="button primary" href={preview.url} target="_blank" rel="noreferrer">Open link</a>}
        <button type="button" className="button" onClick={onClose}>Close</button>
      </div>
    </section>
  </div>, document.body);
}

function ReferenceFocusNotice({ message }: { message: string }) {
  if (!message || typeof document === "undefined") return null;
  return createPortal(<div className="reference-focus-notice" role="status" aria-live="polite">
    {message}
  </div>, document.body);
}

function decodedFocus(value: string | null) {
  return value === null ? null : decodeReferenceSourceFocus(value);
}

function decorate(element: HTMLElement, decorated: HTMLElement[]) {
  if (decorated.includes(element)) return;
  element.classList.add(FOCUS_CLASS);
  element.setAttribute("data-reference-focused", "true");
  decorated.push(element);
}

function clearDecorations(decorated: HTMLElement[]) {
  for (const element of decorated) {
    element.classList.remove(FOCUS_CLASS);
    element.removeAttribute("data-reference-focused");
  }
}

function processingDataSignature(columns: RunGridColumn[]) {
  return columns.map((column) => [
    column.sample.id,
    column.run?.id ?? "",
    column.run?.steps.map((step) => [
      step.id,
      step.updatedAt,
      step.comments.map((comment) => [
        comment.id,
        comment.submissionId ?? "",
        comment.images?.map((image) => image.id).join(",") ?? "",
        comment.attachments?.map((attachment) => attachment.id).join(",") ?? "",
      ].join(":"))
        .join(","),
    ].join("@")).join("|") ?? "",
  ].join("#")).join(";");
}

export function ProcessingReferenceSourceFocus({
  focusValue,
  sampleId,
  stepId,
  columns,
}: {
  focusValue: string | null;
  sampleId: string;
  stepId: string;
  columns: RunGridColumn[];
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<ReferenceAttachmentPreview | null>(null);
  const [message, setMessage] = useState("");
  const signature = useMemo(() => processingDataSignature(columns), [columns]);

  useEffect(() => {
    const controller = new AbortController();
    const decorated: HTMLElement[] = [];
    let openedCommonDialog = false;
    setPreview(null);
    setMessage("");

    async function applyFocus(focus: ReferenceTarget) {
      const match = findProcessingReferenceFocus(columns, sampleId, stepId, focus);
      if (!match) {
        setMessage("The referenced object is not available in this Run and Step context.");
        return;
      }

      const host = anchorRef.current?.parentElement ?? null;
      const grid = host?.querySelector<HTMLElement>(".run-grid-card") ?? null;
      if (!grid) {
        setMessage("The processing grid did not become available for this reference.");
        return;
      }
      const rows = [...grid.querySelectorAll<HTMLElement>(".run-grid-row")];
      const row = rows[match.rowIndex] ?? null;
      const sampleCells = row
        ? [...row.children].filter((child): child is HTMLElement => (
          child instanceof HTMLElement && child.classList.contains("sample-step-cell")
        ))
        : [];
      const cell = sampleCells[match.columnIndex] ?? null;
      if (!row || !cell) {
        setMessage("The referenced Step is not represented in the current grid layout.");
        return;
      }

      decorate(cell, decorated);
      let exactElement: HTMLElement = cell;
      if (match.comment) {
        if (match.comment.scope === "common") {
          const recipeCell = [...row.children].find((child): child is HTMLElement => (
            child instanceof HTMLElement && child.classList.contains("recipe-cell")
          )) ?? null;
          let commentContainer = recipeCell?.querySelector<HTMLElement>(".common-comments") ?? null;
          if (!commentContainer && recipeCell) {
            const button = recipeCell.querySelector<HTMLButtonElement>(".recipe-comment-action");
            if (button && button.getAttribute("aria-expanded") !== "true") {
              button.click();
              openedCommonDialog = true;
            }
            commentContainer = await waitForElement(
              () => document.querySelector<HTMLElement>(".process-plan-comment-dialog .cell-comments"),
              controller.signal,
            );
          }
          const commentCards = commentContainer
            ? [...commentContainer.querySelectorAll<HTMLElement>(".cell-comment")]
            : [];
          const commentCard = match.commonCommentIndex === null
            ? null
            : commentCards[match.commonCommentIndex] ?? null;
          if (commentCard) {
            decorate(commentCard, decorated);
            exactElement = commentCard;
          } else {
            setMessage("The referenced common Comment is resolved but is not represented in the current comment view.");
          }
        } else {
          const commentCards = [...cell.querySelectorAll<HTMLElement>(".comment-history .cell-comment")];
          const commentCard = match.commentIndex === null
            ? null
            : commentCards[match.commentIndex] ?? null;
          if (commentCard) {
            decorate(commentCard, decorated);
            exactElement = commentCard;
          } else {
            setMessage("The referenced Comment is resolved but is not represented in the current Step cell.");
          }
        }
      }

      if (focus.type === "comment_attachment" && !match.preview) {
        setMessage("The referenced attachment is present but its preview is unavailable.");
      }
      setPreview(match.preview);
      scrollToFocusedElement(exactElement);
    }

    if (!focusValue) return () => controller.abort();
    const focus = decodedFocus(focusValue);
    if (!focus) {
      setMessage("This source-focus URL is invalid or no longer supported.");
      return () => controller.abort();
    }
    void applyFocus(focus).catch((error: Error) => {
      if (error.name !== "AbortError") setMessage(error.message || "The reference focus could not be applied.");
    });

    return () => {
      controller.abort();
      clearDecorations(decorated);
      if (openedCommonDialog) {
        document.querySelector<HTMLButtonElement>(".process-plan-comment-dialog .drawer-close")?.click();
      }
    };
  }, [columns, focusValue, sampleId, signature, stepId]);

  return <>
    <span ref={anchorRef} className="reference-focus-anchor" aria-hidden="true" />
    <ReferenceFocusNotice message={message} />
    {preview && <ReferencePreviewDialog key={`${preview.kind}:${preview.id}`} preview={preview} onClose={() => setPreview(null)} />}
  </>;
}

export function SampleReferenceSourceFocus({
  focusValue,
  sample,
}: {
  focusValue: string | null;
  sample: SampleDetail;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<ReferenceAttachmentPreview | null>(null);
  const [message, setMessage] = useState("");
  const signature = useMemo(() => (sample.comments ?? []).map((comment) => [
    comment.id,
    comment.updatedAt,
    comment.images.map((image) => image.id).join(","),
    comment.attachments.map((attachment) => attachment.id).join(","),
  ].join(":"))
    .join(";"), [sample.comments]);

  useEffect(() => {
    const controller = new AbortController();
    const decorated: HTMLElement[] = [];
    setPreview(null);
    setMessage("");

    async function applyFocus(focus: ReferenceTarget) {
      const match = findSampleReferenceFocus(sample, focus);
      if (!match) {
        setMessage("The referenced Sample Comment or attachment is not available on this Sample.");
        return;
      }
      const host = anchorRef.current?.parentElement ?? null;
      const list = host?.querySelector<HTMLElement>(".sample-notes-list") ?? null;
      if (!list) {
        setMessage("Notes & observations did not become available for this reference.");
        return;
      }
      const expand = list.querySelector<HTMLButtonElement>(".sample-notes-toggle[aria-expanded=\"false\"]");
      if (match.noteIndex >= 3 && expand) {
        expand.click();
        await nextFrame(controller.signal);
      }
      const note = [...list.querySelectorAll<HTMLElement>(".sample-note")][match.noteIndex] ?? null;
      if (!note) {
        setMessage("The referenced Sample note is not represented in the current page.");
        return;
      }
      decorate(note, decorated);
      if (focus.type === "comment_attachment" && !match.preview) {
        setMessage("The referenced attachment is present but its preview is unavailable.");
      }
      setPreview(match.preview);
      scrollToFocusedElement(note);
    }

    if (!focusValue) return () => controller.abort();
    const focus = decodedFocus(focusValue);
    if (!focus) {
      setMessage("This source-focus URL is invalid or no longer supported.");
      return () => controller.abort();
    }
    void applyFocus(focus).catch((error: Error) => {
      if (error.name !== "AbortError") setMessage(error.message || "The reference focus could not be applied.");
    });

    return () => {
      controller.abort();
      clearDecorations(decorated);
    };
  }, [focusValue, sample, signature]);

  return <>
    <span ref={anchorRef} className="reference-focus-anchor" aria-hidden="true" />
    <ReferenceFocusNotice message={message} />
    {preview && <ReferencePreviewDialog key={`${preview.kind}:${preview.id}`} preview={preview} onClose={() => setPreview(null)} />}
  </>;
}

export function MetrologyReferenceSourceFocus({
  focusValue,
  template,
}: {
  focusValue: string | null;
  template: TemplateDetail;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [message, setMessage] = useState("");
  const signature = useMemo(
    () => template.referenceAttachments.map((reference) => reference.id).join(";"),
    [template.referenceAttachments],
  );

  useEffect(() => {
    const controller = new AbortController();
    const decorated: HTMLElement[] = [];
    setMessage("");

    async function applyFocus(focus: ReferenceTarget) {
      const match = findMetrologyReferenceFocus(template, focus);
      if (!match) {
        setMessage("The referenced metrology file is not available in this Recipe revision.");
        return;
      }
      const host = anchorRef.current?.parentElement ?? null;
      const list = host?.querySelector<HTMLElement>(".metrology-reference-list") ?? null;
      const item = list
        ? [...list.querySelectorAll<HTMLElement>(".metrology-reference-item")][match.referenceIndex] ?? null
        : null;
      if (!item) {
        setMessage("The referenced metrology file is not represented in the current page.");
        return;
      }
      decorate(item, decorated);
      scrollToFocusedElement(item);
    }

    if (!focusValue) return () => controller.abort();
    const focus = decodedFocus(focusValue);
    if (!focus) {
      setMessage("This source-focus URL is invalid or no longer supported.");
      return () => controller.abort();
    }
    void applyFocus(focus).catch((error: Error) => {
      if (error.name !== "AbortError") setMessage(error.message || "The reference focus could not be applied.");
    });

    return () => {
      controller.abort();
      clearDecorations(decorated);
    };
  }, [focusValue, signature, template]);

  return <>
    <span ref={anchorRef} className="reference-focus-anchor" aria-hidden="true" />
    <ReferenceFocusNotice message={message} />
  </>;
}
