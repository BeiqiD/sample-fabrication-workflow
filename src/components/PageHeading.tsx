import type { ReactNode } from "react";

/** Shared page chrome; the owning page keeps its actions and business state. */
export function PageHeading({ title, description, actions }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return <div className="page-heading">
    <div><h1>{title}</h1>{description && <p className="lead">{description}</p>}</div>
    {actions && <div className="header-actions">{actions}</div>}
  </div>;
}
