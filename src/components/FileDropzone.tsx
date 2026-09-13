import { useEffect, useRef, useState } from "react";

interface FileDropzoneProps {
  accept: string;
  file: File | null;
  label: string;
  hint?: string;
  compact?: boolean;
  disabled?: boolean;
  capture?: "user" | "environment";
  onFile: (file: File | null) => void;
}

export function FileDropzone({ accept, file, label, hint, compact = false, disabled = false, capture, onFile }: FileDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file?.type.startsWith("image/")) { setPreviewUrl(""); return; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function browse() {
    if (disabled || !inputRef.current) return;
    inputRef.current.value = "";
    inputRef.current.click();
  }

  return <div
    className={`file-dropzone${compact ? " compact" : ""}${dragging ? " dragging" : ""}${file ? " has-file" : ""}`}
    role="button"
    tabIndex={disabled ? -1 : 0}
    aria-disabled={disabled}
    aria-label={file ? `Replace ${file.name}` : label}
    onClick={(event) => { if (!(event.target as HTMLElement).closest("button")) browse(); }}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); browse(); }
    }}
    onDragEnter={(event) => { event.preventDefault(); if (!disabled) { dragDepth.current += 1; setDragging(true); } }}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? "none" : "copy"; }}
    onDragLeave={(event) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDrop={(event) => {
      event.preventDefault(); dragDepth.current = 0; setDragging(false);
      if (!disabled) onFile(event.dataTransfer.files?.[0] ?? null);
    }}
  >
    <input ref={inputRef} type="file" accept={accept} capture={capture} disabled={disabled} onChange={(event) => { if (!disabled) onFile(event.target.files?.[0] ?? null); }} />
    {previewUrl && <img src={previewUrl} alt="Selected upload preview" />}
    <span className="file-drop-copy"><strong>{file ? file.name : label}</strong><small>{file ? `${Math.max(1, Math.round(file.size / 1024))} KB${disabled ? "" : " · drop another file to replace"}` : hint || "Drop a file here or click to browse"}</small></span>
    {file && <button type="button" className="text-button" disabled={disabled} onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (!disabled) onFile(null); }}>Remove</button>}
  </div>;
}
