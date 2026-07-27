import { ProcessingActionIcon } from "./ProcessingActionIcon";

export function processPlanCommentButtonLabel(commentCount: number, hasContent: boolean) {
  if (commentCount > 0) {
    const commentLabel = commentCount === 1 ? "1 existing comment" : `${commentCount} existing comments`;
    return `Open process-plan comments, ${commentLabel}`;
  }
  if (hasContent) return "Open process-plan comments, incomplete upload available";
  return "Add a comment to checked samples";
}

export function ProcessPlanCommentButton({
  commentCount,
  hasContent = commentCount > 0,
  expanded,
  disabled,
  className = "",
  onClick,
}: {
  commentCount: number;
  hasContent?: boolean;
  expanded: boolean;
  disabled: boolean;
  className?: string;
  onClick: () => void;
}) {
  const label = processPlanCommentButtonLabel(commentCount, hasContent);

  return <button
    type="button"
    className={`button compact-button recipe-icon-action recipe-comment-action${hasContent ? " has-comments" : ""}${className ? ` ${className}` : ""}`}
    title={label}
    aria-label={label}
    aria-expanded={expanded}
    disabled={disabled}
    onClick={onClick}
  >
    <ProcessingActionIcon name="comment" />
    <span className="recipe-action-label">Comment</span>
  </button>;
}
