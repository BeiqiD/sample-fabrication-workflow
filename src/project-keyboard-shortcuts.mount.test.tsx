// @vitest-environment jsdom
import { StrictMode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectKeyboardShortcuts } from "./components/project/ProjectKeyboardShortcuts";
import { useModalDialog } from "./lib/use-modal-dialog";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
  document.getSelection()?.removeAllRanges();
});

function openShortcuts() {
  const trigger = screen.getByRole("button", { name: "Keyboard shortcuts" });
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "Keyboard shortcuts" }) };
}

// jsdom has no PointerEvent or native pointer-to-click synthesis.
function pointer(target: HTMLElement, type: "pointerdown" | "pointerup") {
  const event = new MouseEvent(type, { bubbles: true, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  fireEvent(target, event);
}

describe("Project keyboard shortcuts reference", () => {
  it("opens a labelled reference with separate workspace and canvas instructions", () => {
    const onOpen = vi.fn();
    render(<ProjectKeyboardShortcuts mapActive={false} onOpen={onOpen} />);
    const { trigger, dialog } = openShortcuts();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(within(dialog).getByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Map canvas" })).toBeTruthy();
    expect(within(dialog).getByText("Available in Map view")).toBeTruthy();
    expect(within(dialog).getByText("Saves the active edit, or project changes.")).toBeTruthy();
    expect(within(dialog).getByText(/Canvas paste uses cards copied within this app/)).toBeTruthy();
  });

  it("traps focus around its close button and scrollable reference, then restores its trigger", () => {
    const view = render(<StrictMode><button>Outside action</button><ProjectKeyboardShortcuts /></StrictMode>);
    const { trigger, dialog } = openShortcuts();
    const close = within(dialog).getByRole("button", { name: "Close keyboard shortcuts" });
    const reference = within(dialog).getByRole("region", { name: "Shortcut reference" });
    expect(document.activeElement).toBe(close);
    expect(view.container.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(reference);
    fireEvent.keyDown(reference, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    screen.getByText("Outside action").focus();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(view.container.hasAttribute("inert")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
  });

  it("closes only the help layer above another modal and returns focus through both layers", () => {
    const closeEditor = vi.fn();
    function Editor({ onClose }: { onClose: () => void }) {
      const ref = useRef<HTMLDivElement>(null);
      useModalDialog({ dialogRef: ref, onClose, inertBackground: true });
      return createPortal(<div ref={ref} role="dialog" aria-modal="true" aria-label="Underlying editor">
        <ProjectKeyboardShortcuts />
      </div>, document.body);
    }
    function Harness() {
      const [editing, setEditing] = useState(false);
      return <><button onClick={() => setEditing(true)}>Edit note</button>
        {editing && <Editor onClose={() => { closeEditor(); setEditing(false); }} />}
      </>;
    }
    render(<Harness />);
    const edit = screen.getByRole("button", { name: "Edit note" });
    edit.focus();
    fireEvent.click(edit);
    const { trigger, dialog } = openShortcuts();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Underlying editor" })).toBeTruthy();
    expect(closeEditor).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(closeEditor).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(edit);
  });

  it("blocks background saving and canvas key handlers while preserving native text selection and copy", () => {
    const backgroundShortcut = vi.fn();
    const reactAncestorShortcut = vi.fn();
    render(<div onKeyDown={reactAncestorShortcut}><ProjectKeyboardShortcuts /></div>);
    const { dialog } = openShortcuts();
    const note = within(dialog).getByText(/Canvas paste uses cards copied within this app/);
    within(dialog).getByRole("region", { name: "Shortcut reference" }).focus();
    const range = document.createRange();
    range.selectNodeContents(note);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(document.getSelection()?.toString()).toBe(note.textContent);
    document.addEventListener("keydown", backgroundShortcut);
    try {
      for (const modifier of ["ctrlKey", "metaKey"]) {
        const save = createEvent.keyDown(note, { key: "s", [modifier]: true });
        fireEvent(note, save);
        expect(save.defaultPrevented).toBe(true);
        for (const key of ["a", "c", "v", "z"]) {
          const nativeKey = createEvent.keyDown(note, { key, [modifier]: true });
          fireEvent(note, nativeKey);
          expect(nativeKey.defaultPrevented).toBe(false);
        }
      }
      const combinedModifiers = createEvent.keyDown(note, { key: "s", ctrlKey: true, metaKey: true });
      fireEvent(note, combinedModifiers);
      expect(combinedModifiers.defaultPrevented).toBe(false);
      expect(document.getSelection()?.toString()).toBe(note.textContent);
      const copy = createEvent.copy(note);
      fireEvent(note, copy);
      expect(copy.defaultPrevented).toBe(false);
      expect(backgroundShortcut).not.toHaveBeenCalled();
      expect(reactAncestorShortcut).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", backgroundShortcut);
    }
  });

  it.each(["Enter", " "])("preserves native %s button activation without handling the key twice", (key) => {
    const onOpen = vi.fn();
    render(<ProjectKeyboardShortcuts onOpen={onOpen} />);
    const trigger = screen.getByRole("button", { name: "Keyboard shortcuts" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("type")).toBe("button");
    trigger.focus();
    const down = createEvent.keyDown(trigger, { key });
    const up = createEvent.keyUp(trigger, { key });
    fireEvent(trigger, down);
    fireEvent(trigger, up);
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    // jsdom does not synthesize button activation from keyboard input. Deliver
    // the browser's resulting click separately, keeping that limitation clear.
    fireEvent.click(trigger, { detail: 0 });
    expect(onOpen).toHaveBeenCalledOnce();
    const close = screen.getByRole("button", { name: "Close keyboard shortcuts" });
    const closeDown = createEvent.keyDown(close, { key });
    const closeUp = createEvent.keyUp(close, { key });
    fireEvent(close, closeDown);
    fireEvent(close, closeUp);
    expect(closeDown.defaultPrevented).toBe(false);
    expect(closeUp.defaultPrevented).toBe(false);
    fireEvent.click(close, { detail: 0 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not dismiss on text selection across its boundary or pass a backdrop click to the workspace", () => {
    const workspaceClick = vi.fn();
    render(<div onClick={workspaceClick}><ProjectKeyboardShortcuts /></div>);
    const { trigger, dialog } = openShortcuts();
    workspaceClick.mockClear();
    const backdrop = dialog.parentElement!;
    const text = within(dialog).getByText("Copy selected cards");
    pointer(text, "pointerdown");
    pointer(backdrop, "pointerup");
    fireEvent.click(backdrop, { detail: 1 });
    expect(screen.getByRole("dialog")).toBe(dialog);
    pointer(backdrop, "pointerdown");
    pointer(backdrop, "pointerup");
    fireEvent.click(backdrop, { detail: 1 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(workspaceClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});
