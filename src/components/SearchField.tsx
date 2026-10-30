import type { InputHTMLAttributes } from "react";

export function SearchField({ label = "Search", className = "", ...input }:
  InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return <label className={`search-box ${className}`.trim()}>
    <span>{label}</span>
    <input type="search" name="q" autoComplete="off" {...input} />
  </label>;
}
