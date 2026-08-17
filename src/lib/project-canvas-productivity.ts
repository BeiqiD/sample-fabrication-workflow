export interface ProjectItemSelection {
  itemIds: string[];
  primaryItemId: string | null;
}

export type ProjectCanvasKeyboardShortcut =
  | "select-all"
  | "clear-selection"
  | "copy"
  | "paste"
  | "undo"
  | "redo"
  | "save";

export function normalizeProjectItemSelection(
  itemIds: readonly string[],
  preferredPrimaryItemId: string | null = null,
): ProjectItemSelection {
  const uniqueItemIds: string[] = [];
  const seen = new Set<string>();
  for (const itemId of itemIds) {
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    uniqueItemIds.push(itemId);
  }

  const primaryItemId = preferredPrimaryItemId && seen.has(preferredPrimaryItemId)
    ? preferredPrimaryItemId
    : uniqueItemIds.at(-1) ?? null;
  if (!primaryItemId) return { itemIds: [], primaryItemId: null };

  return {
    itemIds: [
      ...uniqueItemIds.filter((itemId) => itemId !== primaryItemId),
      primaryItemId,
    ],
    primaryItemId,
  };
}

export function projectCanvasKeyboardTargetIsEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest("[contenteditable='true'], [role='textbox']")) return true;
  const control = target.closest("input, textarea, select");
  return control instanceof HTMLElement && !control.hasAttribute("disabled");
}

export function projectCanvasKeyboardShortcutFromEvent(event: Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "isComposing" | "key" | "metaKey" | "shiftKey"
>): ProjectCanvasKeyboardShortcut | null {
  if (event.isComposing || event.altKey) return null;
  const key = event.key.toLowerCase();
  const commandModifier = event.metaKey || event.ctrlKey;

  if (!commandModifier) return key === "escape" ? "clear-selection" : null;
  if (key === "a" && !event.shiftKey) return "select-all";
  if (key === "c" && !event.shiftKey) return "copy";
  if (key === "v" && !event.shiftKey) return "paste";
  if (key === "s" && !event.shiftKey) return "save";
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}
