import JSZip from "jszip";
import type {
  FabubloxImportPreview,
  FabubloxSection,
  FabubloxStep,
  ImportWarning,
  ParsedFabubloxImage,
} from "../../shared/types";

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HEADER_ALIASES = {
  stepNumber: ["step #", "step number", "step no", "step"],
  stepName: ["step name", "name"],
  toolName: ["tool name", "tool"],
  parameters: ["parameters", "parameter"],
  comments: ["comments", "comment"],
  layerStacks: ["layer stacks", "layer stack"],
} as const;

type ColumnKey = keyof typeof HEADER_ALIASES;
type ColumnMap = Partial<Record<ColumnKey, number>>;

function normalizeHeader(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findHeader(rows: unknown[][]) {
  let best = { row: -1, columns: {} as ColumnMap, score: 0 };
  rows.slice(0, 20).forEach((row, rowIndex) => {
    const columns: ColumnMap = {};
    row.forEach((cell, columnIndex) => {
      const label = normalizeHeader(cell);
      for (const [key, aliases] of Object.entries(HEADER_ALIASES) as Array<[ColumnKey, readonly string[]]>) {
        if (aliases.includes(label) && columns[key] === undefined) columns[key] = columnIndex;
      }
    });
    const score = Object.keys(columns).length;
    if (score > best.score) best = { row: rowIndex, columns, score };
  });
  return best;
}

function text(value: unknown) {
  const result = String(value ?? "").trim();
  return result || null;
}

function xml(text: string) {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error("Invalid OOXML XML part");
  return document;
}

function elements(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", localName));
}

function attribute(element: Element, localName: string) {
  if (localName === "id") return element.getAttributeNS(REL_NS, "id") ?? element.getAttribute("r:id") ?? element.getAttribute("id");
  for (const item of Array.from(element.attributes)) if (item.localName === localName) return item.value;
  return null;
}

function childText(root: Element, localName: string) {
  return elements(root, localName)[0]?.textContent?.trim() ?? "";
}

function dirname(path: string) {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

function resolvePart(basePart: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${dirname(basePart)}${target}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop(); else resolved.push(part);
  }
  return resolved.join("/");
}

function relationshipsPath(part: string) {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

async function relationshipMap(zip: JSZip, relsPart: string, sourcePart: string) {
  const entry = zip.file(relsPart);
  if (!entry) return new Map<string, string>();
  const document = xml(await entry.async("text"));
  return new Map(elements(document, "Relationship").flatMap((relationship) => {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    return id && target ? [[id, resolvePart(sourcePart, target)]] : [];
  }));
}

function pngDimensions(data: Uint8Array) {
  if (data.length < 24 || data[0] !== 137 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function mimeType(part: string) {
  const extension = part.split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" } as Record<string, string>)[extension || ""] || "application/octet-stream";
}

async function sha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function locateWorksheetPart(zip: JSZip, sheetName: string) {
  const workbookPart = "xl/workbook.xml";
  const workbookEntry = zip.file(workbookPart);
  if (!workbookEntry) throw new Error("Missing xl/workbook.xml");
  const workbook = xml(await workbookEntry.async("text"));
  const sheet = elements(workbook, "sheet").find((item) => item.getAttribute("name") === sheetName);
  const relationshipId = sheet ? attribute(sheet, "id") : null;
  if (!relationshipId) throw new Error(`Could not resolve worksheet ${sheetName}`);
  const rels = await relationshipMap(zip, relationshipsPath(workbookPart), workbookPart);
  const part = rels.get(relationshipId);
  if (!part) throw new Error(`Missing worksheet relationship ${relationshipId}`);
  return part;
}

async function worksheetNames(zip: JSZip) {
  const workbookEntry = zip.file("xl/workbook.xml");
  if (!workbookEntry) throw new Error("Missing xl/workbook.xml");
  const workbook = xml(await workbookEntry.async("text"));
  return elements(workbook, "sheet").map((sheet) => sheet.getAttribute("name")?.trim()).filter((name): name is string => Boolean(name));
}

async function sharedStrings(zip: JSZip) {
  const entry = zip.file("xl/sharedStrings.xml");
  if (!entry) return [];
  const document = xml(await entry.async("text"));
  return elements(document, "si").map((item) => elements(item, "t").map((part) => part.textContent ?? "").join(""));
}

function columnIndex(reference: string | null) {
  const letters = reference?.match(/^([A-Z]+)\d+$/i)?.[1]?.toUpperCase();
  if (!letters) return null;
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function inlineString(cell: Element) {
  const container = elements(cell, "is")[0];
  return container ? elements(container, "t").map((part) => part.textContent ?? "").join("") : "";
}

async function worksheetRows(zip: JSZip, worksheetPart: string, strings: string[]) {
  const entry = zip.file(worksheetPart);
  if (!entry) throw new Error(`Missing worksheet part ${worksheetPart}`);
  const document = xml(await entry.async("text"));
  const rows: unknown[][] = [];
  let fallbackRow = 0;
  let cellCount = 0;
  for (const row of elements(document, "row")) {
    const declaredRow = Number(row.getAttribute("r"));
    const rowIndex = Number.isInteger(declaredRow) && declaredRow > 0 ? declaredRow - 1 : fallbackRow;
    fallbackRow = rowIndex + 1;
    const values = rows[rowIndex] ?? [];
    let fallbackColumn = 0;
    for (const cell of elements(row, "c")) {
      cellCount += 1;
      if (cellCount > 100_000) throw new Error("Worksheet contains too many cells");
      const declaredColumn = columnIndex(cell.getAttribute("r"));
      const column = declaredColumn ?? fallbackColumn;
      fallbackColumn = column + 1;
      const kind = cell.getAttribute("t");
      const raw = elements(cell, "v")[0]?.textContent ?? "";
      let value: unknown = null;
      if (kind === "s") value = strings[Number(raw)] ?? "";
      else if (kind === "inlineStr") value = inlineString(cell);
      else if (kind === "b") value = raw === "1";
      else if (kind === "str" || kind === "d" || kind === "e") value = raw;
      else if (raw !== "") value = Number.isFinite(Number(raw)) ? Number(raw) : raw;
      values[column] = value;
    }
    rows[rowIndex] = values;
  }
  return rows;
}

async function extractDrawings(zip: JSZip, worksheetPart: string): Promise<ParsedFabubloxImage[]> {
  const worksheetEntry = zip.file(worksheetPart);
  if (!worksheetEntry) throw new Error(`Missing worksheet part ${worksheetPart}`);
  const worksheet = xml(await worksheetEntry.async("text"));
  const drawingElement = elements(worksheet, "drawing")[0];
  const drawingRelationshipId = drawingElement ? attribute(drawingElement, "id") : null;
  if (!drawingRelationshipId) return [];
  const worksheetRels = await relationshipMap(zip, relationshipsPath(worksheetPart), worksheetPart);
  const drawingPart = worksheetRels.get(drawingRelationshipId);
  if (!drawingPart) throw new Error(`Missing drawing relationship ${drawingRelationshipId}`);
  const drawingEntry = zip.file(drawingPart);
  if (!drawingEntry) throw new Error(`Missing drawing part ${drawingPart}`);
  const drawing = xml(await drawingEntry.async("text"));
  const drawingRels = await relationshipMap(zip, relationshipsPath(drawingPart), drawingPart);
  const anchors = Array.from(drawing.documentElement.childNodes).filter((node) => {
    const name = (node as Element).localName;
    return name === "oneCellAnchor" || name === "twoCellAnchor";
  }) as Element[];
  const results: ParsedFabubloxImage[] = [];
  for (const [index, anchorElement] of anchors.entries()) {
    const from = elements(anchorElement, "from")[0];
    const blip = elements(anchorElement, "blip")[0];
    const relationshipId = blip ? attribute(blip, "embed") : null;
    const sourcePart = relationshipId ? drawingRels.get(relationshipId) : null;
    if (!from || !relationshipId || !sourcePart) throw new Error(`Unresolved drawing anchor ${index + 1}`);
    const media = zip.file(sourcePart);
    if (!media) throw new Error(`Drawing relationship points to missing media ${sourcePart}`);
    const data = await media.async("uint8array");
    const dimensions = pngDimensions(data);
    results.push({
      localId: `image-${index + 1}`,
      sourcePart,
      mimeType: mimeType(sourcePart),
      widthPx: dimensions?.width ?? null,
      heightPx: dimensions?.height ?? null,
      anchor: {
        row: Number(childText(from, "row")),
        col: Number(childText(from, "col")),
        rowOffsetEmu: Number(childText(from, "rowOff")) || undefined,
        colOffsetEmu: Number(childText(from, "colOff")) || undefined,
      },
      assignedStepLocalId: null,
      data,
    });
  }
  return results;
}

function parseRows(rows: unknown[][], headerRow: number, columns: ColumnMap) {
  const sections: FabubloxSection[] = [];
  const steps: FabubloxStep[] = [];
  const warnings: ImportWarning[] = [];
  const seenStepNumbers = new Set<string>();
  let currentSection: string | null = null;
  const headerLabels = rows[headerRow].map((value, index) => text(value) || `Column ${index + 1}`);

  for (let rowIndex = headerRow + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const stepNumber = columns.stepNumber === undefined ? null : text(row[columns.stepNumber]);
    const stepName = columns.stepName === undefined ? null : text(row[columns.stepName]);
    const anyText = row.map(text).find(Boolean) ?? null;
    const looksLikeSection = !stepName && Boolean(stepNumber) && !/^\d+(?:\.\d+)*$/.test(stepNumber!);
    if ((!stepNumber && !stepName) || looksLikeSection) {
      if (anyText) {
        currentSection = anyText;
        sections.push({ localId: `section-${sections.length + 1}`, sourceRow: rowIndex + 1, name: anyText });
      }
      continue;
    }
    if (!stepName) {
      warnings.push({ code: "missing_step_name", message: `Step row ${rowIndex + 1} has no step name`, sourceRow: rowIndex + 1 });
      continue;
    }
    if (stepNumber && seenStepNumbers.has(stepNumber)) warnings.push({ code: "duplicate_step_number", message: `Duplicate step number ${stepNumber}`, sourceRow: rowIndex + 1 });
    if (stepNumber) seenStepNumbers.add(stepNumber);
    const rawCells: Record<string, unknown> = {};
    row.forEach((value, columnIndex) => { if (value !== null && value !== undefined && value !== "") rawCells[headerLabels[columnIndex] || `Column ${columnIndex + 1}`] = value; });
    steps.push({
      localId: `step-${steps.length + 1}`,
      sourceRow: rowIndex + 1,
      position: steps.length,
      stepNumber,
      sectionName: currentSection,
      name: stepName,
      toolName: columns.toolName === undefined ? null : text(row[columns.toolName]),
      parametersText: columns.parameters === undefined ? null : text(row[columns.parameters]),
      commentsText: columns.comments === undefined ? null : text(row[columns.comments]),
      imageIds: [],
      rawCells,
    });
  }
  return { sections, steps, warnings };
}

export async function parseFabuBloxWorkbook(file: File): Promise<FabubloxImportPreview> {
  if (file.size > 50 * 1024 * 1024) throw new Error("Workbook is larger than the 50 MB import limit");
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const strings = await sharedStrings(zip);
  const candidates = await Promise.all((await worksheetNames(zip)).map(async (sheetName) => {
    const worksheetPart = await locateWorksheetPart(zip, sheetName);
    const rows = await worksheetRows(zip, worksheetPart, strings);
    return { sheetName, worksheetPart, rows, header: findHeader(rows) };
  }));
  candidates.sort((a, b) => b.header.score - a.header.score);
  const selected = candidates[0];
  if (!selected || selected.header.score < 2) throw new Error("No FabuBlox sheet with Step # / Step Name headers was found");

  const warnings: ImportWarning[] = [];
  for (const required of ["stepNumber", "stepName"] as ColumnKey[]) if (selected.header.columns[required] === undefined) warnings.push({ code: "missing_header", message: `Missing header: ${HEADER_ALIASES[required][0]}` });
  const parsedRows = parseRows(selected.rows, selected.header.row, selected.header.columns);
  warnings.push(...parsedRows.warnings);

  const images = await extractDrawings(zip, selected.worksheetPart);
  const layerColumn = selected.header.columns.layerStacks ?? null;
  for (const image of images) {
    const step = parsedRows.steps.find((candidate) => candidate.sourceRow === image.anchor.row + 1);
    if (step) {
      image.assignedStepLocalId = step.localId;
      step.imageIds.push(image.localId);
    }
  }
  const firstStepRow = Math.min(...parsedRows.steps.map((step) => step.sourceRow));
  const initialStateImageIds = images.filter((image) =>
    !image.assignedStepLocalId
    && layerColumn !== null
    && image.anchor.col === layerColumn
    && image.anchor.row + 1 < firstStepRow
  ).map((image) => image.localId);
  const initialStateImageSet = new Set(initialStateImageIds);
  const unassignedImageIds = images
    .filter((image) => !image.assignedStepLocalId && !initialStateImageSet.has(image.localId))
    .map((image) => image.localId);
  if (unassignedImageIds.length) warnings.push({ code: "unassigned_images", message: `${unassignedImageIds.length} image(s) could not be assigned by anchor row` });
  for (const step of parsedRows.steps) if (step.imageIds.length > 1) warnings.push({ code: "multiple_images", message: `Step ${step.stepNumber ?? step.position} has multiple images`, sourceRow: step.sourceRow });
  for (const image of images) if (layerColumn !== null && image.anchor.col !== layerColumn) warnings.push({ code: "image_outside_layer_column", message: `${image.localId} is anchored outside the Layer Stacks column`, sourceRow: image.anchor.row + 1 });

  return {
    schemaVersion: 1,
    title: selected.sheetName,
    source: { fileName: file.name, fileSha256: await sha256(buffer), sheetName: selected.sheetName },
    detected: { headerRow: selected.header.row + 1, layerStackColumn: layerColumn },
    sections: parsedRows.sections,
    steps: parsedRows.steps,
    images,
    initialStateImageIds,
    unassignedImageIds,
    warnings,
  };
}
