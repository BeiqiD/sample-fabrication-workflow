import { useId, useRef, type ReactNode } from "react";
import { ProjectPanelSurface } from "./ProjectPanelSurface";
import "./project-navigation-dialog.css";

/** The caller owns navigation guards and supplies the currently valid actions. */
export function ProjectNavigationDialog({
  message,
  onStay,
  returnFocusRef,
  primaryActions,
  secondaryActions,
}: {
  message: string;
  onStay: () => void;
  returnFocusRef?: { current: HTMLElement | null };
  primaryActions?: ReactNode;
  secondaryActions?: ReactNode;
}) {
  const descriptionId = useId();
  const stayButtonRef = useRef<HTMLButtonElement>(null);

  return <ProjectPanelSurface
    modal alert label="Unsaved Project changes" descriptionId={descriptionId}
    onClose={onStay} returnFocusRef={returnFocusRef} initialFocusRef={stayButtonRef}
  >
    <div className="project-navigation-dialog">
      <header className="project-navigation-dialog__header">
        <h2>Unsaved changes</h2>
      </header>
      <p id={descriptionId} className="project-navigation-dialog__message">{message}</p>
      <footer className="project-navigation-dialog__footer">
        <button ref={stayButtonRef} type="button" className="button project-navigation-dialog__stay" onClick={onStay}>
          Stay on Project
        </button>
        <div className="project-navigation-dialog__secondary-actions">{secondaryActions}</div>
        <div className="project-navigation-dialog__primary-actions">{primaryActions}</div>
      </footer>
    </div>
  </ProjectPanelSurface>;
}
