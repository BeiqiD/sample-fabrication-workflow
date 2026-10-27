export type ActionIconName = "actions" | "delete" | "export" | "metrology" | "moon" | "plan-update" | "process" | "split" | "start" | "sun"
  | "plus" | "chevron-down" | "arrow-left" | "undo" | "redo" | "more" | "attachment" | "pin" | "save" | "grip" | "open" | "inspector" | "note" | "link" | "edit"
  | "package" | "report" | "upload" | "refresh" | "history" | "check" | "pause" | "play" | "stop" | "warning" | "preview" | "info";

const iconPaths: Record<ActionIconName, React.ReactNode> = {
  package: <path d="m12 3 9 5-9 5-9-5zM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5" />,
  report: <><path d="M6 3h8l4 4v14H6zM14 3v4h4" /><path d="M9 17v-3M12 17v-6M15 17v-4" /></>,
  upload: <path d="M12 15V3.5M8 7.5l4-4 4 4M5 17v3h14v-3" />,
  refresh: <path d="M20 11A8 8 0 0 0 6.5 5L4 7M4 3v4h4M4 13a8 8 0 0 0 13.5 6L20 17M20 21v-4h-4" />,
  history: <><path d="M3 4v5h5M3 9a9 9 0 1 1 1 10" /><path d="M12 7v5l3 2" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m8 4 12 8-12 8z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  warning: <><path d="m12 3 10 18H2L12 3ZM12 9v5" /><circle cx="12" cy="17.5" r=".5" /></>,
  preview: <><path d="M2 12S5.5 5 12 5s10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7.5" r=".5" /></>,
  edit: <><path d="m15 4 5 5-10 10-6 1 1-6zM13 6l5 5" /><path d="m15 4 1.5-1.5a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L20 9" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "arrow-left": <path d="M20 12H4m6-6-6 6 6 6" />,
  undo: <path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 7 7v3" />,
  redo: <path d="m16 4 5 5-5 5M21 9H11a7 7 0 0 0-7 7v3" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  attachment: <path d="m9 13 6-6a2.8 2.8 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M7 15l8-8" />,
  pin: <path d="m15 3 6 6-4 1-3 5-2 1-4-4 1-2 5-3zM10 14l-7 7" />,
  save: <><path d="M5 3.5h12l3.5 3.5v13.5h-17v-17zM8 3.5V9h8V3.5" /><path d="M8 20.5v-7h8v7" /></>,
  grip: <>{[6, 12, 18].map((y) => <g key={y}><circle cx="9" cy={y} r="1" /><circle cx="15" cy={y} r="1" /></g>)}</>,
  open: <path d="M14 4h6v6M20 4 10 14M10 4H4v16h16v-6" />,
  inspector: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M14 4v16M17 8h.5M17 12h.5" /></>,
  note: <><path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 12h6M9 16h4" /></>,
  link: <><path d="m10 7 2-2a5 5 0 0 1 7 7l-2 2M14 17l-2 2a5 5 0 0 1-7-7l2-2M8 16l8-8" /></>,
  actions: <>
    <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="12" r="2" />
    <circle cx="13" cy="17" r="2" />
  </>,
  delete: <>
    <path d="M5 7h14M9 7V4.5h6V7M7.5 7l.8 13h7.4l.8-13M10 10.5v6M14 10.5v6" />
  </>,
  export: <path d="M12 3.5v11M8 10.5l4 4 4-4M5 17v3h14v-3" />,
  metrology: <>
    <circle cx="10" cy="10" r="5.5" />
    <path d="m14 14 6 6M7.5 10h5M10 7.5v5" />
  </>,
  moon: <path d="M19.5 15.2A8.4 8.4 0 0 1 8.8 4.5 8.5 8.5 0 1 0 19.5 15.2Z" />,
  "plan-update": <>
    <path d="M5 3.5h9l4 4v5M14 3.5v4h4M8 10h6M8 14h3" />
    <path d="m12.5 19.5 5.5-5.5 2 2-5.5 5.5H12z" />
  </>,
  process: <>
    <path d="m4 7 8-4 8 4-8 4z" />
    <path d="m4 12 8 4 8-4M4 17l8 4 8-4" />
  </>,
  split: <>
    <path d="M12 3.5v6M12 9.5l-5 5v6M12 9.5l5 5v6" />
    <circle cx="7" cy="20.5" r="1.5" />
    <circle cx="17" cy="20.5" r="1.5" />
  </>,
  start: <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8v8M8 12h8" />
  </>,
  sun: <>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
  </>,
};

export function ActionIcon({ name }: { name: ActionIconName }) {
  return <svg
    className="action-icon"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {iconPaths[name]}
  </svg>;
}
