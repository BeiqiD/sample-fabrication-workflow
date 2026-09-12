// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectMapMarkdownEditorState } from "./lib/project-owned-content";
import ProjectMarkdownEditor from "./components/project/ProjectMarkdownEditor";

afterEach(cleanup);

describe("Expanded Markdown editor", () => {
  it("keeps typing available but defers Save and Cancel until a card resize ends", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const onChange = vi.fn();
    const editor: ProjectMapMarkdownEditorState = {
      itemId: "note", value: "Unsaved note", isNew: false, geometry: null,
      status: "editing", message: null,
    };
    const props = { editor, compact: true, ariaLabel: "Resizing draft", onSave, onCancel, onChange };
    const { rerender } = render(<ProjectMarkdownEditor {...props} interactionDisabled />);
    const input = screen.getByLabelText("Resizing draft") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "Still editable during resize" } });
    expect(onChange).toHaveBeenCalledWith("Still editable during resize");
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand editor" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const escape = createEvent.keyDown(input, { key: "Escape" });
    fireEvent(input, escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    rerender(<ProjectMarkdownEditor {...props} interactionDisabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { isNew: true, value: "", status: "editing" as const, cancels: true },
    { isNew: true, value: "Local draft", status: "editing" as const, cancels: true },
    { isNew: false, value: "Unchanged saved note", status: "editing" as const, cancels: true },
    { isNew: false, value: "Rejected draft", status: "error" as const, cancels: true },
    { isNew: false, value: "Unresolved draft", status: "saving" as const, cancels: false },
    { isNew: false, value: "Unresolved draft", status: "uncertain" as const, cancels: false },
    { isNew: false, value: "Conflicting draft", status: "conflict" as const, cancels: false },
  ])("Escape exits editable drafts and preserves unresolved mutations: %j", ({ isNew, value, status, cancels }) => {
    const onCancel = vi.fn();
    const surroundingKeyDown = vi.fn();
    render(<div onKeyDown={surroundingKeyDown}><ProjectMarkdownEditor compact editor={{ itemId: "draft", value, isNew, geometry: null, status, message: null }} ariaLabel="Escape draft" onChange={vi.fn()} onSave={vi.fn()} onCancel={onCancel} /></div>);
    // The mode controls remain focusable while a save or conflict locks typing.
    const target = cancels ? screen.getByLabelText("Escape draft") : screen.getByRole("tab", { name: "Write" });
    const escape = createEvent.keyDown(target, { key: "Escape" });
    fireEvent(target, escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(surroundingKeyDown).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(cancels ? 1 : 0);
  });

  it("cancels from Preview and action buttons while ignoring composition and modified Escape", () => {
    const onCancel = vi.fn();
    render(<ProjectMarkdownEditor editor={{ itemId: "note", value: "Saved note", isNew: false, geometry: null, status: "editing", message: null }} ariaLabel="Escape draft" onChange={vi.fn()} onSave={vi.fn()} onCancel={onCancel} />);
    const input = screen.getByLabelText("Escape draft");
    for (const modifier of ["isComposing", "altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      fireEvent.keyDown(input, { key: "Escape", [modifier]: true });
    }
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    fireEvent.keyDown(screen.getByLabelText("Markdown preview"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.getAttribute("aria-keyshortcuts")).toBe("Escape");
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("shares the draft and preview across expansion and safely restores focus", () => {
    const onCancel = vi.fn();
    function Harness() {
      const [value, setValue] = useState("Initial $x^2$ draft");
      return <><button>Outside control</button><ProjectMarkdownEditor compact editor={{ itemId: "draft", value, isNew: true, geometry: null, status: "editing", message: null }} ariaLabel="Note draft" onChange={setValue} onSave={vi.fn()} onCancel={onCancel} /></>;
    }
    render(<Harness />);
    const expand = screen.getByRole("button", { name: "Expand editor" });
    fireEvent.click(expand);
    const dialog = screen.getByRole("dialog", { name: "Expanded Markdown editor" });
    expect(dialog.closest(".project-markdown-editor-shell")).toBeNull();
    const collapse = within(dialog).getByRole("button", { name: "Collapse editor" });
    expect(document.activeElement).toBe(collapse);
    screen.getByRole("button", { name: "Outside control" }).focus();
    expect(document.activeElement).toBe(collapse);
    fireEvent.change(within(dialog).getByLabelText("Note draft"), { target: { value: "Updated $x^2$ draft" } });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Preview" }));
    expect(dialog.querySelector("math")).not.toBeNull();
    expect(within(dialog).getByLabelText("Markdown preview").textContent).toContain("Updated");
    fireEvent.keyDown(within(dialog).getByLabelText("Markdown preview"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Write" }));
    expect((screen.getByLabelText("Note draft") as HTMLTextAreaElement).value).toBe("Updated $x^2$ draft");
    fireEvent.keyDown(screen.getByLabelText("Note draft"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("allows correction after a determined error but keeps uncertain drafts locked", () => {
    const editor: ProjectMapMarkdownEditorState = { itemId: "draft", value: "Keep me", isNew: true, geometry: null, status: "error", message: "Rejected" };
    const { rerender } = render(<ProjectMarkdownEditor compact editor={editor} ariaLabel="Note draft" onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByLabelText("Note draft") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save Markdown" })).toBeTruthy();
    rerender(<ProjectMarkdownEditor compact editor={{ ...editor, status: "uncertain" }} ariaLabel="Note draft" onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByLabelText("Note draft") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry exact save" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand editor" }));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Note draft") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect((screen.getByLabelText("Note draft") as HTMLTextAreaElement).value).toBe("Keep me");
  });
});
