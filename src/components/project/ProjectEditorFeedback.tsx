import type { ProjectOwnedContentMutationStatus } from "../../lib/project-owned-content";
import "./project-rich-content.css";

export interface ProjectEditorFeedbackProps {
  status: ProjectOwnedContentMutationStatus;
  summary?: string | null;
  message?: string | null;
  className?: string;
}

function projectEditorFeedbackTone(status: ProjectOwnedContentMutationStatus) {
  if (status === "uncertain") return "warning";
  if (status === "error" || status === "conflict") return "danger";
  return "neutral";
}

export function ProjectEditorFeedback({
  status,
  summary = null,
  message = null,
  className = "",
}: ProjectEditorFeedbackProps) {
  if (!summary && !message) return null;
  const tone = projectEditorFeedbackTone(status);
  return <div
    className={`project-editor-feedback ${tone}${className ? ` ${className}` : ""}`}
    data-project-editor-status={status}
    role={tone === "danger" ? "alert" : "status"}
  >
    {summary && <p>{summary}</p>}
    {message && <p className="project-editor-feedback-detail">{message}</p>}
  </div>;
}
