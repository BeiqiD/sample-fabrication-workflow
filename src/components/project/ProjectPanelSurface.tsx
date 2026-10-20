import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "../../lib/use-modal-dialog";
import "./project-panel-surface.css";

/** Presentation only: callers retain selection, drafts and pending operations. */
export function ProjectPanelSurface({
  children,
  modal,
  label,
  onClose,
  blocked = false,
  returnFocusRef,
  initialFocusRef,
  descriptionId,
  className = "",
  alert = false,
}: {
  children: ReactNode;
  modal: boolean;
  label: string;
  onClose: () => void;
  blocked?: boolean;
  returnFocusRef?: { current: HTMLElement | null };
  initialFocusRef?: { current: HTMLElement | null };
  descriptionId?: string;
  className?: string;
  alert?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropPointerRef = useRef<{ id: number; outside: boolean; released: boolean } | null>(null);
  const { requestClose } = useModalDialog({
    dialogRef,
    initialFocusRef,
    returnFocusRef,
    onClose,
    blocked,
    enabled: modal,
    inertBackground: true,
  });

  if (!modal) return className ? <div className={className}>{children}</div> : <>{children}</>;
  return createPortal(<div
    className={`project-panel-backdrop${alert ? " project-panel-alert-backdrop" : ""}`}
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
    onClick={(event) => {
      const pointer = backdropPointerRef.current;
      backdropPointerRef.current = null;
      // A click can target the common ancestor of an inside press and outside
      // release. Require both ends on the backdrop; detail=0 keeps non-pointer
      // activation available to assistive technology.
      if (event.target === event.currentTarget && event.button === 0
        && (event.detail === 0 || (pointer?.outside && pointer.released))) requestClose();
    }}
  >
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={`project-panel-dialog${alert ? " project-panel-alert" : ""}`}
      role={alert ? "alertdialog" : "dialog"}
      aria-modal="true"
      aria-label={label}
      aria-describedby={descriptionId}
    >{children}</div>
  </div>, document.body);
}
