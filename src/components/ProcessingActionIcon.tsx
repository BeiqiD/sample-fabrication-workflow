export type ProcessingActionIconName = "done" | "comment";

const iconPaths: Record<ProcessingActionIconName, React.ReactNode> = {
  done: <path d="m5 12.5 4.2 4L19 7" />,
  comment: <path d="M5.5 5.5h13v9.5h-7.4L7 18.5V15H5.5z" />,
};

export function ProcessingActionIcon({ name }: { name: ProcessingActionIconName }) {
  return <svg
    className="processing-action-icon"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {iconPaths[name]}
  </svg>;
}
