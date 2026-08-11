export type NavigationIconName = "brand" | "processing" | "samples" | "projects" | "search" | "templates" | "export";

const iconPaths: Record<NavigationIconName, React.ReactNode> = {
  brand: <>
    <rect x="3.5" y="4" width="6.5" height="6.5" rx="1.6" />
    <rect x="14" y="13.5" width="6.5" height="6.5" rx="1.6" />
    <path d="M10 7.25h2a5 5 0 0 1 5 5v1.25" />
    <path d="m14.5 11 2.5 2.5 2.5-2.5" />
  </>,
  processing: <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m10 8.5 5 3.5-5 3.5Z" fill="currentColor" stroke="none" />
  </>,
  samples: <>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
  </>,
  projects: <>
    <rect x="3.5" y="4" width="7" height="6" rx="1.5" />
    <rect x="13.5" y="4" width="7" height="6" rx="1.5" />
    <rect x="8.5" y="14" width="7" height="6" rx="1.5" />
    <path d="M7 10v2h10v-2M12 12v2" />
  </>,
  search: <>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.4 15.4 4.1 4.1" />
  </>,
  templates: <>
    <path d="M6 3.5h8l4 4v13H6z" />
    <path d="M14 3.5v4h4M9 11.5h6M9 15.5h6" />
  </>,
  export: <>
    <path d="M12 3.5v11M8 10.5l4 4 4-4M5 17v3h14v-3" />
  </>,
};

export function NavigationIcon({ name }: { name: NavigationIconName }) {
  return <svg
    className="navigation-icon"
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
