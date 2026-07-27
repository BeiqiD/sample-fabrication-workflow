import { ProcessingActionIcon } from "./ProcessingActionIcon";

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
  const commentLabel = commentCount === 1 ? "1 existing comment" : `${commentCount} existing comments`;
  const label = commentCount > 0
    ? `Open comments on selected samples, ${commentLabel}`
    : "Comment on selected samples";

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
