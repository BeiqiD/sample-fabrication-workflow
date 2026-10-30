import { useState, type ReactNode } from "react";

export function ProjectInspectorDisclosure({
  className,
  title,
  open,
  onOpenChange,
  children,
}: {
  className: string;
  title: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const expanded = open ?? localOpen;
  return <details className={className} open={expanded}>
    <summary onClick={(event) => {
      // A native toggle event is asynchronous and also fires on remount. Record
      // the explicit click (including keyboard activation) instead, so a panel
      // being replaced cannot overwrite the session's latest choice.
      event.preventDefault();
      if (onOpenChange) onOpenChange(!expanded);
      else setLocalOpen(!expanded);
    }}>{title}</summary>
    {children}
  </details>;
}
