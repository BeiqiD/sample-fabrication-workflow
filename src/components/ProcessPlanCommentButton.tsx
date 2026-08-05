import { ProcessingActionIcon } from "./ProcessingActionIcon";

type CommonCommentContext = "process-plan" | "metrology";

export function processPlanCommentButtonLabel(commentCount: number, hasContent: boolean, context: CommonCommentContext = "process-plan") {
  const subject = context === "metrology" ? "metrology" : "process-plan";
  if (commentCount > 0) {
    const commentLabel = commentCount === 1 ? "1 existing comment" : `${commentCount} existing comments`;
    return `Open ${subject} comments, ${commentLabel}`;
  }
  if (hasContent) return `Open ${subject} comments, incomplete upload available`;
  return "Add a comment to checked samples";
}

export function ProcessPlanCommentButton({
  commentCount,
  hasContent = commentCount > 0,
  expanded,
  disabled,
  context = "process-plan",
  className = "",
  onClick,
}: {
  commentCount: number;
  hasContent?: boolean;
  expanded: boolean;
  disabled: boolean;
  context?: CommonCommentContext;
  className?: string;
  onClick: () => void;
}) {
  const label = processPlanCommentButtonLabel(commentCount, hasContent, context);

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
