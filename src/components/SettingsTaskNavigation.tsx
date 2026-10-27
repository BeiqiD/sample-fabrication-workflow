import { useLocation } from "react-router-dom";
import { ActionIcon, type ActionIconName } from "./ActionIcon";
import "../settings-tasks.css";

export function SettingsTaskNavigation({ label, items, mobileIconOnly = false }: {
  label: string;
  items: Array<{ id: string; label: string; icon?: ActionIconName }>;
  mobileIconOnly?: boolean;
}) {
  const { hash } = useLocation();
  return <nav className={`settings-task-navigation${mobileIconOnly ? " settings-task-navigation--mobile-icons" : ""}`} aria-label={label}>
    <span>On this page</span>
    <ul>{items.map(item => <li key={item.id}><a href={`#${item.id}`} aria-label={item.label} title={item.label}
      aria-current={hash === `#${item.id}` ? "location" : undefined}>
      {item.icon && <ActionIcon name={item.icon} />}<span className="settings-task-label">{item.label}</span>
    </a></li>)}</ul>
  </nav>;
}
