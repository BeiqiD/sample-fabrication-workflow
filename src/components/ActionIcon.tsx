export type ActionIconName = "actions" | "export" | "metrology" | "moon" | "plan-update" | "process" | "split" | "start" | "sun";

const iconPaths: Record<ActionIconName, React.ReactNode> = {
  actions: <>
    <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="12" r="2" />
    <circle cx="13" cy="17" r="2" />
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
