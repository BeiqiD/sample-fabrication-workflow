// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectEdgeDirectionControl } from "./components/project/ProjectEdgeDirectionControl";
import type { ProjectEdgeDirection } from "./lib/project-edges";

afterEach(cleanup);

describe("Project edge direction buttons", () => {
  it("offers four named choices with one tab stop, and selects directly without submitting the edit form", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onChange = vi.fn();
    function Editor() {
      const [value, setValue] = useState<ProjectEdgeDirection>("forward");
      return <form onSubmit={onSubmit}>
        <ProjectEdgeDirectionControl value={value} onChange={(next) => { onChange(next); setValue(next); }} />
        <button type="submit">Save</button>
      </form>;
    }
    render(<Editor />);
    const group = screen.getByRole("radiogroup", { name: "Edge direction" });
    const radios = within(group).getAllByRole("radio") as HTMLButtonElement[];
    expect(radios).toHaveLength(4);
    expect(radios.filter((radio) => radio.tabIndex === 0)).toEqual([screen.getByRole("radio", { name: "Source to target", checked: true })]);
    for (const radio of radios) {
      expect(radio.textContent).toBe("");
      expect(radio.title).toBe(radio.getAttribute("aria-label"));
      fireEvent.click(radio);
      expect(radio.getAttribute("aria-checked")).toBe("true");
      expect(radios.filter((option) => option.tabIndex === 0)).toEqual([radio]);
    }
    expect(onChange.mock.calls.map(([direction]) => direction)).toEqual(["undirected", "forward", "reverse", "bidirectional"]);
    fireEvent.click(screen.getByRole("radio", { name: "Both directions" }));
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("moves focus and the chosen direction together with arrows and Home/End, without moving the canvas", () => {
    const onCanvasKeyDown = vi.fn();
    function Editor() {
      const [value, setValue] = useState<ProjectEdgeDirection>("forward");
      return <div onKeyDown={onCanvasKeyDown}><ProjectEdgeDirectionControl value={value} onChange={setValue} /></div>;
    }
    render(<Editor />);
    screen.getByRole("radio", { name: "Source to target" }).focus();
    const checks = [
      ["ArrowRight", "Target to source"],
      ["ArrowDown", "Both directions"],
      ["ArrowRight", "No arrow"],
      ["ArrowLeft", "Both directions"],
      ["ArrowUp", "Target to source"],
      ["Home", "No arrow"],
      ["End", "Both directions"],
    ];
    for (const [key, name] of checks) {
      fireEvent.keyDown(document.activeElement!, { key });
      const selected = screen.getByRole("radio", { name, checked: true });
      expect(document.activeElement).toBe(selected);
      expect(selected.tabIndex).toBe(0);
    }
    expect(onCanvasKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onCanvasKeyDown).toHaveBeenCalledOnce();
  });

  it("locks all four choices during a pending save", () => {
    const onChange = vi.fn();
    render(<ProjectEdgeDirectionControl value="forward" onChange={onChange} disabled />);
    const group = screen.getByRole("radiogroup", { name: "Edge direction" });
    expect(group.getAttribute("aria-disabled")).toBe("true");
    for (const radio of within(group).getAllByRole("radio") as HTMLButtonElement[]) {
      expect(radio.disabled).toBe(true);
      fireEvent.click(radio);
      fireEvent.keyDown(radio, { key: "ArrowRight" });
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Source to target", checked: true })).toBeTruthy();
  });
});
