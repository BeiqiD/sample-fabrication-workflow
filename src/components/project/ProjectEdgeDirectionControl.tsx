import { useRef } from "react";
import type { ProjectEdgeDirection } from "../../lib/project-edges";
import "./project-edge-direction-control.css";

export interface ProjectEdgeDirectionControlProps {
  value: ProjectEdgeDirection;
  onChange: (value: ProjectEdgeDirection) => void;
  disabled?: boolean;
}

const directions: { value: ProjectEdgeDirection; label: string }[] = [
  { value: "undirected", label: "No arrow" },
  { value: "forward", label: "Source to target" },
  { value: "reverse", label: "Target to source" },
  { value: "bidirectional", label: "Both directions" },
];

export function ProjectEdgeDirectionControl({ value, onChange, disabled = false }: ProjectEdgeDirectionControlProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <div
    className="project-edge-direction-control nodrag nopan nowheel"
    role="radiogroup"
    aria-label="Edge direction"
    aria-disabled={disabled || undefined}
  >
    {directions.map((direction, index) => <button
      key={direction.value}
      ref={(element) => { buttons.current[index] = element; }}
      type="button"
      className="project-edge-direction-option"
      role="radio"
      aria-label={direction.label}
      title={direction.label}
      aria-checked={value === direction.value}
      tabIndex={value === direction.value ? 0 : -1}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (value !== direction.value) onChange(direction.value);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (disabled) return;
        let next: number;
        switch (event.key) {
          case "ArrowRight":
          case "ArrowDown": next = (index + 1) % directions.length; break;
          case "ArrowLeft":
          case "ArrowUp": next = (index + directions.length - 1) % directions.length; break;
          case "Home": next = 0; break;
          case "End": next = directions.length - 1; break;
          case "Enter":
          case " ": event.stopPropagation(); return;
          default: return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (value !== directions[next].value) onChange(directions[next].value);
        buttons.current[next]?.focus();
      }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M4 12h16" />
        {(direction.value === "forward" || direction.value === "bidirectional") && <path d="m16 8 4 4-4 4" />}
        {(direction.value === "reverse" || direction.value === "bidirectional") && <path d="m8 8-4 4 4 4" />}
        {direction.value === "undirected" && <path d="M4 10v4m16-4v4" />}
      </svg>
    </button>)}
  </div>;
}
