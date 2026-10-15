import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectMapMarkdownEditorState } from "../../lib/project-owned-content";
import { useModalDialog } from "../../lib/use-modal-dialog";
import { ProjectEditorFeedback } from "./ProjectEditorFeedback";
import { ProjectMarkdown } from "./ProjectMarkdown";
import "./project-rich-content.css";
import "./project-markdown-editor.css";

export interface ProjectMarkdownEditorProps {
  editor: ProjectMapMarkdownEditorState;
  ariaLabel?: string;
  compact?: boolean;
  interactionDisabled?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function editorStatusLabel(editor: ProjectMapMarkdownEditorState) {
  switch (editor.status) {
    case "editing": return "Draft changes are local until saved.";
    case "saving": return "Saving the current revision…";
    case "uncertain": return "The save outcome is uncertain. Retry the exact operation before leaving.";
    case "conflict": return "This content changed elsewhere. Discard this draft and reload to use the current revision.";
    case "error": return "The save was rejected. Correct the draft and save again.";
  }
}

type EditorMode = "write" | "preview";

type EditorBodyProps = ProjectMarkdownEditorProps & {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  onCompositionStart: (value: string) => void;
  onExpand?: () => void;
  autoFocus?: boolean;
};

function ProjectMarkdownEditorBody({
  editor,
  ariaLabel,
  compact = false,
  interactionDisabled = false,
  mode,
  onModeChange,
  onCompositionStart,
  onExpand,
  autoFocus = true,
  onChange,
  onSave,
  onCancel,
}: EditorBodyProps) {
  const tabId = useId();
  const canEdit = editor.status === "editing" || editor.status === "error";
  const canSave = canEdit || editor.status === "saving" || editor.status === "uncertain";
  const canCancel = editor.status !== "saving" && editor.status !== "uncertain";
  return <div
    className={`project-rich-editor ${editor.status}${compact ? " compact" : ""}`}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      // Keep unresolved saves/conflicts open rather than letting the canvas or
      // Inspector consume Escape and silently abandon the recovery controls.
      if (canEdit && !interactionDisabled) onCancel();
    }}
  >
    <div className="project-rich-editor-toolbar">
      <div className="project-rich-editor-tabs" role="tablist" aria-label="Markdown editor mode">
        {(["write", "preview"] as const).map((tab) => <button
          key={tab}
          type="button"
          role="tab"
          id={`${tabId}-${tab}`}
          aria-controls={`${tabId}-panel`}
          aria-selected={mode === tab}
          tabIndex={mode === tab ? 0 : -1}
          className={mode === tab ? "active" : ""}
          onClick={() => onModeChange(tab)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const next = event.key === "Home" ? "write" : event.key === "End" ? "preview" : tab === "write" ? "preview" : "write";
            onModeChange(next);
            document.getElementById(`${tabId}-${next}`)?.focus();
          }}
        >{tab === "write" ? "Write" : "Preview"}</button>)}
      </div>
      {onExpand && <button type="button" className="button compact-button" disabled={interactionDisabled} onClick={(event) => {
        event.currentTarget.focus();
        onExpand();
      }}>Expand editor</button>}
    </div>

    <div id={`${tabId}-panel`} className="project-rich-editor-panel" role="tabpanel" aria-labelledby={`${tabId}-${mode}`}>
      {mode === "write" ? <textarea
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        value={editor.value}
        disabled={!canEdit}
        onChange={(event) => onChange(event.currentTarget.value)}
        onCompositionStart={(event) => onCompositionStart(event.currentTarget.value)}
        onCompositionEnd={(event) => onChange(event.currentTarget.value)}
      /> : <div className="project-rich-editor-preview" tabIndex={0} aria-label="Markdown preview">
        <ProjectMarkdown source={editor.value} emptyLabel="The current draft is empty." />
      </div>}
    </div>

    {(!compact || editor.status !== "editing" || editor.message) && <ProjectEditorFeedback
      status={editor.status}
      summary={editorStatusLabel(editor)}
      message={editor.message}
    />}
    <div className="project-owned-content-pending-actions">
      {canSave && <button
        type="button"
        className="button primary compact-button"
        disabled={interactionDisabled || editor.status === "saving" || !editor.value.trim()}
        title="Save Markdown (Ctrl/Cmd+S)"
        onClick={onSave}
      >{editor.status === "saving"
          ? "Saving…"
          : editor.status === "uncertain"
            ? "Retry exact save"
            : "Save Markdown"}</button>}
      {canCancel && <button
        type="button"
        className="button compact-button"
        disabled={interactionDisabled}
        aria-keyshortcuts={canEdit && !interactionDisabled ? "Escape" : undefined}
        onClick={onCancel}
      >{editor.status === "conflict" ? "Discard draft and reload" : "Cancel"}</button>}
    </div>
  </div>;
}

function ExpandedMarkdownEditor({ onClose, ...props }: EditorBodyProps & { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useModalDialog({ dialogRef, initialFocusRef: closeButtonRef, onClose });
  return createPortal(<div
    className="project-expanded-editor-backdrop nodrag nopan nowheel"
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
  >
    <div ref={dialogRef} className="project-expanded-editor-dialog" role="dialog" aria-modal="true" aria-label="Expanded Markdown editor">
      <header className="project-expanded-editor-heading">
        <strong>{props.editor.isNew ? "New Markdown note" : "Edit Markdown note"}</strong>
        <button ref={closeButtonRef} type="button" className="button compact-button" onClick={onClose}>Collapse editor</button>
      </header>
      <ProjectMarkdownEditorBody {...props} compact={false} autoFocus={false} />
    </div>
  </div>, document.body);
}

function ProjectMarkdownEditorSession({
  ariaLabel = "Reading Markdown editor",
  compact = false,
  ...props
}: ProjectMarkdownEditorProps) {
  const [mode, setMode] = useState<EditorMode>("write");
  const [expanded, setExpanded] = useState(false);
  // A live draft must echo synchronously: Map node props pass through two
  // effect-driven projections before returning here. Reapplying that delayed
  // value to a controlled textarea interrupts the browser's IME composition.
  // This editing session owns its text after the first input/composition;
  // parent props still supply status and geometry, but cannot roll it back.
  const [localValue, setLocalValue] = useState<string | null>(null);
  const value = localValue ?? props.editor.value;
  const valueRef = useRef(value);
  valueRef.current = value;
  const changeDraft = (next: string) => {
    const changed = valueRef.current !== next;
    valueRef.current = next;
    setLocalValue(next);
    // compositionend can precede or follow the final input event. Reading the
    // whole DOM value and suppressing an identical echo handles both orders,
    // including a cancelled composition, without appending event.data.
    if (changed) props.onChange(next);
  };
  const sharedProps = {
    ...props,
    editor: { ...props.editor, value },
    ariaLabel,
    compact,
    mode,
    onModeChange: setMode,
    onChange: changeDraft,
    onCompositionStart: changeDraft,
  };
  return <div className={`project-markdown-editor-shell nodrag nopan nowheel${compact ? " compact" : ""}`}>
    <div hidden={expanded}>
      <ProjectMarkdownEditorBody {...sharedProps} onExpand={() => setExpanded(true)} />
    </div>
    {expanded && <>
      <p className="project-rich-editor-expanded-notice">Editing in the expanded editor.</p>
      <ExpandedMarkdownEditor {...sharedProps} onClose={() => setExpanded(false)} />
    </>}
  </div>;
}

export default function ProjectMarkdownEditor(props: ProjectMarkdownEditorProps) {
  // Reload/discard closes the session; switching identity starts a fresh one.
  const sessionKey = JSON.stringify([props.editor.itemId, props.editor.isNew]);
  return <ProjectMarkdownEditorSession key={sessionKey} {...props} />;
}
