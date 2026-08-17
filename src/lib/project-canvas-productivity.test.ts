// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  normalizeProjectItemSelection,
  projectCanvasKeyboardShortcutFromEvent,
  projectCanvasKeyboardTargetIsEditable,
} from "./project-canvas-productivity";

describe("Project Canvas productivity contracts", () => {
  it("deduplicates selection while preserving one explicit primary occurrence", () => {
    expect(normalizeProjectItemSelection([
      "item-a",
      "item-b",
      "item-a",
      "",
    ], "item-a")).toEqual({
      itemIds: ["item-b", "item-a"],
      primaryItemId: "item-a",
    });
    expect(normalizeProjectItemSelection([], "missing")).toEqual({
      itemIds: [],
      primaryItemId: null,
    });
  });

  it("maps bounded Project shortcuts without capturing ordinary typing", () => {
    const shortcut = (key: string, options: Partial<KeyboardEvent> = {}) => (
      projectCanvasKeyboardShortcutFromEvent({
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        ...options,
      })
    );

    expect(shortcut("a", { ctrlKey: true })).toBe("select-all");
    expect(shortcut("s", { metaKey: true })).toBe("save");
    expect(shortcut("z", { ctrlKey: true })).toBe("undo");
    expect(shortcut("z", { metaKey: true, shiftKey: true })).toBe("redo");
    expect(shortcut("y", { ctrlKey: true })).toBe("redo");
    expect(shortcut("Escape")).toBe("clear-selection");
    expect(shortcut("a")).toBeNull();
    expect(shortcut("s", { ctrlKey: true, altKey: true })).toBeNull();
    expect(shortcut("z", { ctrlKey: true, isComposing: true })).toBeNull();
  });

  it("leaves native editing shortcuts inside editable controls", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const wrapper = document.createElement("div");
    wrapper.setAttribute("role", "textbox");
    const child = document.createElement("span");
    wrapper.append(child);
    const ordinary = document.createElement("button");

    expect(projectCanvasKeyboardTargetIsEditable(input)).toBe(true);
    expect(projectCanvasKeyboardTargetIsEditable(textarea)).toBe(true);
    expect(projectCanvasKeyboardTargetIsEditable(child)).toBe(true);
    expect(projectCanvasKeyboardTargetIsEditable(ordinary)).toBe(false);
  });
});
