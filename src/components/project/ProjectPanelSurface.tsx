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
  className?: string;
  alert?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
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
    onClick={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}
  >
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={`project-panel-dialog${alert ? " project-panel-alert" : ""}`}
      role={alert ? "alertdialog" : "dialog"}
      aria-modal="true"
      aria-label={label}
    >{children}</div>
  </div>, document.body);
}
