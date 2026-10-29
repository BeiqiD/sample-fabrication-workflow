import type { FabubloxStep } from "../../shared/types";

// These identify supported export layouts, not Excel application versions or
// the process revision shown on FabuBlox's Overview sheet.
export const FABUBLOX_HEADER_ALIASES = {
  stepNumber: ["step #", "step number", "step no", "step"],
  stepName: ["step name", "name"],
  toolName: ["tool name", "tool"],
  parameters: ["parameters", "parameter", "process parameters"],
  toolParameters: ["tool parameters"],
  comments: ["comments", "comment", "notes"],
  layerStacks: ["layer stacks", "layer stack", "diagram", "schematic"],
  capabilityType: ["capability type"],
  recipeName: ["recipe name"],
} as const;

export type FabubloxColumnKey = keyof typeof FABUBLOX_HEADER_ALIASES;
export type FabubloxColumnMap = Partial<Record<FabubloxColumnKey, number>>;

export function normalizeFabuBloxLabel(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function fabubloxCell(cells: Record<string, unknown>, label: string): string | null {
  const entry = Object.entries(cells).find(([key]) => normalizeFabuBloxLabel(key) === normalizeFabuBloxLabel(label));
  const value = String(entry?.[1] ?? "").trim();
  return value || null;
}

interface WorkbookFormat {
  id: string;
  label: string;
  headers: readonly string[];
  diagramColumn: number;
  matches(headers: unknown[], columns: FabubloxColumnMap): boolean;
  initialSubstrate(step: FabubloxStep): boolean;
  imageColumn(headers: unknown[], columns: FabubloxColumnMap): number | null;
  separateToolParameters: boolean;
  normalizeInitialRole: boolean;
  placeholderNameFromCapability: boolean;
  missingSubstrateMessage: string;
  substrateSheetNames: readonly string[];
}

export const FABUBLOX_WORKBOOK_FORMATS = [
  {
    id: "capability-flow",
    label: "Capability flow",
    headers: ["", "Step #", "Capability Type", "Step Name", "Tool Name", "Recipe Name", "Process Parameters", "Tool Parameters", "Notes"],
    diagramColumn: 0,
    matches: (headers, columns) => columns.capabilityType !== undefined
      && !headers.some(value => ["layer stacks", "layer stack"].includes(normalizeFabuBloxLabel(value))),
    initialSubstrate: step => (step.stepNumber === null || step.stepNumber === "0")
      && normalizeFabuBloxLabel(fabubloxCell(step.rawCells, "Capability Type")) === "substrate",
    imageColumn: (headers, columns) => columns.layerStacks ?? (columns.stepNumber === 1 && !normalizeFabuBloxLabel(headers[0]) ? 0 : null),
    separateToolParameters: true,
    normalizeInitialRole: true,
    placeholderNameFromCapability: true,
    missingSubstrateMessage: "A Substrate row with a blank or zero Step # was not found; no initial substrate will be defined.",
    substrateSheetNames: ["substrate"],
  },
  {
    id: "classic-layer-stack",
    label: "Classic · Step 0 / Layer Stacks",
    headers: ["Step #", "Step Name", "Tool Name", "Parameters", "Comments", "Layer Stacks"],
    diagramColumn: 5,
    matches: () => true,
    initialSubstrate: step => step.stepNumber === "0"
      && normalizeFabuBloxLabel(step.name).replace(/[-_]+/g, " ") === "substrate stack",
    imageColumn: (_headers, columns) => columns.layerStacks ?? null,
    separateToolParameters: false,
    normalizeInitialRole: false,
    placeholderNameFromCapability: false,
    missingSubstrateMessage: "Step 0 named Substrate Stack was not found; no initial substrate will be defined.",
    substrateSheetNames: [],
  },
] as const satisfies readonly WorkbookFormat[];

export type FabubloxWorkbookFormatId = typeof FABUBLOX_WORKBOOK_FORMATS[number]["id"];

export function detectFabuBloxFormat(headers: unknown[], columns: FabubloxColumnMap): WorkbookFormat {
  return FABUBLOX_WORKBOOK_FORMATS.find(format => format.matches(headers, columns))!;
}
