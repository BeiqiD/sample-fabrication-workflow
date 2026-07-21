import type { StepStatus } from "../../shared/types";

const statusMarks: Record<StepStatus, React.ReactNode> = {
  pending: <circle cx="12" cy="12" r="5.5" />,
  in_progress: <><path d="M7.4 9.1A5.5 5.5 0 0 1 17 8" /><path d="m17 5.5.2 3.2-3.2.2" /><path d="M16.6 14.9A5.5 5.5 0 0 1 7 16" /><path d="m7 18.5-.2-3.2 3.2-.2" /></>,
  done: <path d="m6.5 12.3 3.4 3.3 7.6-7.4" />,
  skipped: <path d="M7 12h10" />,
  blocked: <><path d="M12 7.5v5.7" /><circle cx="12" cy="16.5" r=".7" fill="currentColor" stroke="none" /></>,
};

export function StepStatusIcon({ status }: { status: StepStatus }) {
  return <svg
    className="step-status-icon"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {statusMarks[status]}
  </svg>;
}
