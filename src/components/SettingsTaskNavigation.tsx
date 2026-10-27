import "../settings-tasks.css";

export function SettingsTaskNavigation({ label, items }: {
  label: string;
  items: Array<{ id: string; label: string }>;
}) {
  return <nav className="settings-task-navigation" aria-label={label}>
    <span>On this page</span>
    <ul>{items.map(item => <li key={item.id}><a href={`#${item.id}`}>{item.label}</a></li>)}</ul>
  </nav>;
}
