import {
  MAX_PROJECT_MAP_COORDINATE_ABS,
  MAX_PROJECT_MAP_NODE_SIZE,
  MAX_PROJECT_MAP_Z_INDEX_ABS,
  type ProjectMapGeometry,
} from "../../shared/project-types";
import type { ProjectGeometryCommand } from "./project-map-model";

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

export type ProjectCanvasAlignment =
  | "left"
  | "center-x"
  | "right"
  | "top"
  | "center-y"
  | "bottom";

export type ProjectCanvasZOrderAction =
  | "bring-forward"
  | "send-backward"
  | "bring-to-front"
  | "send-to-back";

export interface ProjectCanvasGeometryEntry {
  itemId: string;
  placementId: string;
  geometry: ProjectMapGeometry;
}

export interface ProjectCanvasAlignmentGuides {
  vertical: number | null;
  horizontal: number | null;
}

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

function geometryAxisAnchors(
  geometry: ProjectMapGeometry,
  axis: "x" | "y",
) {
  if (axis === "x") {
    return [
      geometry.x,
      geometry.x + geometry.width / 2,
      geometry.x + geometry.width,
    ];
  }
  return [
    geometry.y,
    geometry.y + geometry.height / 2,
    geometry.y + geometry.height,
  ];
}

function closestAlignmentGuide(
  movingAnchors: readonly number[],
  stationaryAnchors: readonly number[],
  threshold: number,
) {
  let best: { distance: number; target: number; moving: number } | null = null;
  for (const moving of movingAnchors) {
    for (const target of stationaryAnchors) {
      const distance = Math.abs(moving - target);
      if (distance > threshold) continue;
      if (!best
        || distance < best.distance
        || (distance === best.distance && target < best.target)
        || (distance === best.distance && target === best.target && moving < best.moving)) {
        best = { distance, target, moving };
      }
    }
  }
  return best?.target ?? null;
}

export function projectCanvasAlignmentGuides(
  moving: readonly ProjectMapGeometry[],
  stationary: readonly ProjectMapGeometry[],
  threshold: number,
): ProjectCanvasAlignmentGuides {
  const boundedThreshold = Number.isFinite(threshold) ? Math.max(0, threshold) : 0;
  if (moving.length === 0 || stationary.length === 0) {
    return { vertical: null, horizontal: null };
  }

  return {
    vertical: closestAlignmentGuide(
      moving.flatMap((geometry) => geometryAxisAnchors(geometry, "x")),
      stationary.flatMap((geometry) => geometryAxisAnchors(geometry, "x")),
      boundedThreshold,
    ),
    horizontal: closestAlignmentGuide(
      moving.flatMap((geometry) => geometryAxisAnchors(geometry, "y")),
      stationary.flatMap((geometry) => geometryAxisAnchors(geometry, "y")),
      boundedThreshold,
    ),
  };
}

function selectedGeometryEntries(
  entries: readonly ProjectCanvasGeometryEntry[],
  selectedItemIds: readonly string[],
) {
  const selected = new Set(selectedItemIds);
  return entries.filter((entry) => selected.has(entry.itemId));
}

function clampProjectCanvasAlignmentTarget(
  value: number,
  minimum: number,
  maximum: number,
) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function projectCanvasAlignmentCommands(
  entries: readonly ProjectCanvasGeometryEntry[],
  selectedItemIds: readonly string[],
  alignment: ProjectCanvasAlignment,
): ProjectGeometryCommand[] {
  const selected = selectedGeometryEntries(entries, selectedItemIds);
  if (selected.length < 2) return [];

  const widths = selected.map((entry) => entry.geometry.width);
  const heights = selected.map((entry) => entry.geometry.height);
  const minimumWidth = Math.min(...widths);
  const maximumWidth = Math.max(...widths);
  const minimumHeight = Math.min(...heights);
  const maximumHeight = Math.max(...heights);
  const left = Math.min(...selected.map((entry) => entry.geometry.x));
  const rawRight = Math.max(...selected.map((entry) => (
    entry.geometry.x + entry.geometry.width
  )));
  const top = Math.min(...selected.map((entry) => entry.geometry.y));
  const rawBottom = Math.max(...selected.map((entry) => (
    entry.geometry.y + entry.geometry.height
  )));
  const right = clampProjectCanvasAlignmentTarget(
    rawRight,
    -MAX_PROJECT_MAP_COORDINATE_ABS + maximumWidth,
    MAX_PROJECT_MAP_COORDINATE_ABS + minimumWidth,
  );
  const bottom = clampProjectCanvasAlignmentTarget(
    rawBottom,
    -MAX_PROJECT_MAP_COORDINATE_ABS + maximumHeight,
    MAX_PROJECT_MAP_COORDINATE_ABS + minimumHeight,
  );
  const centerX = clampProjectCanvasAlignmentTarget(
    (left + rawRight) / 2,
    -MAX_PROJECT_MAP_COORDINATE_ABS + maximumWidth / 2,
    MAX_PROJECT_MAP_COORDINATE_ABS + minimumWidth / 2,
  );
  const centerY = clampProjectCanvasAlignmentTarget(
    (top + rawBottom) / 2,
    -MAX_PROJECT_MAP_COORDINATE_ABS + maximumHeight / 2,
    MAX_PROJECT_MAP_COORDINATE_ABS + minimumHeight / 2,
  );

  return selected.flatMap((entry) => {
    const before = entry.geometry;
    let x = before.x;
    let y = before.y;
    if (alignment === "left") x = left;
    if (alignment === "center-x") x = centerX - before.width / 2;
    if (alignment === "right") x = right - before.width;
    if (alignment === "top") y = top;
    if (alignment === "center-y") y = centerY - before.height / 2;
    if (alignment === "bottom") y = bottom - before.height;
    const after = { ...before, x, y };
    return before.x === after.x && before.y === after.y
      ? []
      : [{ placementId: entry.placementId, before, after }];
  });
}

function compareCanvasZOrder(
  left: ProjectCanvasGeometryEntry,
  right: ProjectCanvasGeometryEntry,
  renderOrder: ReadonlyMap<string, number>,
) {
  // React Flow resolves equal z-index values by rendered node order. The
  // entries arrive in that same order, so UUID-like identities must not
  // invent a different visual stack.
  return left.geometry.zIndex - right.geometry.zIndex
    || (renderOrder.get(left.placementId) ?? 0)
      - (renderOrder.get(right.placementId) ?? 0);
}

function compactCanvasZOrderSlots(
  sorted: readonly ProjectCanvasGeometryEntry[],
) {
  const current = sorted.map((entry) => entry.geometry.zIndex);
  if (new Set(current).size === current.length) return current;
  const maximumStart = MAX_PROJECT_MAP_Z_INDEX_ABS - sorted.length + 1;
  const currentMinimum = Math.min(...current);
  const start = Math.max(
    -MAX_PROJECT_MAP_Z_INDEX_ABS,
    Math.min(currentMinimum, maximumStart),
  );
  return sorted.map((_entry, index) => start + index);
}

function canvasZOrderCommandsForDesiredOrder(
  entries: readonly ProjectCanvasGeometryEntry[],
  sorted: readonly ProjectCanvasGeometryEntry[],
  desired: readonly ProjectCanvasGeometryEntry[],
  forceDistinct = false,
): ProjectGeometryCommand[] {
  const sameOrder = desired.every((entry, index) => (
    entry.placementId === sorted[index]?.placementId
  ));
  if (sameOrder && !forceDistinct) return [];

  const slots = compactCanvasZOrderSlots(sorted);
  const desiredZ = new Map(desired.map((entry, index) => [
    entry.placementId,
    slots[index],
  ]));
  return entries.flatMap((entry) => {
    const zIndex = desiredZ.get(entry.placementId);
    if (zIndex === undefined || zIndex === entry.geometry.zIndex) return [];
    return [{
      placementId: entry.placementId,
      before: entry.geometry,
      after: { ...entry.geometry, zIndex },
    }];
  });
}

export function projectCanvasZOrderCommands(
  entries: readonly ProjectCanvasGeometryEntry[],
  selectedItemIds: readonly string[],
  action: ProjectCanvasZOrderAction,
): ProjectGeometryCommand[] {
  const selectedIds = new Set(selectedItemIds);
  const renderOrder = new Map(entries.map((entry, index) => [
    entry.placementId,
    index,
  ]));
  const sorted = [...entries].sort((left, right) => (
    compareCanvasZOrder(left, right, renderOrder)
  ));
  const selected = sorted.filter((entry) => selectedIds.has(entry.itemId));
  const stationary = sorted.filter((entry) => !selectedIds.has(entry.itemId));
  if (selected.length === 0 || stationary.length === 0) return [];

  if (action === "bring-to-front") {
    const lowestSelected = Math.min(...selected.map((entry) => entry.geometry.zIndex));
    const highestStationary = Math.max(...stationary.map((entry) => entry.geometry.zIndex));
    if (lowestSelected > highestStationary) return [];
    const highest = Math.max(...sorted.map((entry) => entry.geometry.zIndex));
    if (highest + selected.length <= MAX_PROJECT_MAP_Z_INDEX_ABS) {
      return selected.flatMap((entry, index) => {
        const zIndex = highest + index + 1;
        return zIndex === entry.geometry.zIndex ? [] : [{
          placementId: entry.placementId,
          before: entry.geometry,
          after: { ...entry.geometry, zIndex },
        }];
      });
    }
    return canvasZOrderCommandsForDesiredOrder(
      entries,
      sorted,
      [...stationary, ...selected],
      true,
    );
  }

  if (action === "send-to-back") {
    const highestSelected = Math.max(...selected.map((entry) => entry.geometry.zIndex));
    const lowestStationary = Math.min(...stationary.map((entry) => entry.geometry.zIndex));
    if (highestSelected < lowestStationary) return [];
    const lowest = Math.min(...sorted.map((entry) => entry.geometry.zIndex));
    if (lowest - selected.length >= -MAX_PROJECT_MAP_Z_INDEX_ABS) {
      return selected.flatMap((entry, index) => {
        const zIndex = lowest - selected.length + index;
        return zIndex === entry.geometry.zIndex ? [] : [{
          placementId: entry.placementId,
          before: entry.geometry,
          after: { ...entry.geometry, zIndex },
        }];
      });
    }
    return canvasZOrderCommandsForDesiredOrder(
      entries,
      sorted,
      [...selected, ...stationary],
      true,
    );
  }

  const desired = [...sorted];
  if (action === "bring-forward") {
    for (let index = desired.length - 2; index >= 0; index -= 1) {
      if (selectedIds.has(desired[index].itemId)
        && !selectedIds.has(desired[index + 1].itemId)) {
        [desired[index], desired[index + 1]] = [desired[index + 1], desired[index]];
      }
    }
  } else {
    for (let index = 1; index < desired.length; index += 1) {
      if (selectedIds.has(desired[index].itemId)
        && !selectedIds.has(desired[index - 1].itemId)) {
        [desired[index - 1], desired[index]] = [desired[index], desired[index - 1]];
      }
    }
  }
  return canvasZOrderCommandsForDesiredOrder(entries, sorted, desired);
}

export const PROJECT_CANVAS_GUIDE_COORDINATE_LIMIT = (
  MAX_PROJECT_MAP_COORDINATE_ABS + MAX_PROJECT_MAP_NODE_SIZE
);
