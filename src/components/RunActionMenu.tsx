import { useEffect, useRef, useState, type ReactNode } from "react";

export interface RunActionMenuItem {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function RunActionMenu({ label, icon, items, disabled = false, primary = false }: {
  label: string;
  icon: ReactNode;
  items: RunActionMenuItem[];
  disabled?: boolean;
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const unavailable = disabled || items.length === 0;

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);

  return <div className="run-action-menu" ref={menuRef}>
    <button
      type="button"
      className={`button run-action-menu-trigger${primary ? " primary" : ""}`}
      aria-label={label}
      title={items.length ? label : `No ${label.toLowerCase()} available`}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={unavailable}
      onClick={() => setOpen((shown) => !shown)}
    >
      {icon}
      <span className="run-action-menu-label">{label}</span>
      <span className="run-action-menu-caret" aria-hidden="true">▾</span>
    </button>
    {open && <div className="run-action-menu-panel" role="menu" aria-label={label}>
      {items.map((item) => <button
        type="button"
        role="menuitem"
        className={`run-action-menu-item${item.danger ? " danger" : ""}`}
        key={item.id}
        disabled={item.disabled}
        onClick={() => {
          setOpen(false);
          item.onSelect();
        }}
      >
        <span className="run-action-menu-item-icon">{item.icon}</span>
        <span className="run-action-menu-item-copy">
          <strong>{item.label}</strong>
          {item.description && <small>{item.description}</small>}
        </span>
      </button>)}
    </div>}
  </div>;
}
