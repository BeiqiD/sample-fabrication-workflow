import { type FormEvent, useEffect, useRef, useState } from "react";
import type {
  CommentSubmissionItemInput,
  CommentSubmission,
  CommentImage,
  CommentAttachment,
  CreateCommentSubmissionInput,
  ManagedStorageStatus,
} from "../../shared/types";
import { MAX_MANAGED_ATTACHMENT_BYTES } from "../../shared/comment-submissions";
import { api } from "../lib/api";
import { prepareCommentImage } from "../lib/images";

let managedStorageStatusPromise: Promise<ManagedStorageStatus> | null = null;

function loadManagedStorageStatus() {
  managedStorageStatusPromise ??= api.getManagedStorageStatus().catch(() => ({
    provider: null,
    available: false,
    authentication: "not_configured" as const,
    message: "File storage status could not be loaded. File attachments are disabled; attachment links remain available.",
  }));
  return managedStorageStatusPromise;
}

interface CommentComposerProps {
  label: string;
  context: CreateCommentSubmissionInput["context"];
  onSubmitted: () => Promise<void>;
  onCancel?: () => void;
  placeholder?: string;
  submitLabel?: string;
}

export function CommentSubmissionRecovery({
  submissions,
  onSubmitted,
}: {
  submissions: CommentSubmission[];
  onSubmitted: () => Promise<void>;
}) {
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function retryFile(submission: CommentSubmission, item: CommentImage | Extract<CommentAttachment, { kind: "file" }>, selected: File) {
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
      setErrors((current) => ({ ...current, [item.id]: "" }));
      await api.uploadCommentSubmissionItem(submission.id, item.id, upload, sha256, (value) => {
        setProgress((current) => ({ ...current, [item.id]: value }));
      });
      await api.finalizeCommentSubmission(submission.id).catch(() => undefined);
      await onSubmitted();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Retry failed";
      setErrors((current) => ({ ...current, [item.id]: message }));
      await api.markCommentSubmissionItemFailed(submission.id, item.id, message).catch(() => undefined);
    }
  }

  async function removeItem(submissionId: string, itemId: string) {
    try {
      await api.removeCommentSubmissionItem(submissionId, itemId);
      await api.finalizeCommentSubmission(submissionId).catch(() => undefined);
      await onSubmitted();
    } catch (error) {
      setErrors((current) => ({ ...current, [itemId]: error instanceof Error ? error.message : "Remove failed" }));
    }
  }

  if (!submissions.length) return null;
  return <section className="recovered-submission-list" aria-live="polite">
    {submissions.map((submission) => {
      const fileItems = [
        ...submission.images,
        ...submission.attachments.filter((attachment): attachment is Extract<CommentAttachment, { kind: "file" }> => attachment.kind === "file"),
      ];
      return <article className="uploading-comment-card status-failed" key={submission.id}>
        <div className="uploading-comment-heading">
          <div><strong>Upload incomplete</strong>{submission.body && <p>{submission.body}</p>}<span className="recovery-hint">The upload state was restored. Reselect a failed local file to retry it.</span></div>
          <div className="uploading-comment-actions">
            <button type="button" onClick={() => void api.finalizeCommentSubmission(submission.id).then(onSubmitted).catch((error: Error) => setErrors((current) => ({ ...current, [submission.id]: error.message })))}>Finish</button>
            <button type="button" onClick={() => void api.cancelCommentSubmission(submission.id).then(onSubmitted)}>Cancel</button>
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
            {item.status !== "ready" && <div className="upload-item-actions">
              <label className="text-button">Retry<input type="file" onChange={(event) => {
                const selected = event.target.files?.[0];
                if (selected) void retryFile(submission, item, selected);
                event.target.value = "";
              }} /></label>
              <button type="button" onClick={() => void removeItem(submission.id, item.id)}>Remove</button>
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
}

interface DraftAttachment {
  id: string;
  file: File;
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
}

interface LocalSubmission {
  id: string;
  body: string;
  status: "creating" | "uploading" | "failed";
  error: string;
  items: LocalUploadItem[];
  input: CreateCommentSubmissionInput;
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

async function fileSha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function CommentComposer({
  label,
  context,
  onSubmitted,
  onCancel,
  placeholder,
  submitLabel = "Add",
}: CommentComposerProps) {
  const [body, setBody] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [links, setLinks] = useState<DraftLink[]>([]);
  const [rejected, setRejected] = useState<RejectedDraftFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [storage, setStorage] = useState<ManagedStorageStatus | null>(null);
  const [submissions, setSubmissions] = useState<LocalSubmission[]>([]);
  const submissionsRef = useRef(submissions);
  const imagesRef = useRef(images);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const storageReady = storage?.available === true;
  const storageMessage = storage?.message ?? "Checking file storage connection…";

  useEffect(() => { submissionsRef.current = submissions; }, [submissions]);
  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => {
    void loadManagedStorageStatus().then(setStorage);
  }, []);
  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    for (const controller of uploadControllers.current.values()) controller.abort();
  }, []);

  function updateSubmission(id: string, update: (submission: LocalSubmission) => LocalSubmission) {
    setSubmissions((current) => current.map((submission) => submission.id === id ? update(submission) : submission));
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

  async function insertAsCommentImages(files: File[]) {
    if (!files.length) return;
    setPreparing(true);
    setDraftError("");
    for (const file of files) {
      try {
        const processed = await prepareCommentImage(file);
        const id = crypto.randomUUID();
        setImages((current) => [...current, {
          id,
          original: file,
          processed,
          previewUrl: URL.createObjectURL(processed),
          attachOriginal: false,
        }]);
      } catch (error) {
        setRejected((current) => [...current, {
          id: crypto.randomUUID(),
          file,
          reason: error instanceof Error ? error.message : "This file cannot be inserted as a comment image.",
        }]);
      }
    }
    setPreparing(false);
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
        accepted.push({ id: crypto.randomUUID(), file });
      }
    }
    if (accepted.length) setAttachments((current) => [...current, ...accepted]);
  }

  function removeImage(id: string) {
    setImages((current) => {
      const image = current.find((candidate) => candidate.id === id);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return current.filter((candidate) => candidate.id !== id);
    });
  }

  async function uploadItem(submissionId: string, item: LocalUploadItem) {
    if (!item.file || item.kind === "link" || item.status === "removed" || item.status === "ready") return true;
    let sha256 = item.sha256;
    try {
      if (item.kind === "attachment" && !sha256) {
        updateUploadItem(submissionId, item.id, (current) => ({ ...current, status: "hashing", error: "" }));
        sha256 = await fileSha256(item.file);
        updateUploadItem(submissionId, item.id, (current) => ({ ...current, sha256 }));
      }
      updateUploadItem(submissionId, item.id, (current) => ({ ...current, status: "uploading", progress: 0, error: "" }));
      const controllerKey = `${submissionId}:${item.id}`;
      const controller = new AbortController();
      uploadControllers.current.set(controllerKey, controller);
      await api.uploadCommentSubmissionItem(submissionId, item.id, item.file, sha256, (progress) => {
        updateUploadItem(submissionId, item.id, (current) => ({ ...current, progress }));
      }, controller.signal);
      uploadControllers.current.delete(controllerKey);
      updateUploadItem(submissionId, item.id, (current) => ({ ...current, status: "ready", progress: 100, sha256, error: "" }));
      return true;
    } catch (error) {
      uploadControllers.current.delete(`${submissionId}:${item.id}`);
      const message = error instanceof Error ? error.message : "Upload failed";
      updateUploadItem(submissionId, item.id, (current) => ({ ...current, status: "failed", error: message }));
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        await api.markCommentSubmissionItemFailed(submissionId, item.id, message).catch(() => undefined);
      }
      return false;
    }
  }

  async function finalizeIfComplete(submissionId: string) {
    try {
      await api.finalizeCommentSubmission(submissionId);
      await onSubmitted();
      setSubmissions((current) => current.filter((submission) => submission.id !== submissionId));
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

  async function startSubmission(input: CreateCommentSubmissionInput, local: LocalSubmission) {
    try {
      await api.createCommentSubmission(input);
      updateSubmission(local.id, (submission) => ({ ...submission, status: "uploading", error: "" }));
      const results = await Promise.all(local.items.map((item) => uploadItem(local.id, item)));
      if (results.every(Boolean)) await finalizeIfComplete(local.id);
      else updateSubmission(local.id, (submission) => ({ ...submission, status: "failed", error: "Upload incomplete" }));
    } catch (error) {
      updateSubmission(local.id, (submission) => ({
        ...submission,
        status: "failed",
        error: error instanceof Error ? error.message : "The comment submission could not be created",
      }));
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (preparing || (!body.trim() && !images.length && !attachments.length && !links.length)) return;
    if (!storageReady && (attachments.length > 0 || images.some((image) => image.attachOriginal))) {
      setDraftError(storageMessage);
      return;
    }
    const submissionId = crypto.randomUUID();
    const itemInputs: CommentSubmissionItemInput[] = [];
    const localItems: LocalUploadItem[] = [];

    for (const image of images) {
      const imageItemId = crypto.randomUUID();
      const originalItemId = image.attachOriginal ? crypto.randomUUID() : undefined;
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
        });
      }
    }
    for (const attachment of attachments) {
      const itemId = crypto.randomUUID();
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
      });
    }
    for (const link of links) {
      const itemId = crypto.randomUUID();
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
      });
    }

    const input: CreateCommentSubmissionInput = context.kind === "sample"
      ? { id: submissionId, body: body.trim(), context, items: itemInputs }
      : { id: submissionId, body: body.trim(), context, items: itemInputs };
    const local: LocalSubmission = {
      id: submissionId,
      body: body.trim(),
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
    requestAnimationFrame(resizeTextarea);
    void startSubmission(input, local);
  }

  async function retryItem(submissionId: string, itemId: string) {
    const submission = submissionsRef.current.find((candidate) => candidate.id === submissionId);
    const item = submission?.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    if (await uploadItem(submissionId, item)) await finalizeIfComplete(submissionId);
  }

  async function retrySubmission(submissionId: string) {
    const submission = submissionsRef.current.find((candidate) => candidate.id === submissionId);
    if (!submission) return;
    await startSubmission(submission.input, submission);
  }

  async function removeFailedItem(submissionId: string, itemId: string) {
    try {
      await api.removeCommentSubmissionItem(submissionId, itemId);
      updateUploadItem(submissionId, itemId, (item) => ({ ...item, status: "removed", error: "" }));
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
      for (const [key, controller] of uploadControllers.current) {
        if (key.startsWith(`${submissionId}:`)) {
          controller.abort();
          uploadControllers.current.delete(key);
        }
      }
      await api.cancelCommentSubmission(submissionId);
      setSubmissions((current) => current.filter((submission) => submission.id !== submissionId));
    } catch (error) {
      updateSubmission(submissionId, (submission) => ({
        ...submission,
        error: error instanceof Error ? error.message : "The upload could not be cancelled",
      }));
    }
  }

  return <form
    className={`grid-comment-composer${dragging ? " dragging" : ""}`}
    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => {
      event.preventDefault();
      setDragging(false);
      void insertAsCommentImages([...event.dataTransfer.files]);
    }}
    onSubmit={submit}
  >
    {dragging && <div className="comment-drop-overlay">Drop files to prepare comment images</div>}
    <div className="comment-composer-row">
      <textarea
        ref={textareaRef}
        rows={1}
        aria-label={label}
        value={body}
        onInput={resizeTextarea}
        onChange={(event) => setBody(event.target.value)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length) void insertAsCommentImages(files);
        }}
        placeholder={placeholder ?? (onCancel ? "Add to checked samples…" : "Add a comment…")}
      />
      <input
        ref={imageInputRef}
        className="comment-file-input"
        type="file"
        accept="image/*"
        multiple
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
        disabled={!storageReady}
        onChange={(event) => {
          addAttachments([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <button type="button" className="comment-tool-button image-button" onClick={() => imageInputRef.current?.click()} title="Add comment images">
        <span className="comment-image-icon" aria-hidden="true" /><span className="visually-hidden">Add comment images</span>
      </button>
      <div className="comment-attachment-control">
        <button type="button" className="comment-tool-button" onClick={() => setShowAttachmentMenu((value) => !value)} title="Add attachment" aria-expanded={showAttachmentMenu}>
          <span className="comment-attach-icon" aria-hidden="true" /><span className="visually-hidden">Add attachment</span>
        </button>
        {showAttachmentMenu && <div className="attachment-menu">
          <button
            type="button"
            disabled={!storageReady}
            onClick={() => { setShowAttachmentMenu(false); attachmentInputRef.current?.click(); }}
          >
            Upload attachment
          </button>
          <button type="button" onClick={() => { setShowAttachmentMenu(false); setShowLinkForm(true); }}>Add attachment link</button>
          {!storageReady && <p>{storageMessage}</p>}
        </div>}
      </div>
      {onCancel && <button type="button" className="comment-cancel-button" onClick={onCancel} aria-label="Cancel common comment" title="Cancel">×</button>}
      <button className="button primary compact-button comment-add-button" disabled={preparing || (!body.trim() && !images.length && !attachments.length && !links.length)}>
        {preparing ? "Preparing…" : submitLabel}
      </button>
    </div>

    {showLinkForm && <LinkAttachmentForm
      onCancel={() => setShowLinkForm(false)}
      onAdd={(link) => {
        setLinks((current) => [...current, { ...link, id: crypto.randomUUID() }]);
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
              ? `Original attachment: ${fileType(image.original)} · ${formatSize(image.original.size)} · unchanged`
              : `Original: ${fileType(image.original)} · ${formatSize(image.original.size)}`}</span>
          </div>
          <div className="pending-card-actions">
            <button
              type="button"
              disabled={!storageReady}
              title={!storageReady ? storageMessage : undefined}
              onClick={() => setImages((current) => current.map((candidate) => candidate.id === image.id ? { ...candidate, attachOriginal: !candidate.attachOriginal } : candidate))}
            >
              {image.attachOriginal ? "Detach original" : "Attach original"}
            </button>
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
          <div><strong>{attachment.file.name}</strong><span>{fileType(attachment.file)} · {formatSize(attachment.file.size)} · Original file</span></div>
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
              <span>{item.kind === "comment_image" ? "Comment image" : item.kind === "attachment" ? "Original attachment" : "Attachment link"} · {item.status === "hashing" ? "Checking file hash" : item.status}</span>
              {item.status === "uploading" && <progress max={100} value={item.progress} />}
              {item.error && <span className="upload-item-error">{item.error}</span>}
            </div>
            {item.status === "failed" && <div className="upload-item-actions">
              <button type="button" onClick={() => void retryItem(submission.id, item.id)}>Retry</button>
              <button type="button" onClick={() => void removeFailedItem(submission.id, item.id)}>Remove</button>
            </div>}
          </div>)}
        </div>
        {submission.error && <p className="upload-submission-error">{submission.error}</p>}
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
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" className="button primary compact-button" disabled={!url || !title.trim()} onClick={() => onAdd({ url, title: title.trim(), description: description.trim() })}>Add link</button>
    </div>
  </div>;
}
