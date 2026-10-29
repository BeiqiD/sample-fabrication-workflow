import JSZip from "jszip";
import type { FabubloxImportPreview, FabubloxStep, ImportWarning, ParsedFabubloxImage } from "../../shared/types";
import { parseFabuBloxWorkbook } from "./fabublox";
import {
  FABUBLOX_HEADER_ALIASES, FABUBLOX_WORKBOOK_FORMATS, fabubloxCell, normalizeFabuBloxLabel,
  type FabubloxWorkbookFormatId,
} from "./fabublox-formats";

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/tiff": "tiff", "image/webp": "webp",
};

export interface ConvertedFabuBloxWorkbook {
  file: File;
  warnings: ImportWarning[];
}

function escaped(value: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error("This workbook contains text that cannot be represented in an Excel XML cell.");
  }
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function columnLetters(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cell(reference: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value !== "string") throw new Error("A source extension contains a value that cannot be preserved as an Excel cell.");
  if (value.length > 32_767) throw new Error("A source cell exceeds Excel's 32,767-character cell limit; conversion did not truncate it.");
  // Inline strings deliberately keep formula-like user text literal.
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escaped(value)}</t></is></c>`;
}

function parameterParts(step: FabubloxStep) {
  // Canonical Parameters is authoritative. A classic workbook may legitimately
  // have independent extensions called Process Parameters or Tool Parameters;
  // those must not replace or add to the actual imported process parameters.
  const tool = fabubloxCell(step.rawCells, "Tool Parameters");
  if (!tool) return { process: step.parametersText, tool: null };
  const suffix = `Tool parameters:\n${tool}`;
  if (step.parametersText === suffix) return { process: null, tool };
  const separator = `\n\n${suffix}`;
  return step.parametersText?.endsWith(separator)
    ? { process: step.parametersText.slice(0, -separator.length) || null, tool }
    : { process: step.parametersText, tool: null };
}

function diagramText(step: FabubloxStep) {
  return ["Layer Stacks", "Layer Stack", "Diagram", "Schematic", "Column 1"]
    .map(label => fabubloxCell(step.rawCells, label)).find(value => value !== null) ?? null;
}

// A new registry format must provide a writer explicitly; there is no implicit
// fallback that could accidentally export a future layout as an existing one.
const TARGET_CELL_WRITERS: Record<FabubloxWorkbookFormatId, (step: FabubloxStep, initial: boolean) => Record<string, unknown>> = {
  "classic-layer-stack": (step, initial) => ({
    "Step #": initial ? "0" : step.stepNumber,
    "Step Name": initial ? "Substrate Stack" : step.name,
    "Tool Name": step.toolName,
    Parameters: step.parametersText,
    Comments: step.commentsText,
    "Layer Stacks": diagramText(step),
  }),
  "capability-flow": (step, initial) => ({
    "": diagramText(step),
    "Step #": initial ? null : step.stepNumber,
    "Capability Type": initial ? "Substrate" : fabubloxCell(step.rawCells, "Capability Type") ?? "Process",
    "Step Name": initial ? fabubloxCell(step.rawCells, "Source substrate name") ?? step.name : step.name,
    "Tool Name": step.toolName,
    "Recipe Name": fabubloxCell(step.rawCells, "Recipe Name"),
    "Process Parameters": parameterParts(step).process,
    "Tool Parameters": parameterParts(step).tool,
    Notes: step.commentsText,
  }),
};

function targetCells(step: FabubloxStep, initial: boolean, target: FabubloxWorkbookFormatId) {
  return TARGET_CELL_WRITERS[target](step, initial);
}

interface ExtensionColumn { source: string; output: string }

function extensionColumns(
  steps: FabubloxStep[],
  initialId: string,
  target: typeof FABUBLOX_WORKBOOK_FORMATS[number],
): ExtensionColumn[] {
  const sourceLabels = new Set(steps.flatMap(step => Object.keys(step.rawCells)));
  const reserved = new Set([...target.headers, ...sourceLabels]);
  const result: ExtensionColumn[] = [];
  for (const label of sourceLabels) {
    const normalized = normalizeFabuBloxLabel(label);
    const aliases = Object.values(FABUBLOX_HEADER_ALIASES).find(values => (values as readonly string[]).includes(normalized));
    const baseLabel = (target.headers as readonly string[]).find(header => normalizeFabuBloxLabel(header) === normalized
      || aliases && (aliases as readonly string[]).includes(normalizeFabuBloxLabel(header)))
      ?? (aliases === FABUBLOX_HEADER_ALIASES.layerStacks ? target.headers[target.diagramColumn] : undefined);
    const represented = baseLabel !== undefined && steps.every(step => {
      if (!Object.prototype.hasOwnProperty.call(step.rawCells, label)) return true;
      const value = targetCells(step, step.localId === initialId, target.id)[baseLabel];
      return String(step.rawCells[label] ?? "") === String(value ?? "");
    });
    if (represented) continue;
    // Source-only header conflicts come from the same registry as input
    // detection. Prefix them, and also protect changed base-cell values and
    // case-distinct source columns without overwriting either.
    const needsPrefix = (target.headers as readonly string[]).includes(label)
      || (target.sourceHeaderConflicts as readonly string[]).includes(normalized);
    let output = label;
    if (needsPrefix) {
      const stem = `Source column: ${label}`;
      output = stem;
      let suffix = 2;
      while (reserved.has(output)) output = `${stem} (${suffix++})`;
    }
    reserved.add(output);
    result.push({ source: label, output });
  }
  return result;
}

function relationship(id: string, kind: string, target: string) {
  return `<Relationship Id="${escaped(id)}" Type="${OFFICE_REL_NS}/${kind}" Target="${escaped(target)}"/>`;
}

function relationships(content: string) {
  return `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">${content}</Relationships>`;
}

function worksheet(rows: string, columns = "", drawing = false) {
  return `${XML_HEADER}<worksheet xmlns="${SHEET_NS}" xmlns:r="${OFFICE_REL_NS}"><sheetViews><sheetView workbookViewId="0"/></sheetViews>${columns}<sheetData>${rows}</sheetData>${drawing ? '<drawing r:id="rDrawing"/>' : ""}</worksheet>`;
}

function imageAnchor(image: ParsedFabubloxImage, index: number, row: number, col: number, ordinal: number, count: number) {
  const sourceWidth = Math.max(1, image.widthPx ?? 320);
  const sourceHeight = Math.max(1, image.heightPx ?? 180);
  const slotHeight = 200 / count;
  const scale = Math.min(360 / sourceWidth, Math.max(1, slotHeight - 4) / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale * 9_525));
  const height = Math.max(1, Math.round(sourceHeight * scale * 9_525));
  const rowOffset = Math.round(ordinal * slotHeight * 9_525);
  return `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row - 1}</xdr:row><xdr:rowOff>${rowOffset}</xdr:rowOff></xdr:from><xdr:ext cx="${width}" cy="${height}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="Diagram ${index + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rImage${index + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
}

/** Writes a supported content layout from the stable import representation.
 * It does not reproduce arbitrary Excel formatting or claim third-party
 * FabuBlox import compatibility. The original source workbook stays unchanged. */
export async function writeFabuBloxWorkbook(
  preview: FabubloxImportPreview,
  targetFormatId: FabubloxWorkbookFormatId,
): Promise<ConvertedFabuBloxWorkbook> {
  const target = FABUBLOX_WORKBOOK_FORMATS.find(format => format.id === targetFormatId);
  if (!target) throw new Error("This workbook layout is not supported for conversion.");
  if (!preview.initialSubstrateStep) {
    throw new Error("Resolve the missing or ambiguous initial substrate before converting this workbook.");
  }
  if (!preview.steps.length) throw new Error("This workbook has no executable process rows to convert.");
  const sheetName = preview.source.sheetName;
  if (!sheetName || sheetName.length > 31 || /[\\/?*\[\]:]/.test(sheetName) || /^'|'$/.test(sheetName)) {
    throw new Error("The source sheet name cannot be preserved as an Excel worksheet name.");
  }
  const steps = [preview.initialSubstrateStep, ...preview.steps];
  const stepIds = new Set(steps.map(step => step.localId));
  if (stepIds.size !== steps.length) throw new Error("Duplicate process row identities prevent an unambiguous conversion.");
  const selectedInitial = new Set(preview.initialStateImageIds);
  if (preview.unassignedImageIds.length || preview.images.some(image => !image.assignedStepLocalId || !stepIds.has(image.assignedStepLocalId))) {
    throw new Error("Assign every source diagram to a process row before converting; unassigned diagrams were not discarded.");
  }
  if (preview.images.some(image => image.assignedStepLocalId === preview.initialSubstrateStep!.localId && !selectedInitial.has(image.localId))) {
    throw new Error("An initial-substrate image is outside the declared diagram column; resolve its assignment before converting.");
  }
  if (preview.images.some(image => !IMAGE_EXTENSIONS[image.mimeType.toLowerCase()])) {
    throw new Error("This workbook contains an image format that cannot be preserved by the Excel converter.");
  }

  const warnings: ImportWarning[] = [...preview.warnings.map(warning => ({ ...warning })), {
    code: "workbook_conversion_content_only",
    message: "Conversion preserves parsed process rows, substrate details, sections, extension columns and process diagrams. Original formatting, formulas (only their cached values), other sheets and Overview logos are not reproduced. Keep the original workbook.",
  }];
  if (preview.images.some(image => image.mimeType === "image/webp")) warnings.push({
    code: "workbook_conversion_image_compatibility",
    message: "WebP image bytes are preserved; older Excel applications may not display this image format.",
  });
  const baseHeaders: readonly string[] = target.headers;
  const extensions = extensionColumns(steps, preview.initialSubstrateStep.localId, target);
  const headers = [...baseHeaders, ...extensions.map(column => column.output)];
  if (headers.length > 16_384) throw new Error("This workbook has more extension columns than Excel can represent.");
  const tokens = [
    ...preview.sections.map((section, index) => ({ kind: "section" as const, row: section.sourceRow, index, section })),
    ...steps.map((step, index) => ({ kind: "step" as const, row: step.sourceRow, index, step })),
  ].sort((left, right) => left.row - right.row || (left.kind === right.kind ? left.index - right.index : left.kind === "section" ? -1 : 1));
  const rowByStep = new Map<string, number>();
  const imagesByStep = new Map<string, number>();
  for (const image of preview.images) imagesByStep.set(image.assignedStepLocalId!, (imagesByStep.get(image.assignedStepLocalId!) ?? 0) + 1);
  const rows = [`<row r="1">${headers.map((header, column) => cell(`${columnLetters(column)}1`, header)).join("")}</row>`];
  for (const token of tokens) {
    const rowNumber = rows.length + 1;
    if (token.kind === "section") {
      rows.push(`<row r="${rowNumber}">${cell(`A${rowNumber}`, token.section.name)}</row>`);
      continue;
    }
    const step = token.step;
    rowByStep.set(step.localId, rowNumber);
    const values = targetCells(step, step.localId === preview.initialSubstrateStep.localId, targetFormatId);
    const content = headers.map((header, column) => cell(`${columnLetters(column)}${rowNumber}`,
      column < baseHeaders.length ? values[header] : step.rawCells[extensions[column - baseHeaders.length].source])).join("");
    rows.push(`<row r="${rowNumber}"${imagesByStep.has(step.localId) ? ' ht="150" customHeight="1"' : ""}>${content}</row>`);
  }
  if (rows.length > 1_048_576) throw new Error("This workbook has more rows than Excel can represent.");
  const zip = new JSZip();
  const imageTypes = new Map<string, string>();
  const media = preview.images.map((image, index) => {
    const extension = IMAGE_EXTENSIONS[image.mimeType.toLowerCase()];
    imageTypes.set(extension, image.mimeType.toLowerCase());
    const path = `xl/media/image${index + 1}.${extension}`;
    zip.file(path, image.data);
    return path;
  });
  const infoSheetName = sheetName.toLowerCase() === "conversion info" ? "_Conversion info" : "Conversion info";
  const info = [
    ["Source workbook", preview.source.fileName], ["Source SHA-256", preview.source.fileSha256],
    ["Target layout", target.label], ["Conversion scope", warnings.find(warning => warning.code === "workbook_conversion_content_only")!.message],
  ].map((values, index) => `<row r="${index + 1}">${values.map((value, column) => cell(`${columnLetters(column)}${index + 1}`, value)).join("")}</row>`).join("");
  zip.file("[Content_Types].xml", `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...imageTypes].map(([extension, type]) => `<Default Extension="${extension}" ContentType="${escaped(type)}"/>`).join("")}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${preview.images.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ""}</Types>`);
  zip.file("_rels/.rels", relationships(relationship("rWorkbook", "officeDocument", "xl/workbook.xml")));
  zip.file("xl/workbook.xml", `${XML_HEADER}<workbook xmlns="${SHEET_NS}" xmlns:r="${OFFICE_REL_NS}"><bookViews><workbookView/></bookViews><sheets><sheet name="${escaped(sheetName)}" sheetId="1" r:id="rSheet1"/><sheet name="${escaped(infoSheetName)}" sheetId="2" r:id="rSheet2"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", relationships(relationship("rSheet1", "worksheet", "worksheets/sheet1.xml") + relationship("rSheet2", "worksheet", "worksheets/sheet2.xml")));
  const columns = `<cols>${headers.map((_, index) => `<col min="${index + 1}" max="${index + 1}" width="${index === target.diagramColumn ? 52 : 30}" customWidth="1"/>`).join("")}</cols>`;
  zip.file("xl/worksheets/sheet1.xml", worksheet(rows.join(""), columns, preview.images.length > 0));
  zip.file("xl/worksheets/sheet2.xml", worksheet(info, '<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="100" customWidth="1"/></cols>'));
  if (preview.images.length) {
    zip.file("xl/worksheets/_rels/sheet1.xml.rels", relationships(relationship("rDrawing", "drawing", "../drawings/drawing1.xml")));
    const ordinals = new Map<string, number>();
    const anchors = preview.images.map((image, index) => {
      const id = image.assignedStepLocalId!;
      const ordinal = ordinals.get(id) ?? 0;
      ordinals.set(id, ordinal + 1);
      return imageAnchor(image, index, rowByStep.get(id)!, target.diagramColumn, ordinal, imagesByStep.get(id)!);
    }).join("");
    zip.file("xl/drawings/drawing1.xml", `${XML_HEADER}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL_NS}">${anchors}</xdr:wsDr>`);
    zip.file("xl/drawings/_rels/drawing1.xml.rels", relationships(media.map((path, index) => relationship(`rImage${index + 1}`, "image", `../media/${path.split("/").at(-1)}`)).join("")));
  }
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const filename = `${preview.source.fileName.replace(/\.xlsx$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")}-${targetFormatId}.xlsx`;
  return { file: new File([new Uint8Array(bytes)], filename, { type: MIME }), warnings };
}

export async function convertFabuBloxWorkbook(
  file: File,
  targetFormatId: FabubloxWorkbookFormatId,
): Promise<ConvertedFabuBloxWorkbook> {
  return writeFabuBloxWorkbook(await parseFabuBloxWorkbook(file), targetFormatId);
}
