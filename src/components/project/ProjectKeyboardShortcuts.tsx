import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "../../lib/use-modal-dialog";
import { DialogCloseIcon } from "../DialogCloseIcon";
import "./project-keyboard-shortcuts.css";

function Keys({ children, command = false }: { children: ReactNode; command?: boolean }) {
  return <span className="project-shortcuts-keys">
    {command && <><kbd>Ctrl / ⌘</kbd><span aria-hidden="true">+</span></>}
    {children}
  </span>;
}

function Shortcut({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="project-shortcuts-row">
    <dt>{label}{note && <span className="project-shortcuts-row-note">{note}</span>}</dt>
    <dd>{children}</dd>
  </div>;
}

function ShortcutDialog({ id, mapActive, returnFocusRef, onClose }: {
  id: string;
  mapActive: boolean;
  returnFocusRef: { current: HTMLButtonElement | null };
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backdropPointerRef = useRef<{ id: number; outside: boolean; released: boolean } | null>(null);
  const { requestClose } = useModalDialog({
    dialogRef, initialFocusRef: closeRef, returnFocusRef, onClose, inertBackground: true,
  });

  return createPortal(<div
    className="project-shortcuts-backdrop"
    data-project-shortcut-scope="help"
    onKeyDown={(event) => {
      // This reference owns its keyboard events, while text selection and copy
      // retain their browser defaults. Saving has no action in a help dialog.
      event.stopPropagation();
      if (!event.nativeEvent.isComposing && !event.altKey && !event.shiftKey
        && event.ctrlKey !== event.metaKey && event.key.toLowerCase() === "s") event.preventDefault();
    }}
    onPointerDownCapture={(event) => {
      backdropPointerRef.current = {
        id: event.pointerId,
        outside: event.isPrimary && event.button === 0 && event.target === event.currentTarget,
        released: false,
      };
    }}
    onPointerUpCapture={(event) => {
      const pointer = backdropPointerRef.current;
      if (!pointer) return;
      pointer.released = pointer.id === event.pointerId && event.isPrimary && event.button === 0;
      pointer.outside = pointer.outside && event.target === event.currentTarget;
    }}
    onPointerCancelCapture={() => { backdropPointerRef.current = null; }}
    onPointerDown={(event) => event.stopPropagation()}
    onPointerUp={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      const pointer = backdropPointerRef.current;
      backdropPointerRef.current = null;
      // Dragging selected help text across the boundary must not dismiss it.
      if (event.target === event.currentTarget && event.button === 0
        && (event.detail === 0 || (pointer?.outside && pointer.released))) requestClose();
    }}
  >
    <section
      ref={dialogRef}
      id={id}
      className="project-shortcuts-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      data-project-shortcut-scope="help"
    >
      <header className="project-shortcuts-header">
        <div>
          <h2 id={`${id}-title`}>Keyboard shortcuts</h2>
          <p id={`${id}-description`}>Use ⌘ on Mac, Ctrl on Windows or Linux.</p>
        </div>
        <button ref={closeRef} type="button" className="project-shortcuts-icon-button"
          title="Close keyboard shortcuts" aria-label="Close keyboard shortcuts" onClick={requestClose}>
          <DialogCloseIcon />
        </button>
      </header>
      <div className="project-shortcuts-body" tabIndex={0} role="region" aria-label="Shortcut reference">
        <section className="project-shortcuts-group" aria-labelledby={`${id}-workspace`}>
          <h3 id={`${id}-workspace`}>Workspace</h3>
          <dl>
            <Shortcut label="Save" note="Saves the active edit, or project changes.">
              <Keys command><kbd>S</kbd></Keys>
            </Shortcut>
            <Shortcut label="Dismiss or cancel" note="Closes one layer at a time; otherwise cancels an edit or clears the selection.">
              <Keys><kbd>Esc</kbd></Keys>
            </Shortcut>
          </dl>
        </section>
        <section className="project-shortcuts-group" aria-labelledby={`${id}-canvas`}>
          <div className="project-shortcuts-group-heading">
            <h3 id={`${id}-canvas`}>Map canvas</h3>
            {!mapActive && <span className="project-shortcuts-view-note">Available in Map view</span>}
          </div>
          <p className="project-shortcuts-group-note">Focus the canvas to use these shortcuts.</p>
          <dl>
            <Shortcut label="Undo"><Keys command><kbd>Z</kbd></Keys></Shortcut>
            <Shortcut label="Redo"><Keys command><kbd>Shift</kbd><span aria-hidden="true">+</span><kbd>Z</kbd></Keys></Shortcut>
            <Shortcut label="Copy selected cards"><Keys command><kbd>C</kbd></Keys></Shortcut>
            <Shortcut label="Paste cards"><Keys command><kbd>V</kbd></Keys></Shortcut>
            <Shortcut label="Select all cards"><Keys command><kbd>A</kbd></Keys></Shortcut>
            <Shortcut label="Remove selected cards or edge">
              <Keys><kbd>Delete</kbd><span className="project-shortcuts-key-alternative">or</span><kbd>Backspace</kbd></Keys>
            </Shortcut>
          </dl>
        </section>
        <p className="project-shortcuts-footnote">Text fields keep their usual editing shortcuts. Canvas paste uses cards copied within this app.</p>
      </div>
    </section>
  </div>, document.body);
}

export function ProjectKeyboardShortcuts({ mapActive = true, onOpen }: { mapActive?: boolean; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  return <>
    <button
      ref={triggerRef}
      type="button"
      className="project-shortcuts-icon-button project-shortcuts-trigger"
      title="Keyboard shortcuts"
      aria-label="Keyboard shortcuts"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      onClick={() => {
        onOpen?.();
        triggerRef.current?.focus({ preventScroll: true });
        setOpen(true);
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M7 13h.01M10.3 13h.01M13.7 13h.01M17 13h.01M8 16h8" />
      </svg>
    </button>
    {open && <ShortcutDialog id={id} mapActive={mapActive} returnFocusRef={triggerRef} onClose={() => setOpen(false)} />}
  </>;
}
