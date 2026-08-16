import { useState } from "react";
import type { ProjectMapMarkdownEditorState } from "../../lib/project-owned-content";
import { ProjectMarkdown } from "./ProjectMarkdown";
import "./project-rich-content.css";

export interface ProjectMarkdownEditorProps {
  editor: ProjectMapMarkdownEditorState;
  ariaLabel?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function editorStatusLabel(editor: ProjectMapMarkdownEditorState) {
  switch (editor.status) {
    case "editing": return "Draft changes are local until saved.";
    case "saving": return "Saving the current revision…";
    case "uncertain": return "The save outcome is uncertain. Retry the exact operation before leaving.";
    case "conflict": return "This content changed elsewhere. Cancel and reopen it to load the current revision.";
    case "error": return "The save failed. The local draft is still available in this editor.";
  }
}

export default function ProjectMarkdownEditor({
  editor,
  ariaLabel = "Reading Markdown editor",
  onChange,
  onSave,
  onCancel,
}: ProjectMarkdownEditorProps) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const canSave = editor.status === "editing" || editor.status === "saving" || editor.status === "uncertain";
  const canCancel = editor.status !== "saving" && editor.status !== "uncertain";
  return <div className={`project-rich-editor ${editor.status}`}>
    <div className="project-rich-editor-tabs" role="tablist" aria-label="Markdown editor mode">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "write"}
        className={mode === "write" ? "active" : ""}
        onClick={() => setMode("write")}
      >Write</button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "preview"}
        className={mode === "preview" ? "active" : ""}
        onClick={() => setMode("preview")}
      >Preview</button>
    </div>

    {mode === "write" ? <textarea
      autoFocus
      aria-label={ariaLabel}
      value={editor.value}
      disabled={editor.status !== "editing"}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && editor.isNew && !editor.value.trim()) onCancel();
      }}
    /> : <div className="project-rich-editor-preview" role="tabpanel" aria-label="Markdown preview">
      <ProjectMarkdown source={editor.value} emptyLabel="The current draft is empty." />
    </div>}

    <p className="project-rich-editor-status" role="status">{editorStatusLabel(editor)}</p>
    {editor.message && <p className="error-banner">{editor.message}</p>}
    <div className="project-owned-content-pending-actions">
      {canSave && <button
        type="button"
        className="button primary compact-button"
        disabled={editor.status === "saving" || !editor.value.trim()}
        onClick={onSave}
      >{editor.status === "saving"
          ? "Saving…"
          : editor.status === "uncertain"
            ? "Retry exact save"
            : "Save Markdown"}</button>}
      {canCancel && <button type="button" className="button compact-button" onClick={onCancel}>Cancel</button>}
    </div>
  </div>;
}
