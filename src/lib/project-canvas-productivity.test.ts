// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  MAX_PROJECT_MAP_COORDINATE_ABS,
  MAX_PROJECT_MAP_NODE_SIZE,
  MAX_PROJECT_MAP_Z_INDEX_ABS,
} from "../../shared/project-types";
import {
  normalizeProjectItemSelection,
  projectCanvasAlignmentCommands,
  projectCanvasAlignmentGuides,
  projectCanvasKeyboardShortcutFromEvent,
  projectCanvasKeyboardTargetIsEditable,
  projectCanvasZOrderCommands,
  type ProjectCanvasGeometryEntry,
} from "./project-canvas-productivity";

const entries: ProjectCanvasGeometryEntry[] = [{
  itemId: "item-a",
  placementId: "placement-a",
  geometry: { x: 10, y: 20, width: 100, height: 40, zIndex: 0 },
}, {
  itemId: "item-b",
  placementId: "placement-b",
  geometry: { x: 180, y: 90, width: 60, height: 80, zIndex: 1 },
}, {
  itemId: "item-c",
  placementId: "placement-c",
  geometry: { x: 300, y: 150, width: 50, height: 50, zIndex: 2 },
}];

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

  it("finds the nearest transient drag guides without changing geometry", () => {
    const moving = {
      x: 96,
      y: 104,
      width: 100,
      height: 60,
      zIndex: 3,
    };
    const stationary = {
      x: 200,
      y: 100,
      width: 120,
      height: 60,
      zIndex: 1,
    };

    expect(projectCanvasAlignmentGuides([moving], [stationary], 5)).toEqual({
      vertical: 200,
      horizontal: 100,
    });
    expect(projectCanvasAlignmentGuides([moving], [stationary], 3)).toEqual({
      vertical: null,
      horizontal: null,
    });
    expect(moving).toEqual({
      x: 96,
      y: 104,
      width: 100,
      height: 60,
      zIndex: 3,
    });
  });

  it("builds bounded grouped alignment commands from the selected extent", () => {
    expect(projectCanvasAlignmentCommands(
      entries,
      ["item-a", "item-b"],
      "right",
    )).toEqual([{
      placementId: "placement-a",
      before: entries[0].geometry,
      after: { ...entries[0].geometry, x: 140 },
    }]);

    const centered = projectCanvasAlignmentCommands(
      entries,
      ["item-a", "item-b"],
      "center-y",
    );
    expect(centered.map((command) => ({
      placementId: command.placementId,
      y: command.after.y,
      width: command.after.width,
      height: command.after.height,
      zIndex: command.after.zIndex,
    }))).toEqual([{
      placementId: "placement-a",
      y: 75,
      width: 100,
      height: 40,
      zIndex: 0,
    }, {
      placementId: "placement-b",
      y: 55,
      width: 60,
      height: 80,
      zIndex: 1,
    }]);
  });

  it("keeps exact alignment inside the persisted coordinate domain", () => {
    const boundaryEntries: ProjectCanvasGeometryEntry[] = [{
      itemId: "item-wide",
      placementId: "placement-wide",
      geometry: {
        x: MAX_PROJECT_MAP_COORDINATE_ABS,
        y: MAX_PROJECT_MAP_COORDINATE_ABS,
        width: MAX_PROJECT_MAP_NODE_SIZE,
        height: MAX_PROJECT_MAP_NODE_SIZE,
        zIndex: 0,
      },
    }, {
      itemId: "item-small",
      placementId: "placement-small",
      geometry: {
        x: MAX_PROJECT_MAP_COORDINATE_ABS - 50,
        y: MAX_PROJECT_MAP_COORDINATE_ABS - 50,
        width: 100,
        height: 100,
        zIndex: 1,
      },
    }];

    for (const alignment of ["right", "center-x", "bottom", "center-y"] as const) {
      const commands = projectCanvasAlignmentCommands(
        boundaryEntries,
        boundaryEntries.map((entry) => entry.itemId),
        alignment,
      );
      const after = new Map(boundaryEntries.map((entry) => [
        entry.placementId,
        entry.geometry,
      ]));
      for (const command of commands) after.set(command.placementId, command.after);
      const geometries = [...after.values()];

      expect(geometries.every((geometry) => (
        Math.abs(geometry.x) <= MAX_PROJECT_MAP_COORDINATE_ABS
        && Math.abs(geometry.y) <= MAX_PROJECT_MAP_COORDINATE_ABS
      ))).toBe(true);

      if (alignment === "right") {
        expect(new Set(geometries.map((geometry) => geometry.x + geometry.width)).size).toBe(1);
      } else if (alignment === "center-x") {
        expect(new Set(geometries.map((geometry) => geometry.x + geometry.width / 2)).size).toBe(1);
      } else if (alignment === "bottom") {
        expect(new Set(geometries.map((geometry) => geometry.y + geometry.height)).size).toBe(1);
      } else {
        expect(new Set(geometries.map((geometry) => geometry.y + geometry.height / 2)).size).toBe(1);
      }
    }
  });

  it("moves one selected layer forward by swapping only the affected z-order slots", () => {
    expect(projectCanvasZOrderCommands(
      entries,
      ["item-b"],
      "bring-forward",
    )).toEqual([{
      placementId: "placement-b",
      before: entries[1].geometry,
      after: { ...entries[1].geometry, zIndex: 2 },
    }, {
      placementId: "placement-c",
      before: entries[2].geometry,
      after: { ...entries[2].geometry, zIndex: 1 },
    }]);
  });

  it("moves a selected block to the front while preserving its relative order", () => {
    expect(projectCanvasZOrderCommands(
      entries,
      ["item-a", "item-b"],
      "bring-to-front",
    )).toEqual([{
      placementId: "placement-a",
      before: entries[0].geometry,
      after: { ...entries[0].geometry, zIndex: 3 },
    }, {
      placementId: "placement-b",
      before: entries[1].geometry,
      after: { ...entries[1].geometry, zIndex: 4 },
    }]);
  });

  it("uses current render order to resolve duplicate z-index movement", () => {
    const duplicateEntries: ProjectCanvasGeometryEntry[] = [{
      itemId: "item-z",
      placementId: "placement-z",
      geometry: { x: 0, y: 0, width: 100, height: 100, zIndex: 0 },
    }, {
      itemId: "item-a",
      placementId: "placement-a",
      geometry: { x: 120, y: 0, width: 100, height: 100, zIndex: 0 },
    }];

    const project = (
      commands: ReturnType<typeof projectCanvasZOrderCommands>,
    ) => duplicateEntries.map((entry) => (
      commands.find((command) => command.placementId === entry.placementId)?.after
        ?? entry.geometry
    ));

    expect(project(projectCanvasZOrderCommands(
      duplicateEntries,
      ["item-z"],
      "bring-forward",
    )).map((geometry) => geometry.zIndex)).toEqual([1, 0]);

    expect(project(projectCanvasZOrderCommands(
      duplicateEntries,
      ["item-a"],
      "send-backward",
    )).map((geometry) => geometry.zIndex)).toEqual([1, 0]);

    const blockEntries: ProjectCanvasGeometryEntry[] = [
      ...duplicateEntries,
      {
        itemId: "item-top",
        placementId: "placement-top",
        geometry: { x: 240, y: 0, width: 100, height: 100, zIndex: 1 },
      },
    ];
    const blockCommands = projectCanvasZOrderCommands(
      blockEntries,
      ["item-z", "item-a"],
      "bring-to-front",
    );
    const blockZ = new Map(blockEntries.map((entry) => [
      entry.placementId,
      blockCommands.find((command) => command.placementId === entry.placementId)?.after.zIndex
        ?? entry.geometry.zIndex,
    ]));
    expect(blockZ.get("placement-z")).toBeLessThan(blockZ.get("placement-a")!);
    expect(blockZ.get("placement-a")).toBeGreaterThan(blockZ.get("placement-top")!);
  });

  it("falls back to bounded rank reassignment at the z-index limit", () => {
    const bounded: ProjectCanvasGeometryEntry[] = [{
      ...entries[0],
      geometry: { ...entries[0].geometry, zIndex: -MAX_PROJECT_MAP_Z_INDEX_ABS },
    }, {
      ...entries[1],
      geometry: { ...entries[1].geometry, zIndex: -MAX_PROJECT_MAP_Z_INDEX_ABS + 1 },
    }, {
      ...entries[2],
      geometry: { ...entries[2].geometry, zIndex: -MAX_PROJECT_MAP_Z_INDEX_ABS + 2 },
    }];
    const commands = projectCanvasZOrderCommands(
      bounded,
      ["item-b"],
      "send-to-back",
    );
    expect(commands).toEqual([{
      placementId: "placement-a",
      before: bounded[0].geometry,
      after: { ...bounded[0].geometry, zIndex: -MAX_PROJECT_MAP_Z_INDEX_ABS + 1 },
    }, {
      placementId: "placement-b",
      before: bounded[1].geometry,
      after: { ...bounded[1].geometry, zIndex: -MAX_PROJECT_MAP_Z_INDEX_ABS },
    }]);
    expect(commands.every((command) => (
      Math.abs(command.after.zIndex) <= MAX_PROJECT_MAP_Z_INDEX_ABS
    ))).toBe(true);
  });
});
