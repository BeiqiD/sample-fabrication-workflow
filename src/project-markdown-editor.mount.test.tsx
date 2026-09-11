// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectMapMarkdownEditorState } from "./lib/project-owned-content";
import ProjectMarkdownEditor from "./components/project/ProjectMarkdownEditor";

afterEach(cleanup);

describe("Expanded Markdown editor", () => {
  it.each([
    { isNew: true, value: "", status: "editing" as const, cancels: true },
    { isNew: true, value: "Keep my draft", status: "editing" as const, cancels: false },
    { isNew: false, value: "", status: "editing" as const, cancels: false },
    { isNew: true, value: "", status: "uncertain" as const, cancels: false },
  ])("Escape respects draft identity and mutation state: %j", ({ isNew, value, status, cancels }) => {
    const onCancel = vi.fn();
    render(<ProjectMarkdownEditor compact editor={{ itemId: "draft", value, isNew, geometry: null, status, message: null }} ariaLabel="Escape draft" onChange={vi.fn()} onSave={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByLabelText("Escape draft"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(cancels ? 1 : 0);
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
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Write" }));
    expect((screen.getByLabelText("Note draft") as HTMLTextAreaElement).value).toBe("Updated $x^2$ draft");
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
