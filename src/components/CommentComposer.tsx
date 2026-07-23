import { useEffect, useRef, useState } from "react";

interface CommentComposerProps {
  label: string;
  saving: boolean;
  onSave: (body: string, image: File | null) => Promise<boolean>;
  onCancel?: () => void;
  placeholder?: string;
  submitLabel?: string;
}

export function CommentComposer({
  label,
  saving,
  onSave,
  onCancel,
  placeholder,
  submitLabel = "Add",
}: CommentComposerProps) {
  const [body, setBody] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imageError, setImageError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!image) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(image);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  function chooseImage(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setImageError("Only image files can be attached."); return; }
    setImageError("");
    setImage(file);
  }

  function resizeTextarea() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(112, textarea.scrollHeight)}px`;
  }

  return <form
    className={`grid-comment-composer${dragging ? " dragging" : ""}`}
    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); chooseImage(event.dataTransfer.files[0]); }}
    onSubmit={(event) => {
      event.preventDefault();
      void onSave(body, image).then((saved) => {
        if (saved) {
          setBody("");
          setImage(null);
          requestAnimationFrame(resizeTextarea);
        }
      });
    }}
  >
    {dragging && <div className="comment-drop-overlay">Drop photo here</div>}
    <div className="comment-composer-row">
      <textarea
        ref={textareaRef}
        rows={1}
        aria-label={label}
        value={body}
        onInput={resizeTextarea}
        onChange={(event) => setBody(event.target.value)}
        onPaste={(event) => {
          const pastedImage = [...event.clipboardData.files].find((file) => file.type.startsWith("image/"));
          if (pastedImage) chooseImage(pastedImage);
        }}
        placeholder={placeholder ?? (onCancel ? "Add to checked samples…" : "Add a comment…")}
      />
      <input
        ref={inputRef}
        className="comment-file-input"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => { chooseImage(event.target.files?.[0]); event.target.value = ""; }}
      />
      {image && previewUrl
        ? <div className="pending-comment-image" title={image.name}><img src={previewUrl} alt="Pending comment attachment" /><button type="button" onClick={() => setImage(null)} aria-label="Remove attached photo">×</button></div>
        : <button type="button" className="comment-attach-button" onClick={() => inputRef.current?.click()} title="Attach a photo, or drop it anywhere in this comment"><span className="comment-attach-icon" aria-hidden="true" /><span className="visually-hidden">Attach photo</span></button>}
      {onCancel && <button type="button" className="comment-cancel-button" onClick={onCancel} aria-label="Cancel common comment" title="Cancel">×</button>}
      <button className="button primary compact-button comment-add-button" disabled={saving || (!body.trim() && !image)}>{saving ? "…" : submitLabel}</button>
    </div>
    {imageError && <small className="comment-image-error">{imageError}</small>}
  </form>;
}
