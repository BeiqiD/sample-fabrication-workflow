const DISCARD_MESSAGE = "Discard this unfinished process-plan comment? Text, prepared files, and unfinished uploads in this dialog will be lost.";

export function hasUnsavedProcessPlanComment(dialog: ParentNode) {
  const textarea = dialog.querySelector<HTMLTextAreaElement>(".grid-comment-composer textarea");
  if (textarea?.value.trim()) return true;
  return Boolean(dialog.querySelector(
    ".pending-draft-section, .local-submission-list, .rejected-image-card",
  ));
}

function processPlanDialog() {
  return document.querySelector<HTMLElement>(".process-plan-comment-dialog");
}

function isCloseAttempt(event: Event, dialog: HTMLElement) {
  if (event instanceof KeyboardEvent) return event.key === "Escape";
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (event.type === "mousedown") return target.classList.contains("process-plan-comment-backdrop");
  if (event.type !== "click") return false;
  const closeControl = target.closest("button");
  return Boolean(closeControl && dialog.contains(closeControl) && (
    closeControl.matches('[aria-label="Close process-plan comments"]')
    || closeControl.classList.contains("comment-cancel-button")
  ));
}

export function installProcessPlanCommentDraftGuard() {
  function guard(event: Event) {
    const dialog = processPlanDialog();
    if (!dialog || document.querySelector(".confirm-dialog-backdrop")) return;
    if (!isCloseAttempt(event, dialog) || !hasUnsavedProcessPlanComment(dialog)) return;
    if (window.confirm(DISCARD_MESSAGE)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  window.addEventListener("keydown", guard, true);
  document.addEventListener("mousedown", guard, true);
  document.addEventListener("click", guard, true);
  return () => {
    window.removeEventListener("keydown", guard, true);
    document.removeEventListener("mousedown", guard, true);
    document.removeEventListener("click", guard, true);
  };
}
