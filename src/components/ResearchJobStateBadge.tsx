import type { ResearchJobStatus } from "../../shared/contracts/research-package-api";
import { ActionIcon, type ActionIconName } from "./ActionIcon";
import "./research-job-state.css";

const states: Record<ResearchJobStatus["state"], { icon: ActionIconName; tone: string }> = {
  awaiting_upload: { icon: "upload", tone: "neutral" },
  queued: { icon: "history", tone: "neutral" },
  running: { icon: "refresh", tone: "info" },
  preview: { icon: "preview", tone: "info" },
  paused: { icon: "pause", tone: "neutral" },
  cancel_requested: { icon: "stop", tone: "warning" },
  completed: { icon: "check", tone: "info" },
  cancelled: { icon: "stop", tone: "danger" },
};

export function ResearchJobStateBadge({ state }: { state: ResearchJobStatus["state"] }) {
  const { icon, tone } = states[state];
  return <span className={`research-job-state research-job-state--${tone}`}>
    <ActionIcon name={icon} /><span>{state.replaceAll("_", " ")}</span>
  </span>;
}
