// @vitest-environment jsdom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectNavigationDialog } from "./components/project/ProjectNavigationDialog";

afterEach(cleanup);

describe("Project navigation confirmation", () => {
  it("describes the blocker, initially focuses Stay, and restores the trigger after Escape", () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const message = "Save or discard this Markdown draft before leaving.";
    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return <>
        <button ref={triggerRef} onClick={() => setOpen(true)}>Leave Project</button>
        {open && <ProjectNavigationDialog
          message={message} onStay={() => setOpen(false)} returnFocusRef={triggerRef}
          primaryActions={<button className="button primary" onClick={onSave}>Save Markdown and leave</button>}
          secondaryActions={<button className="button" onClick={onDiscard}>Discard Markdown and leave</button>}
        />}
      </>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Leave Project" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "Unsaved Project changes" });
    const descriptionId = dialog.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)?.textContent).toBe(message);
    expect(within(dialog).getByRole("heading", { name: "Unsaved changes" })).toBeTruthy();
    const stay = within(dialog).getByRole("button", { name: "Stay on Project" });
    const save = within(dialog).getByRole("button", { name: "Save Markdown and leave" });
    expect(document.activeElement).toBe(stay);
    fireEvent.keyDown(stay, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onSave).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });
});
