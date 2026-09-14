import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CommentSubmission,
  CommentImage,
  CommentAttachment,
  CreateCommentSubmissionInput,
} from "../../shared/types";
import type { AcceptedCommentSubmissionInput, AcceptedCommentItemInput } from "../../shared/contracts/comment-acceptance";
import { commentCancellationPending, discardLocalCommentSubmission, commentFileSha256 as fileSha256, commentComposerSource, finishCommentSubmission, prepareDurableCommentSubmission, savedCommentSubmissions } from "../lib/comment-submission-client";
import { MAX_COMMENT_SUBMISSION_ITEMS, MAX_MANAGED_ATTACHMENT_BYTES } from "../../shared/comment-submissions";
import { isTiffMetadata } from "../../shared/tiff";
import { api } from "../lib/api";
import { createUuid } from "../lib/uuid";
import { anchoredMenuPosition, type AnchoredMenuPosition } from "../lib/anchoredMenuPosition";
import { commentUploadQueue } from "../lib/commentUploadQueue";
import { isTiffFile, prepareCommentImage } from "../lib/images";
import { useManagedStorageStatus } from "../lib/useManagedStorageStatus";

interface CommentComposerProps {
  label: string;
  sourceKey?: string;
  context: CreateCommentSubmissionInput["context"];
  onSubmitted: () => Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
  adaptiveToolbarLayout?: boolean;
}

function isRequiredTiffOriginal(
  submission: CommentSubmission,
  item: CommentImage | Extract<CommentAttachment, { kind: "file" }>,
) {
  if ("assetKey" in item || !item.relatedCommentImageId) return false;
  const relatedImage = submission.images.find((image) => image.id === item.relatedCommentImageId);
  return Boolean(relatedImage && relatedImage.status !== "cancelled"
    && isTiffMetadata(relatedImage.originalFilename, relatedImage.originalMimeType));
}

export function CommentSubmissionRecovery({
  submissions,
  onSubmitted,
  localSourceKey,
}: {
  submissions: CommentSubmission[];
  onSubmitted: () => Promise<void>;
  localSourceKey?: string;
}) {
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const active = useRef(true);
  const recoveryUploads = useRef(new Map<string, AbortController>());
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; for (const controller of recoveryUploads.current.values()) controller.abort(); };
  }, []);
  let tracked = new Set<string>();
  try { if (localSourceKey) tracked = new Set(savedCommentSubmissions(localSourceKey).map((input) => input.id)); } catch { /* The composer reports unavailable local tracking. */ }
  const visibleSubmissions = submissions.filter((submission) => !tracked.has(submission.id));
  const [recoveryStates, setRecoveryStates] = useState<Record<string, string>>({});
  const recoverySequence = useRef(0);
  const visibleIds = visibleSubmissions.map((submission) => submission.id).sort().join(",");
  useEffect(() => {
    const sequence = ++recoverySequence.current;
    for (const id of visibleIds.split(",").filter(Boolean)) {
      void api.getCommentSubmissionAcceptance(id).then((state) => {
        if (active.current && sequence === recoverySequence.current && state) setRecoveryStates((current) => ({ ...current, [id]: state.status }));
      }).catch(() => undefined);
    }
    return () => { recoverySequence.current += 1; };
  }, [visibleIds]);
  async function refresh(submissionId: string) {
    if (!active.current) return;
    await onSubmitted();
    finishCommentSubmission(submissionId);
  }
  async function finish(submissionId: string) {
    try { await api.finalizeCommentSubmission(submissionId); await refresh(submissionId); }
    catch (error) { if (active.current) setErrors((current) => ({ ...current, [submissionId]: (error as Error).message })); }
  }
  async function cancel(submissionId: string) {
    try { await api.cancelCommentSubmission(submissionId); await refresh(submissionId); }
    catch (error) { if (active.current) setErrors((current) => ({ ...current, [submissionId]: (error as Error).message })); }
  }

  async function retryFile(submission: CommentSubmission, item: CommentImage | Extract<CommentAttachment, { kind: "file" }>, selected: File) {
    if (recoveryUploads.current.has(item.id)) return;
    const controller = new AbortController(); recoveryUploads.current.set(item.id, controller);
    try {
      let upload = selected;
      let sha256: string | null = null;
      if ("assetKey" in item) {
        if (selected.name !== item.originalFilename || selected.size !== item.originalByteSize
          || (selected.type || "application/octet-stream") !== item.originalMimeType) {
          throw new Error("Select the same original image used for this comment.");
        }
        upload = await prepareCommentImage(selected);
        if (upload.name !== item.filename || upload.type !== item.mimeType || upload.size !== item.byteSize) {
          throw new Error("The reprocessed image does not match the saved upload draft. Remove it and submit a new image instead.");
        }
      } else {
        if (selected.name !== item.filename || selected.size !== item.byteSize
          || (selected.type || "application/octet-stream") !== item.mimeType) {
          throw new Error("Select the same unchanged file used for this attachment.");
        }
        sha256 = await fileSha256(selected);
      }
      sha256 = await fileSha256(upload);
      if (!active.current) return;
      setErrors((current) => ({ ...current, [item.id]: "" }));
      await commentUploadQueue.run(() => {
        if (!active.current || controller.signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
        return api.uploadCommentSubmissionItem(submission.id, item.id, upload, sha256, (value) => {
          if (active.current) setProgress((current) => ({ ...current, [item.id]: value }));
        }, controller.signal);
      }, controller.signal);
      if (!active.current) return;
      await api.finalizeCommentSubmission(submission.id).catch(() => undefined);
      await refresh(submission.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Retry failed";
      if (active.current) setErrors((current) => ({ ...current, [item.id]: message }));
    } finally { if (recoveryUploads.current.get(item.id) === controller) recoveryUploads.current.delete(item.id); }
  }

  async function removeItem(submissionId: string, itemId: string) {
    try {
      await api.removeCommentSubmissionItem(submissionId, itemId);
      if (!active.current) return;
      await api.finalizeCommentSubmission(submissionId).catch(() => undefined);
      await refresh(submissionId);
    } catch (error) {
      if (active.current) setErrors((current) => ({ ...current, [itemId]: error instanceof Error ? error.message : "Remove failed" }));
    }
  }

  if (!visibleSubmissions.length) return null;
  return <section className="recovered-submission-list" aria-live="polite">
    {visibleSubmissions.map((submission) => {
      const blocked = ["legacy", "expired", "unavailable"].includes(recoveryStates[submission.id] ?? "");
      const fileItems = [
        ...submission.images,
        ...submission.attachments.filter((attachment): attachment is Extract<CommentAttachment, { kind: "file" }> => attachment.kind === "file"),
      ];
      return <article className="uploading-comment-card status-failed" key={submission.id}>
        <div className="uploading-comment-heading">
          <div><strong>Upload incomplete</strong>{submission.body && <p>{submission.body}</p>}<span className="recovery-hint">{blocked ? "This older or unavailable upload cannot resume. Cancel it and submit a new comment." : "The upload state was restored. Reselect a failed local file to retry it."}</span></div>
          <div className="uploading-comment-actions">
            {!blocked && <button type="button" onClick={() => void finish(submission.id)}>Finish</button>}
            <button type="button" onClick={() => void cancel(submission.id)}>Cancel</button>
          </div>
        </div>
        <div className="upload-item-list">
          {fileItems.map((item) => <div className={`upload-item status-${item.status}`} key={item.id}>
            <span className="upload-item-state">{item.status === "ready" ? "✓" : "!"}</span>
            <div>
              <strong>{item.filename}</strong>
              <span>{"assetKey" in item ? "Comment image" : "Original attachment"} · {item.status}</span>
              {(progress[item.id] ?? 0) > 0 && (progress[item.id] ?? 0) < 100 && <progress max={100} value={progress[item.id]} />}
              {(errors[item.id] || item.error) && <span className="upload-item-error">{errors[item.id] || item.error}</span>}
            </div>
            {!blocked && item.status !== "ready" && <div className="upload-item-actions">
              <label className="text-button">Retry<input type="file" onChange={(event) => {
                const selected = event.target.files?.[0];
                if (selected) void retryFile(submission, item, selected);
                event.target.value = "";
              }} /></label>
              {!isRequiredTiffOriginal(submission, item) && <button type="button" onClick={() => void removeItem(submission.id, item.id)}>Remove</button>}
            </div>}
          </div>)}
          {submission.attachments.filter((attachment) => attachment.kind === "link").map((link) => <div className="upload-item status-ready" key={link.id}>
            <span className="upload-item-state">✓</span><div><strong>{link.title}</strong><span>Attachment link · ready</span></div>
          </div>)}
        </div>
        {(submission.error || errors[submission.id]) && <p className="upload-submission-error">{errors[submission.id] || submission.error}</p>}
      </article>;
    })}
  </section>;
}

interface DraftImage {
  id: string;
  original: File;
  processed: File;
  previewUrl: string;
  attachOriginal: boolean;
  originalRequired: boolean;
}

interface DraftAttachment {
  id: string;
  file: File;
  previewNote?: string;
}

interface DraftLink {
  id: string;
  url: string;
  title: string;
  description: string;
}

interface RejectedDraftFile {
  id: string;
  file: File;
  reason: string;
}

type LocalItemStatus = "waiting" | "hashing" | "uploading" | "ready" | "failed" | "removed";

interface LocalUploadItem {
  id: string;
  kind: "comment_image" | "attachment" | "link";
  filename: string;
  file: File | null;
  progress: number;
  status: LocalItemStatus;
  error: string;
  sha256: string | null;
  required: boolean;
  pairedItemId: string | null;
}

interface LocalSubmission {
  id: string;
  body: string;
  status: "creating" | "uploading" | "failed";
  error: string;
  items: LocalUploadItem[];
  input: AcceptedCommentSubmissionInput;
  cancelFailed?: boolean;
}

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};

function fileType(file: File) {
  const extension = file.name.split(".").pop()?.toUpperCase();
  return extension ? `${extension} ${file.type.startsWith("image/") ? "image" : "file"}` : (file.type || "File");
}

function inferredLinkTitle(value: string) {
  try {
    const url = new URL(value);
    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "");
    return last || url.hostname;
  } catch {
    return "";
  }
}

function textareaUsesMultipleVisualLines(textarea: HTMLTextAreaElement) {
  if (textarea.value.includes("\n")) return true;
  const styles = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles.lineHeight);
  const paddingTop = Number.parseFloat(styles.paddingTop);
  const paddingBottom = Number.parseFloat(styles.paddingBottom);
  if (![lineHeight, paddingTop, paddingBottom].every(Number.isFinite)) {
    return textarea.scrollHeight > textarea.clientHeight + 1;
  }
  return textarea.scrollHeight > Math.ceil(lineHeight + paddingTop + paddingBottom) + 1;
}

export function CommentComposer(props: CommentComposerProps) {
  return <CommentComposerSession key={props.sourceKey ?? commentComposerSource(props.context)} {...props} />;
}

function CommentComposerSession({
  label,
  sourceKey,
  context,
  onSubmitted,
  onCancel,
  submitLabel = "Add",
  adaptiveToolbarLayout = false,
}: CommentComposerProps) {
  const sessionActive = useRef(true);
  const discardedSubmissions = useRef(new Set<string>());
  const sourceIdentity = sourceKey ?? commentComposerSource(context);
  const [body, setBody] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [links, setLinks] = useState<DraftLink[]>([]);
  const [rejected, setRejected] = useState<RejectedDraftFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [attachmentMenuPosition, setAttachmentMenuPosition] = useState<AnchoredMenuPosition | null>(null);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  const { result: storageResult, checking: storageChecking, check: checkStorage } = useManagedStorageStatus();
  const [submissions, setSubmissions] = useState<LocalSubmission[]>([]);
  const submissionsRef = useRef(submissions);
  const imagesRef = useRef(images);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const submissionQueueControllers = useRef(new Map<string, AbortController>());
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentTriggerRef = useRef<HTMLButtonElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRowRef = useRef<HTMLDivElement>(null);
  const storage = storageResult?.status;
  const storageReady = !storageChecking && storage?.available === true;
  const storageMessage = storageChecking
    ? "Checking file storage connection…"
    : storageResult?.error ?? storage?.message ?? "";
  const hasDraftItems = images.length > 0 || attachments.length > 0 || links.length > 0 || rejected.length > 0;

  useEffect(() => {
    sessionActive.current = true;
    try {
      setSubmissions(savedCommentSubmissions(sourceIdentity).map((input): LocalSubmission => ({
        id: input.id, body: input.body, status: "failed", error: "Check the saved comment request. Reselect any file that still needs uploading.", input, cancelFailed: commentCancellationPending(input.id),
        items: input.items.map((item): LocalUploadItem => ({
          id: item.id, kind: item.kind, filename: item.kind === "link" ? item.title : item.filename,
          file: null, progress: item.kind === "link" ? 100 : 0, status: item.kind === "link" ? "ready" : "failed", error: "",
          sha256: item.kind === "link" ? null : item.sha256 ?? null,
          required: item.kind === "attachment" && Boolean(item.relatedCommentImageId && input.items.some((image) => image.id === item.relatedCommentImageId && image.kind === "comment_image" && isTiffMetadata(image.originalFilename, image.originalMimeType))),
          pairedItemId: item.kind === "comment_image" ? item.relatedAttachmentId ?? null : item.kind === "attachment" ? item.relatedCommentImageId ?? null : null,
        })),
      })));
    } catch (error) { setDraftError((error as Error).message); }
    return () => { sessionActive.current = false; };
  }, [sourceIdentity]);
  useEffect(() => { submissionsRef.current = submissions; }, [submissions]);
  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => {
    if (adaptiveToolbarLayout && (hasDraftItems || preparing || showLinkForm)) {
      setToolbarExpanded(true);
    }
  }, [adaptiveToolbarLayout, hasDraftItems, preparing, showLinkForm]);
  useLayoutEffect(() => {
    if (!adaptiveToolbarLayout || toolbarExpanded) return;
    const row = composerRowRef.current;
    const textarea = textareaRef.current;
    if (!row || !textarea) return;

    function expandWhenTextWraps() {
      const currentTextarea = textareaRef.current;
      if (currentTextarea?.value && textareaUsesMultipleVisualLines(currentTextarea)) {
        setToolbarExpanded(true);
      }
    }

    expandWhenTextWraps();
    const observer = new ResizeObserver(expandWhenTextWraps);
    observer.observe(row);
    return () => observer.disconnect();
  }, [adaptiveToolbarLayout, toolbarExpanded]);
  useLayoutEffect(() => {
    if (toolbarExpanded) resizeTextarea();
  }, [toolbarExpanded]);
  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    for (const controller of uploadControllers.current.values()) controller.abort();
    for (const controller of submissionQueueControllers.current.values()) controller.abort();
  }, []);
  useLayoutEffect(() => {
    if (!showAttachmentMenu) return;

    function updatePosition() {
      const trigger = attachmentTriggerRef.current;
      const menu = attachmentMenuRef.current;
      if (!trigger || !menu) return;
      setAttachmentMenuPosition(anchoredMenuPosition(
        trigger.getBoundingClientRect(),
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    }

    updatePosition();
    attachmentMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [showAttachmentMenu, storageMessage, storageReady]);
  useEffect(() => {
    if (!showAttachmentMenu) {
      setAttachmentMenuPosition(null);
      return;
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (!attachmentTriggerRef.current?.contains(event.target) && !attachmentMenuRef.current?.contains(event.target)) {
        setShowAttachmentMenu(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setShowAttachmentMenu(false);
      attachmentTriggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [showAttachmentMenu]);

  function updateSubmission(id: string, update: (submission: LocalSubmission) => LocalSubmission) {
    if (sessionActive.current && !discardedSubmissions.current.has(id)) setSubmissions((current) => current.map((submission) => submission.id === id ? update(submission) : submission));
  }

  function updateUploadItem(submissionId: string, itemId: string, update: (item: LocalUploadItem) => LocalUploadItem) {
    updateSubmission(submissionId, (submission) => ({
      ...submission,
      items: submission.items.map((item) => item.id === itemId ? update(item) : item),
    }));
  }

  function resizeTextarea() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(112, textarea.scrollHeight)}px`;
  }

  function handleTextareaInput(textarea: HTMLTextAreaElement) {
    if (adaptiveToolbarLayout && !toolbarExpanded && textarea.value && textareaUsesMultipleVisualLines(textarea)) {
      setToolbarExpanded(true);
    }
    resizeTextarea();
  }

  async function insertAsCommentImages(files: File[]) {
    if (!files.length || preparing) return;
    if (adaptiveToolbarLayout) setToolbarExpanded(true);
    setPreparing(true);
    setDraftError("");
    let checkedStorageResult = storageChecking ? null : storageResult;
    const fallbackAttachments: DraftAttachment[] = [];
    const rejectedFiles: RejectedDraftFile[] = [];
    try {
      for (const file of files) {
        const tiff = isTiffFile(file);
        if (tiff && !checkedStorageResult) {
          checkedStorageResult = await checkStorage();
        }
        const checkedStorage = checkedStorageResult?.status;
        if (tiff && !checkedStorage?.available) {
          rejectedFiles.push({ id: createUuid(), file, reason: checkedStorageResult?.error || checkedStorage?.message || storageMessage });
          continue;
        }
        if (tiff && file.size > MAX_MANAGED_ATTACHMENT_BYTES) {
          rejectedFiles.push({
            id: createUuid(),
            file,
            reason: "This TIFF is larger than 100 MB and cannot be uploaded through the web interface.",
          });
          continue;
        }
        try {
          const processed = await prepareCommentImage(file);
          const id = createUuid();
          setImages((current) => [...current, {
            id,
            original: file,
            processed,
            previewUrl: URL.createObjectURL(processed),
            attachOriginal: tiff,
            originalRequired: tiff,
          }]);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "This file cannot be inserted as a comment image.";
          if (tiff && checkedStorage?.available) {
            fallbackAttachments.push({
              id: createUuid(),
              file,
              previewNote: reason.includes("will be attached without a preview")
                ? reason
                : `${reason} The original TIFF will be attached without a preview.`,
            });
          } else {
            rejectedFiles.push({ id: createUuid(), file, reason });
          }
        }
      }
      if (fallbackAttachments.length) {
        setAttachments((current) => [...current, ...fallbackAttachments]);
      }
      if (rejectedFiles.length) setRejected((current) => [...current, ...rejectedFiles]);
    } finally {
      setPreparing(false);
    }
  }

  function addAttachments(files: File[]) {
    setDraftError("");
    if (!storageReady) {
      setDraftError(storageMessage);
      return;
    }
    const accepted: DraftAttachment[] = [];
    for (const file of files) {
      if (file.size > MAX_MANAGED_ATTACHMENT_BYTES) {
        setDraftError("Files larger than 100 MB cannot be uploaded through the web interface. Upload the file through another storage or sync mechanism, then add its link as an attachment.");
      } else {
        accepted.push({ id: createUuid(), file });
      }
    }
    if (accepted.length) {
      if (adaptiveToolbarLayout) setToolbarExpanded(true);
      setAttachments((current) => [...current, ...accepted]);
    }
  }

  function removeImage(id: string) {
    setImages((current) => {
      const image = current.find((candidate) => candidate.id === id);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return current.filter((candidate) => candidate.id !== id);
    });
  }

  async function uploadItem(submissionId: string, item: LocalUploadItem, submissionSignal?: AbortSignal) {
    if (!sessionActive.current || discardedSubmissions.current.has(submissionId)) return false;
    if (item.kind === "link" || item.status === "removed") return true;
    if (!item.file) {
      const state = await api.getCommentSubmissionAcceptance(submissionId);
      const saved = state?.items.find((candidate) => candidate.id === item.id);
      if (saved?.status === "ready" || saved?.status === "cancelled") {
        updateUploadItem(submissionId, item.id, (current) => ({ ...current, status: saved.status === "ready" ? "ready" : "removed", error: "", progress: 100 }));
        return true;
      }
      return false;
    }
    if (submissionSignal?.aborted) return false;
    let sha256 = item.sha256;
    try {
      if (!sha256) {
        updateUploadItem(submissionId, item.id, (current) => ({ ...current, status: "hashing", error: "" }));
        sha256 = await fileSha256(item.file);
        updateUploadItem(submissionId, item.id, (current) => ({ ...current, sha256 }));
      }
      if (submissionSignal?.aborted) return false;
      updateUploadItem(submissionId, item.id, (current) => ({ ...current, status: "uploading", progress: 0, error: "" }));
      const controllerKey = `${submissionId}:${item.id}`;
      const controller = new AbortController();
      const abortUpload = () => controller.abort();
      submissionSignal?.addEventListener("abort", abortUpload, { once: true });
      uploadControllers.current.set(controllerKey, controller);
      try {
        await api.uploadCommentSubmissionItem(submissionId, item.id, item.file, sha256, (progress) => {
          updateUploadItem(submissionId, item.id, (current) => ({ ...current, progress }));
        }, controller.signal);
      } finally {
        submissionSignal?.removeEventListener("abort", abortUpload);
        uploadControllers.current.delete(controllerKey);
      }
      updateUploadItem(submissionId, item.id, (current) => ({ ...current, status: "ready", progress: 100, sha256, error: "" }));
      return true;
    } catch (error) {
      uploadControllers.current.delete(`${submissionId}:${item.id}`);
      const message = error instanceof Error ? error.message : "Upload failed";
      updateUploadItem(submissionId, item.id, (current) => ({ ...current, status: "failed", error: message }));
      return false;
    }
  }

  async function finalizeIfComplete(submissionId: string) {
    if (!sessionActive.current || discardedSubmissions.current.has(submissionId)) return false;
    try {
      await api.finalizeCommentSubmission(submissionId);
      if (!sessionActive.current || discardedSubmissions.current.has(submissionId)) return false;
      await onSubmitted();
      finishCommentSubmission(submissionId);
      if (sessionActive.current) setSubmissions((current) => current.filter((submission) => submission.id !== submissionId));
      return true;
    } catch (error) {
      updateSubmission(submissionId, (submission) => ({
        ...submission,
        status: "failed",
        error: error instanceof Error ? error.message : "Upload incomplete",
      }));
      return false;
    }
  }

  async function startSubmission(input: AcceptedCommentSubmissionInput, local: LocalSubmission) {
    const queueController = new AbortController();
    submissionQueueControllers.current.set(local.id, queueController);
    try {
      await api.createCommentSubmission(input);
      if (!sessionActive.current || queueController.signal.aborted || discardedSubmissions.current.has(local.id)) return;
      updateSubmission(local.id, (submission) => ({ ...submission, status: "uploading", error: "" }));
      const results = await Promise.all(local.items.map(async (item) => {
        try {
          return await commentUploadQueue.run(
            () => uploadItem(local.id, item, queueController.signal),
            queueController.signal,
          );
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return false;
          throw error;
        }
      }));
      if (queueController.signal.aborted) return;
      if (results.every(Boolean)) await finalizeIfComplete(local.id);
      else updateSubmission(local.id, (submission) => ({ ...submission, status: "failed", error: "Upload incomplete" }));
    } catch (error) {
      updateSubmission(local.id, (submission) => ({
        ...submission,
        status: "failed",
        error: error instanceof Error ? error.message : "The comment submission could not be created",
      }));
    } finally {
      if (submissionQueueControllers.current.get(local.id) === queueController) {
        submissionQueueControllers.current.delete(local.id);
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (preparing || (!body.trim() && !images.length && !attachments.length && !links.length)) return;
    if (!storageReady && (attachments.length > 0 || images.some((image) => image.attachOriginal))) {
      setDraftError(storageMessage);
      return;
    }
    const itemCount = images.reduce((count, image) => count + (image.attachOriginal ? 2 : 1), 0)
      + attachments.length + links.length;
    if (itemCount > MAX_COMMENT_SUBMISSION_ITEMS) {
      setDraftError(`A comment can contain at most ${MAX_COMMENT_SUBMISSION_ITEMS} uploaded items. TIFF previews count as a preview and an original attachment.`);
      return;
    }
    const submissionId = createUuid();
    const itemInputs: AcceptedCommentItemInput[] = [];
    const localItems: LocalUploadItem[] = [];

    for (const image of images) {
      const imageItemId = createUuid();
      const originalItemId = image.attachOriginal ? createUuid() : undefined;
      itemInputs.push({
        id: imageItemId,
        kind: "comment_image",
        filename: image.processed.name,
        mimeType: image.processed.type,
        byteSize: image.processed.size,
        originalFilename: image.original.name,
        originalMimeType: image.original.type || "application/octet-stream",
        originalByteSize: image.original.size,
        relatedAttachmentId: originalItemId,
      });
      localItems.push({
        id: imageItemId,
        kind: "comment_image",
        filename: image.processed.name,
        file: image.processed,
        progress: 0,
        status: "waiting",
        error: "",
        sha256: null,
        required: false,
        pairedItemId: originalItemId ?? null,
      });
      if (originalItemId) {
        itemInputs.push({
          id: originalItemId,
          kind: "attachment",
          filename: image.original.name,
          mimeType: image.original.type || "application/octet-stream",
          byteSize: image.original.size,
          title: image.original.name,
          relatedCommentImageId: imageItemId,
        });
        localItems.push({
          id: originalItemId,
          kind: "attachment",
          filename: image.original.name,
          file: image.original,
          progress: 0,
          status: "waiting",
          error: "",
          sha256: null,
          required: image.originalRequired,
          pairedItemId: imageItemId,
        });
      }
    }
    for (const attachment of attachments) {
      const itemId = createUuid();
      itemInputs.push({
        id: itemId,
        kind: "attachment",
        filename: attachment.file.name,
        mimeType: attachment.file.type || "application/octet-stream",
        byteSize: attachment.file.size,
        title: attachment.file.name,
      });
      localItems.push({
        id: itemId,
        kind: "attachment",
        filename: attachment.file.name,
        file: attachment.file,
        progress: 0,
        status: "waiting",
        error: "",
        sha256: null,
        required: false,
        pairedItemId: null,
      });
    }
    for (const link of links) {
      const itemId = createUuid();
      itemInputs.push({ id: itemId, kind: "link", url: link.url, title: link.title, description: link.description });
      localItems.push({
        id: itemId,
        kind: "link",
        filename: link.title,
        file: null,
        progress: 100,
        status: "ready",
        error: "",
        sha256: null,
        required: false,
        pairedItemId: null,
      });
    }

    // Snapshot text and revision-bearing targets before any hashing can yield.
    const frozenContext = JSON.parse(JSON.stringify(context)) as CreateCommentSubmissionInput["context"];
    const frozenBody = body.trim();
    setPreparing(true); setDraftError("");
    let input: AcceptedCommentSubmissionInput;
    try {
      for (const item of localItems) {
        if (!item.file) continue;
        item.sha256 = await commentUploadQueue.run(() => fileSha256(item.file!));
        const accepted = itemInputs.find((candidate) => candidate.id === item.id)!;
        accepted.sha256 = item.sha256;
        if (!sessionActive.current) return;
      }
      input = await prepareDurableCommentSubmission({ protocol: "comment-submission/1", id: submissionId, body: frozenBody, context: frozenContext, items: itemInputs }, sourceIdentity);
      if (!sessionActive.current) return;
    } catch (error) { if (sessionActive.current) setDraftError((error as Error).message); return; }
    finally { if (sessionActive.current) setPreparing(false); }
    const local: LocalSubmission = {
      id: submissionId,
      body: frozenBody,
      status: "creating",
      error: "",
      items: localItems,
      input,
    };
    setSubmissions((current) => [local, ...current]);
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setBody("");
    setImages([]);
    setAttachments([]);
    setLinks([]);
    setRejected([]);
    setToolbarExpanded(false);
    requestAnimationFrame(resizeTextarea);
    void startSubmission(input, local);
  }

  async function retryItem(submissionId: string, itemId: string, selected?: File) {
    const submission = submissionsRef.current.find((candidate) => candidate.id === submissionId);
    let item = submission?.items.find((candidate) => candidate.id === itemId);
    if (!item || !submission) return;
    if (selected) {
      try {
        const accepted = submission.input.items.find((candidate) => candidate.id === itemId);
        if (!accepted || accepted.kind === "link") return;
        if (accepted.kind === "comment_image" && (selected.name !== accepted.originalFilename || selected.size !== accepted.originalByteSize || (selected.type || "application/octet-stream") !== accepted.originalMimeType)) throw new Error("Select the same original image used for this comment.");
        const upload = accepted.kind === "comment_image" ? await prepareCommentImage(selected) : selected;
        const sha256 = await fileSha256(upload);
        if (sha256 !== accepted.sha256 || upload.name !== accepted.filename || upload.size !== accepted.byteSize || (upload.type || "application/octet-stream") !== accepted.mimeType) throw new Error("The selected file does not match the accepted comment. Select its unchanged original file.");
        if (!sessionActive.current) return;
        item = { ...item, file: upload, sha256 };
        updateUploadItem(submissionId, itemId, () => item!);
      } catch (error) { updateUploadItem(submissionId, itemId, (current) => ({ ...current, error: (error as Error).message })); return; }
    }
    const retry = item;
    const queueController = new AbortController();
    submissionQueueControllers.current.set(submissionId, queueController);
    try {
      if (await commentUploadQueue.run(
        () => uploadItem(submissionId, retry, queueController.signal),
        queueController.signal,
      )) await finalizeIfComplete(submissionId);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) updateUploadItem(submissionId, itemId, (current) => ({ ...current, error: (error as Error).message }));
    } finally {
      if (submissionQueueControllers.current.get(submissionId) === queueController) {
        submissionQueueControllers.current.delete(submissionId);
      }
    }
  }

  async function retrySubmission(submissionId: string) {
    const submission = submissionsRef.current.find((candidate) => candidate.id === submissionId);
    if (!submission) return;
    await startSubmission(submission.input, submission);
  }

  async function removeFailedItem(submissionId: string, itemId: string) {
    try {
      await api.removeCommentSubmissionItem(submissionId, itemId);
      updateSubmission(submissionId, (submission) => ({
        ...submission,
        items: submission.items.map((item) => {
          if (item.id === itemId) return { ...item, status: "removed", error: "" };
          if (item.pairedItemId === itemId) return { ...item, required: false };
          return item;
        }),
      }));
      await finalizeIfComplete(submissionId);
    } catch (error) {
      if (error instanceof Error && error.message === "Comment submission not found") {
        setSubmissions((current) => current.filter((submission) => submission.id !== submissionId));
        return;
      }
      updateSubmission(submissionId, (submission) => ({
        ...submission,
        error: error instanceof Error ? error.message : "The failed item could not be removed",
      }));
    }
  }

  async function cancelSubmission(submissionId: string) {
    try {
      submissionQueueControllers.current.get(submissionId)?.abort();
      for (const [key, controller] of uploadControllers.current) {
        if (key.startsWith(`${submissionId}:`)) {
          controller.abort();
          uploadControllers.current.delete(key);
        }
      }
      await api.cancelCommentSubmission(submissionId);
      if (!sessionActive.current) return;
      await onSubmitted();
      finishCommentSubmission(submissionId);
      if (sessionActive.current) setSubmissions((current) => current.filter((submission) => submission.id !== submissionId));
    } catch (error) {
      updateSubmission(submissionId, (submission) => ({
        ...submission,
        error: error instanceof Error ? error.message : "The upload could not be cancelled",
        cancelFailed: true,
      }));
    }
  }

  function discardSubmission(submissionId: string) {
    try {
      submissionQueueControllers.current.get(submissionId)?.abort();
      for (const [key, controller] of uploadControllers.current) if (key.startsWith(`${submissionId}:`)) controller.abort();
      discardLocalCommentSubmission(submissionId);
      discardedSubmissions.current.add(submissionId);
      setSubmissions((current) => current.filter((submission) => submission.id !== submissionId));
    } catch (error) { updateSubmission(submissionId, (submission) => ({ ...submission, error: (error as Error).message })); }
  }

  return <form
    className={`grid-comment-composer${dragging ? " dragging" : ""}${adaptiveToolbarLayout ? " adaptive-toolbar-layout" : ""}${adaptiveToolbarLayout && toolbarExpanded ? " is-expanded" : ""}`}
    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => {
      event.preventDefault();
      setDragging(false);
      void insertAsCommentImages([...event.dataTransfer.files]);
    }}
    onSubmit={(event) => { void submit(event); }}
    onClickCapture={(event) => { if (preparing) { event.preventDefault(); event.stopPropagation(); } }}
    onBlur={(event) => {
      if (!adaptiveToolbarLayout) return;
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      if (!body.trim() && !hasDraftItems && !preparing && !showLinkForm && !showAttachmentMenu) {
        setToolbarExpanded(false);
      }
    }}
  >
    {dragging && <div className="comment-drop-overlay">Drop files to prepare comment images</div>}
    <div ref={composerRowRef} className="comment-composer-row">
      <textarea
        ref={textareaRef}
        rows={1}
        aria-label={label}
        value={body}
        disabled={preparing}
        onInput={(event) => handleTextareaInput(event.currentTarget)}
        onChange={(event) => setBody(event.target.value)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length) void insertAsCommentImages(files);
        }}
        placeholder="Add a comment…"
      />
      <input
        ref={imageInputRef}
        className="comment-file-input"
        type="file"
        accept="image/*,.tif,.tiff,image/tiff"
        multiple
        disabled={preparing}
        onChange={(event) => {
          void insertAsCommentImages([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <input
        ref={attachmentInputRef}
        className="comment-file-input"
        type="file"
        multiple
        disabled={!storageReady || preparing}
        onChange={(event) => {
          addAttachments([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <div className="comment-composer-tools">
        <button type="button" className="comment-tool-button image-button" disabled={preparing} onClick={() => imageInputRef.current?.click()} title="Add comment images">
          <span className="comment-image-icon" aria-hidden="true" /><span className="visually-hidden">Add comment images</span>
        </button>
        <div className="comment-attachment-control">
          <button
            ref={attachmentTriggerRef}
            type="button"
            className="comment-tool-button"
            onClick={() => setShowAttachmentMenu((value) => !value)}
            title="Add attachment"
            aria-haspopup="menu"
            aria-expanded={showAttachmentMenu}
          >
            <span className="comment-attach-icon" aria-hidden="true" /><span className="visually-hidden">Add attachment</span>
          </button>
          {showAttachmentMenu && createPortal(<div
            ref={attachmentMenuRef}
            className="attachment-menu"
            role="menu"
            aria-label="Attachment options"
            data-placement={attachmentMenuPosition?.placement}
            style={{
              left: attachmentMenuPosition?.left ?? 0,
              top: attachmentMenuPosition?.top ?? 0,
              visibility: attachmentMenuPosition ? "visible" : "hidden",
            }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!storageReady}
              onClick={() => { setShowAttachmentMenu(false); attachmentInputRef.current?.click(); }}
            >
              Upload attachment
            </button>
            <button type="button" role="menuitem" onClick={() => {
              setShowAttachmentMenu(false);
              if (adaptiveToolbarLayout) setToolbarExpanded(true);
              setShowLinkForm(true);
            }}>Add attachment link</button>
            {!storageReady && <p>{storageMessage}</p>}
            {!storageReady && <button
              type="button"
              role="menuitem"
              disabled={storageChecking}
              onClick={() => void checkStorage()}
            >Retry storage connection</button>}
          </div>, document.body)}
        </div>
        {onCancel && <button type="button" className="comment-cancel-button" onClick={onCancel} aria-label="Cancel common comment" title="Cancel">×</button>}
        <button className="button primary compact-button comment-add-button" disabled={preparing || (!body.trim() && !images.length && !attachments.length && !links.length)}>
          {preparing ? "Preparing…" : submitLabel}
        </button>
      </div>
    </div>

    {showLinkForm && <LinkAttachmentForm
      onCancel={() => setShowLinkForm(false)}
      onAdd={(link) => {
        setLinks((current) => [...current, { ...link, id: createUuid() }]);
        setShowLinkForm(false);
      }}
    />}

    {(images.length > 0 || rejected.length > 0) && <section className="pending-draft-section">
      <p className="pending-section-label">Pending images</p>
      <div className="pending-image-list">
        {images.map((image) => <article className="pending-image-card" key={image.id}>
          <img src={image.previewUrl} alt="" />
          <div>
            <strong>{image.original.name}</strong>
            <span>Comment image: {fileType(image.processed)} · {formatSize(image.processed.size)}</span>
            <span>{image.attachOriginal
              ? `${image.originalRequired ? "Original TIFF attachment" : "Original attachment"}: ${fileType(image.original)} · ${formatSize(image.original.size)} · ${image.originalRequired ? "required · " : ""}unchanged`
              : `Original: ${fileType(image.original)} · ${formatSize(image.original.size)}`}</span>
          </div>
          <div className="pending-card-actions">
            {!image.originalRequired && <button
              type="button"
              disabled={!storageReady}
              title={!storageReady ? storageMessage : undefined}
              onClick={() => setImages((current) => current.map((candidate) => candidate.id === image.id ? { ...candidate, attachOriginal: !candidate.attachOriginal } : candidate))}
            >
              {image.attachOriginal ? "Detach original" : "Attach original"}
            </button>}
            <button type="button" onClick={() => removeImage(image.id)}>Remove</button>
          </div>
        </article>)}
        {rejected.map((entry) => <article className="rejected-image-card" key={entry.id}>
          <div>
            <strong>{entry.file.name}</strong>
            <span>{entry.reason}</span>
            {!storageReady && <span>{storageMessage}</span>}
          </div>
          <div className="pending-card-actions">
            <button type="button" disabled={!storageReady || entry.file.size > MAX_MANAGED_ATTACHMENT_BYTES} title={!storageReady ? storageMessage : undefined} onClick={() => {
              addAttachments([entry.file]);
              setRejected((current) => current.filter((candidate) => candidate.id !== entry.id));
            }}>Add as attachment</button>
            <button type="button" onClick={() => setRejected((current) => current.filter((candidate) => candidate.id !== entry.id))}>Remove</button>
          </div>
        </article>)}
      </div>
    </section>}

    {(attachments.length > 0 || links.length > 0) && <section className="pending-draft-section">
      <p className="pending-section-label">Pending attachments</p>
      {attachments.length > 0 && storage && !storage.available && <p className="attachment-storage-warning">{storage.message}</p>}
      <div className="pending-attachment-list">
        {attachments.map((attachment) => <div className="pending-attachment" key={attachment.id}>
          <span className="attachment-kind-icon" aria-hidden="true">📎</span>
          <div>
            <strong>{attachment.file.name}</strong>
            <span>{fileType(attachment.file)} · {formatSize(attachment.file.size)} · Original file</span>
            {attachment.previewNote && <span>{attachment.previewNote}</span>}
          </div>
          <button type="button" onClick={() => setAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id))}>Remove</button>
        </div>)}
        {links.map((link) => <div className="pending-attachment" key={link.id}>
          <span className="attachment-kind-icon" aria-hidden="true">↗</span>
          <div><strong>{link.title}</strong><span>{link.url}</span></div>
          <button type="button" onClick={() => setLinks((current) => current.filter((candidate) => candidate.id !== link.id))}>Remove</button>
        </div>)}
      </div>
    </section>}

    {draftError && <p className="comment-image-error">{draftError}</p>}

    {submissions.length > 0 && <section className="local-submission-list" aria-live="polite">
      {submissions.map((submission) => <article className={`uploading-comment-card status-${submission.status}`} key={submission.id}>
        <div className="uploading-comment-heading">
          <div><strong>{submission.status === "failed" ? "Upload incomplete" : "Uploading comment…"}</strong>{submission.body && <p>{submission.body}</p>}</div>
          <div className="uploading-comment-actions">
            {submission.status === "failed" && <button type="button" onClick={() => void retrySubmission(submission.id)}>Retry incomplete</button>}
            <button type="button" onClick={() => void cancelSubmission(submission.id)}>Cancel</button>
          </div>
        </div>
        <div className="upload-item-list">
          {submission.items.filter((item) => item.status !== "removed").map((item) => <div className={`upload-item status-${item.status}`} key={item.id}>
            <span className="upload-item-state">{item.status === "ready" ? "✓" : item.status === "failed" ? "!" : item.status === "hashing" ? "…" : item.status === "waiting" ? "○" : `${item.progress}%`}</span>
            <div>
              <strong>{item.filename}</strong>
              <span>{item.kind === "comment_image" ? "Comment image" : item.kind === "attachment" ? (item.required ? "Required original TIFF" : "Original attachment") : "Attachment link"} · {item.status === "hashing" ? "Checking file hash" : item.status}</span>
              {item.status === "uploading" && <progress max={100} value={item.progress} />}
              {item.error && <span className="upload-item-error">{item.error}</span>}
            </div>
            {item.status === "failed" && <div className="upload-item-actions">
              {item.file ? <button type="button" onClick={() => void retryItem(submission.id, item.id)}>Retry</button>
                : <label className="text-button">Retry<input type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void retryItem(submission.id, item.id, file); event.target.value = ""; }} /></label>}
              {!item.required && <button type="button" onClick={() => void removeFailedItem(submission.id, item.id)}>Remove</button>}
            </div>}
          </div>)}
        </div>
        {submission.error && <p className="upload-submission-error">{submission.error}</p>}
        {submission.cancelFailed && <div className="uploading-comment-actions"><small>This clears local tracking. An earlier request may still finish.</small><button type="button" onClick={() => discardSubmission(submission.id)}>Discard local request</button></div>}
      </article>)}
    </section>}
  </form>;
}

function LinkAttachmentForm({
  onAdd,
  onCancel,
}: {
  onAdd: (link: Omit<DraftLink, "id">) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  return <div className="attachment-link-form">
    <label>URL<input type="url" required value={url} onChange={(event) => {
      setUrl(event.target.value);
      if (!title) setTitle(inferredLinkTitle(event.target.value));
    }} placeholder="https://…" /></label>
    <label>Title<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Description<textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <div>
      <button type="button" className="button compact-button" onClick={onCancel}>Cancel</button>
      <button type="button" className="button primary compact-button" disabled={!url || !title.trim()} onClick={() => onAdd({ url, title: title.trim(), description: description.trim() })}>Add link</button>
    </div>
  </div>;
}
