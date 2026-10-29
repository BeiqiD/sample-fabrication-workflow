import JSZip from "jszip";

// Synthetic content only: this fixture reproduces the export layout, not a
// user's process or any uploaded workbook's text/images.
export const capabilityInitialPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII="), character => character.charCodeAt(0));
export const capabilityProcessPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwz1/2HwAEeQJM7VhlYAAAAABJRU5ErkJggg=="), character => character.charCodeAt(0));

const spreadsheetNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationshipNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";

export const capabilityColumnLabels = {
  number: "Step #",
  capability: "Capability Type",
  name: "Step Name",
  tool: "Tool Name",
  recipe: "Recipe Name",
  process: "Process Parameters",
  toolParameters: "Tool Parameters",
  notes: "Notes",
  extension: "Witness",
} as const;

type Column = keyof typeof capabilityColumnLabels;
type Row = Partial<Record<Column, string>>;

function escaped(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function letters(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cell(reference: string, value: string) {
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escaped(value)}</t></is></c>`;
}

function worksheet(rows: string, extra = "") {
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}"><sheetData>${rows}</sheetData>${extra}</worksheet>`;
}

function drawing(anchors: Array<{ row: number; relationship: string }>) {
  const anchor = ({ row, relationship }: typeof anchors[number]) => `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:blipFill><a:blip r:embed="${relationship}"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
  return `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${relationshipNamespace}">${anchors.map(anchor).join("")}</xdr:wsDr>`;
}

export interface CapabilityWorkbookOptions {
  sheetName?: string;
  columns?: readonly Column[];
  initial?: Row;
  process?: Row;
  duplicateInitial?: boolean;
  initialImage?: boolean;
  processImage?: boolean;
  substrateSheet?: boolean;
  substrateName?: string;
}

export async function capabilityWorkbookFixture(options: CapabilityWorkbookOptions = {}) {
  const zip = new JSZip();
  const name = options.sheetName ?? "Synthetic capability flow";
  const columns = options.columns ?? Object.keys(capabilityColumnLabels) as Column[];
  const row = (number: number, values: Row) => `<row r="${number}">${columns.map((key, column) => values[key] === undefined ? "" : cell(`${letters(column + 1)}${number}`, values[key]!)).join("")}</row>`;
  const headers = Object.fromEntries(columns.map(key => [key, capabilityColumnLabels[key]])) as Row;
  const initial: Row = options.initial ?? { capability: "Substrate", name: "Test substrate", process: "Layer 1: Test oxide — 25 nm", notes: "Handle with care & retain α" };
  const flowRows = [
    row(1, headers),
    row(2, initial),
    `<row r="3">${cell("A3", "Section A — Preparation")}</row>`,
    row(4, { number: "1", capability: "Coating", name: "Coat test film", tool: "Test spinner", recipe: "Recipe α", process: "Film thickness: 25 nm", toolParameters: "Speed: 4000 rpm\nTime: 30 s", notes: "Keep <5 nm & verify \"α\"", extension: "Keep unknown column", ...options.process }),
    row(5, { number: "M1", capability: "Metrology", name: "Inspect test film", tool: "Test microscope", notes: "Record surface condition" }),
  ];
  if (options.duplicateInitial) flowRows.push(row(6, { capability: "Substrate", name: "Another test substrate", process: "Other material" }));
  const substrateSheet = options.substrateSheet !== false;
  const sheets = [{ name, id: "rFlow", path: "worksheets/sheet1.xml" }, { name: "Overview", id: "rOverview", path: "worksheets/sheet2.xml" }, ...(substrateSheet ? [{ name: "Substrate", id: "rSubstrate", path: "worksheets/sheet3.xml" }] : [])];
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map(sheet => `<Override PartName="/xl/${sheet.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/drawings/flow.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/drawings/overview.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="${packageNamespace}"><Relationship Id="rWorkbook" Type="${relationshipNamespace}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}"><fileVersion appName="xl" lastEdited="5"/><sheets>${sheets.map((sheet, index) => `<sheet name="${escaped(sheet.name)}" sheetId="${index + 1}" r:id="${sheet.id}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="${packageNamespace}">${sheets.map(sheet => `<Relationship Id="${sheet.id}" Type="${relationshipNamespace}/worksheet" Target="${sheet.path}"/>`).join("")}</Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", worksheet(flowRows.join(""), '<mergeCells count="1"><mergeCell ref="A3:I3"/></mergeCells><drawing r:id="rFlowDrawing"/>'));
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", `<Relationships xmlns="${packageNamespace}"><Relationship Id="rFlowDrawing" Type="${relationshipNamespace}/drawing" Target="../drawings/flow.xml"/></Relationships>`);
  zip.file("xl/drawings/flow.xml", drawing([...(options.initialImage === false ? [] : [{ row: 1, relationship: "rInitial" }]), ...(options.processImage === false ? [] : [{ row: 3, relationship: "rProcess" }])]));
  zip.file("xl/drawings/_rels/flow.xml.rels", `<Relationships xmlns="${packageNamespace}"><Relationship Id="rInitial" Type="${relationshipNamespace}/image" Target="../media/initial-z.png"/><Relationship Id="rProcess" Type="${relationshipNamespace}/image" Target="../media/process-a.png"/></Relationships>`);
  zip.file("xl/media/initial-z.png", capabilityInitialPng);
  zip.file("xl/media/process-a.png", capabilityProcessPng);
  zip.file("xl/worksheets/sheet2.xml", worksheet(`<row r="1">${cell("A1", "Version")}${cell("B1", "v777")}</row>`, '<drawing r:id="rOverviewDrawing"/>'));
  zip.file("xl/worksheets/_rels/sheet2.xml.rels", `<Relationships xmlns="${packageNamespace}"><Relationship Id="rOverviewDrawing" Type="${relationshipNamespace}/drawing" Target="../drawings/overview.xml"/></Relationships>`);
  zip.file("xl/drawings/overview.xml", drawing([{ row: 0, relationship: "rLogo" }]));
  zip.file("xl/drawings/_rels/overview.xml.rels", `<Relationships xmlns="${packageNamespace}"><Relationship Id="rLogo" Type="${relationshipNamespace}/image" Target="../media/overview-logo.png"/></Relationships>`);
  zip.file("xl/media/overview-logo.png", capabilityProcessPng);
  if (substrateSheet) {
    zip.file("xl/worksheets/sheet3.xml", worksheet([
      `<row r="1">${cell("A1", options.substrateName ?? "Test substrate")}</row>`,
      `<row r="2">${cell("A2", "Description")}${cell("B2", "Two-layer research stack")}</row>`,
      `<row r="4">${cell("A4", "Layer")}${cell("B4", "Material")}${cell("C4", "Thickness")}</row>`,
      `<row r="5">${cell("A5", "Layer 1")}${cell("B5", "Test oxide")}${cell("C5", "25 nm")}</row>`,
      `<row r="6">${cell("A6", "Layer 2")}${cell("B6", "Test base")}${cell("C6", "300 µm")}</row>`,
    ].join("")));
  }
  return new File([new Uint8Array(await zip.generateAsync({ type: "uint8array" }))], "synthetic-capability-flow.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export async function classicWorkbookWithoutDiagramFixture(initialCapability?: string) {
  const zip = new JSZip();
  const hasCapabilityExtension = initialCapability !== undefined;
  const rows = [
    `<row r="1">${cell("A1", "Step #")}${cell("B1", "Step Name")}${cell("C1", "Parameters")}${cell("D1", "Comments")}${hasCapabilityExtension ? cell("E1", "Capability Type") : ""}</row>`,
    `<row r="2">${cell("A2", "0")}${cell("B2", "Substrate Stack")}${cell("C2", "Test base / 250 µm")}${cell("D2", "Use recorded start")}${hasCapabilityExtension ? cell("E2", initialCapability) : ""}</row>`,
    `<row r="3">${cell("A3", "1")}${cell("B3", "Prepare film")}${cell("C3", "350 K")}${cell("D3", "Keep timing")}${hasCapabilityExtension ? cell("E3", "Cleaning") : ""}</row>`,
  ];
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="${packageNamespace}"><Relationship Id="rWorkbook" Type="${relationshipNamespace}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}"><sheets><sheet name="Classic without diagrams" sheetId="1" r:id="rFlow"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="${packageNamespace}"><Relationship Id="rFlow" Type="${relationshipNamespace}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", worksheet(rows.join("")));
  return new File([new Uint8Array(await zip.generateAsync({ type: "uint8array" }))], "synthetic-classic-without-diagrams.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
