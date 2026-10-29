import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import type { FabubloxImportPreview } from "../../shared/types";
import { parseFabuBloxWorkbook } from "./fabublox";
import { capabilityWorkbookFixture } from "./fabublox-compat.test-support";
import { convertFabuBloxWorkbook, writeFabuBloxWorkbook } from "./fabublox-convert";

beforeAll(() => {
  Object.defineProperty(globalThis, "DOMParser", { value: DOMParser, configurable: true });
});

function semantic(preview: FabubloxImportPreview) {
  const meaningful = (step: NonNullable<FabubloxImportPreview["initialSubstrateStep"]>) => ({
    number: step.stepNumber, name: step.name, section: step.sectionName,
    tool: step.toolName, parameters: step.parametersText, comments: step.commentsText,
    images: step.imageIds.map(id => [...preview.images.find(image => image.localId === id)!.data]),
  });
  return {
    substrate: preview.initialSubstrateStep ? meaningful(preview.initialSubstrateStep) : null,
    steps: preview.steps.map(meaningful), sections: preview.sections.map(section => section.name),
    images: preview.images.map(image => [...image.data]),
  };
}

async function classicFixture() {
  const source = await capabilityWorkbookFixture();
  const zip = await JSZip.loadAsync(await source.arrayBuffer());
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Step #</t></is></c><c r="B1" t="inlineStr"><is><t>Step Name</t></is></c><c r="C1" t="inlineStr"><is><t>Tool Name</t></is></c><c r="D1" t="inlineStr"><is><t>Parameters</t></is></c><c r="E1" t="inlineStr"><is><t>Comments</t></is></c><c r="F1" t="inlineStr"><is><t>Layer Stacks</t></is></c><c r="G1" t="inlineStr"><is><t>Custom revision</t></is></c></row>
    <row r="2"><c r="A2"><v>0</v></c><c r="B2" t="inlineStr"><is><t>Substrate Stack</t></is></c><c r="D2" t="inlineStr"><is><t>SOI / 2 µm oxide</t></is></c><c r="F2" t="inlineStr"><is><t>Initial diagram caption</t></is></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Section α — Preparation</t></is></c></row>
    <row r="4"><c r="A4"><v>1</v></c><c r="B4" t="inlineStr"><is><t>Coat α</t></is></c><c r="C4" t="inlineStr"><is><t>Spinner</t></is></c><c r="D4" t="inlineStr"><is><t>4000 rpm &amp; 30 s</t></is></c><c r="E4" t="inlineStr"><is><t>=keep literal &lt;5 nm</t></is></c><c r="G4"><v>7</v></c></row>
  </sheetData><drawing r:id="rFlowDrawing"/></worksheet>`);
  const drawing = await zip.file("xl/drawings/flow.xml")!.async("text");
  zip.file("xl/drawings/flow.xml", drawing.replaceAll("<xdr:col>0</xdr:col>", "<xdr:col>5</xdr:col>"));
  return new File([new Uint8Array(await zip.generateAsync({ type: "uint8array" }))], "synthetic-classic.xlsx", { type: source.type });
}

describe("FabuBlox Excel layout conversion", () => {
  it("round trips capability → classic → capability with substrate, split parameters, metrology rows and unknown columns", async () => {
    const source = await capabilityWorkbookFixture();
    const originalBytes = new Uint8Array(await source.arrayBuffer());
    const original = await parseFabuBloxWorkbook(source);
    const classic = await convertFabuBloxWorkbook(source, "classic-layer-stack");
    const parsedClassic = await parseFabuBloxWorkbook(classic.file);
    expect(parsedClassic.detected.formatId).toBe("classic-layer-stack");
    expect(semantic(parsedClassic)).toEqual(semantic(original));
    expect(parsedClassic.initialSubstrateStep?.rawCells["Source substrate name"]).toBe("Test substrate");
    expect(parsedClassic.initialSubstrateStep?.rawCells["Substrate layers"]).toBe(original.initialSubstrateStep?.rawCells["Substrate layers"]);
    expect(parsedClassic.steps[0].rawCells).toMatchObject({
      "Capability Type": "Coating", "Recipe Name": "Recipe α", "Process Parameters": "Film thickness: 25 nm",
      "Tool Parameters": "Speed: 4000 rpm\nTime: 30 s", Witness: "Keep unknown column",
    });
    const back = await convertFabuBloxWorkbook(classic.file, "capability-flow");
    const parsedBack = await parseFabuBloxWorkbook(back.file);
    expect(parsedBack.detected.formatId).toBe("capability-flow");
    expect(semantic(parsedBack)).toEqual(semantic(original));
    expect(parsedBack.steps[0].parametersText).toBe("Film thickness: 25 nm\n\nTool parameters:\nSpeed: 4000 rpm\nTime: 30 s");
    expect(parsedBack.steps[1]).toMatchObject({ stepNumber: "M1", name: "Inspect test film" });
    expect(parsedBack.steps[0].rawCells.Witness).toBe("Keep unknown column");
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(originalBytes);
    expect(classic.warnings).toContainEqual(expect.objectContaining({ code: "workbook_conversion_content_only" }));
    expect(classic.file.name).toBe("synthetic-capability-flow-classic-layer-stack.xlsx");
  });

  it("round trips a genuine classic fixture without losing literal text, diagrams or numeric extension values", async () => {
    const source = await classicFixture();
    const original = await parseFabuBloxWorkbook(source);
    const capability = await convertFabuBloxWorkbook(source, "capability-flow");
    const converted = await parseFabuBloxWorkbook(capability.file);
    expect(semantic(converted)).toEqual(semantic(original));
    expect(converted.steps[0].rawCells["Custom revision"]).toBe(7);
    expect(converted.initialSubstrateStep?.rawCells["Column 1"]).toBe("Initial diagram caption");
    const classic = await convertFabuBloxWorkbook(capability.file, "classic-layer-stack");
    expect(semantic(await parseFabuBloxWorkbook(classic.file))).toEqual(semantic(original));
    const zip = await JSZip.loadAsync(await capability.file.arrayBuffer());
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("text");
    expect(sheet).toContain("=keep literal &lt;5 nm");
    expect(sheet).not.toContain("<f>");
    expect(await zip.file("xl/worksheets/sheet2.xml")!.async("text")).toContain("Original formatting");
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("_rels/.rels")).not.toBeNull();
  });

  it("does not duplicate tool-only parameters across both layouts", async () => {
    const source = await capabilityWorkbookFixture();
    const preview = await parseFabuBloxWorkbook(source);
    delete preview.steps[0].rawCells["Process Parameters"];
    preview.steps[0].parametersText = "Tool parameters:\nSpeed: 4000 rpm\nTime: 30 s";
    const classic = await writeFabuBloxWorkbook(preview, "classic-layer-stack");
    const capability = await convertFabuBloxWorkbook(classic.file, "capability-flow");
    const parsed = await parseFabuBloxWorkbook(capability.file);
    expect(parsed.steps[0].parametersText).toBe(preview.steps[0].parametersText);
    expect(parsed.steps[0].rawCells["Process Parameters"]).toBeUndefined();
    expect(parsed.steps[0].rawCells["Tool Parameters"]).toBe("Speed: 4000 rpm\nTime: 30 s");
  });

  it("retains multiple diagrams on one process row with exact media bytes and independent relationships", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture());
    const image = preview.images[1];
    preview.images.push({ ...image, localId: "image-extra", data: new Uint8Array(image.data) });
    preview.steps[0].imageIds.push("image-extra");
    const output = await writeFabuBloxWorkbook(preview, "classic-layer-stack");
    const parsed = await parseFabuBloxWorkbook(output.file);
    expect(parsed.steps[0].imageIds).toHaveLength(2);
    expect(parsed.images).toHaveLength(3);
    expect(parsed.images.map(value => [...value.data])).toEqual(preview.images.map(value => [...value.data]));
    const zip = await JSZip.loadAsync(await output.file.arrayBuffer());
    expect((await zip.file("xl/drawings/_rels/drawing1.xml.rels")!.async("text")).match(/Type="[^"]+\/image"/g)).toHaveLength(3);
  });

  it("preserves conflicting aliases, case-distinct unknown columns and reserved source-column names", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture());
    Object.assign(preview.steps[0].rawCells, {
      "Layer Stacks": "Diagram caption α", "Layer Stack": "A different legacy alias caption",
      "Source column: Layer Stack": "An actual source extension", witness: "Case-distinct source column",
      "Step Name": "-",
    });
    const converted = await writeFabuBloxWorkbook(preview, "capability-flow");
    const parsed = await parseFabuBloxWorkbook(converted.file);
    expect(parsed.detected.formatId).toBe("capability-flow");
    expect(parsed.steps[0].rawCells).toMatchObject({
      "Column 1": "Diagram caption α", "Source column: Layer Stack (2)": "A different legacy alias caption",
      "Source column: Layer Stack": "An actual source extension", "Source column: Step Name": "-",
      Witness: "Keep unknown column", witness: "Case-distinct source column",
    });
    expect(parsed.steps[0].name).toBe("Coat test film");
  });

  it.each(["missing", "ambiguous"])("refuses %s initial substrate instead of inferring one during conversion", async kind => {
    const source = await capabilityWorkbookFixture(kind === "ambiguous"
      ? { duplicateInitial: true } : { initial: { capability: "Coating", name: "Not a substrate" } });
    await expect(convertFabuBloxWorkbook(source, "classic-layer-stack")).rejects.toThrow("missing or ambiguous initial substrate");
  });

  it("refuses unassigned diagrams rather than silently dropping them", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture());
    preview.images[1].assignedStepLocalId = null;
    preview.unassignedImageIds = [preview.images[1].localId];
    await expect(writeFabuBloxWorkbook(preview, "classic-layer-stack")).rejects.toThrow("unassigned diagrams were not discarded");
  });

  it("does not truncate Excel-unrepresentable content", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture());
    preview.steps[0].rawCells.Witness = "x".repeat(32_768);
    await expect(writeFabuBloxWorkbook(preview, "classic-layer-stack")).rejects.toThrow("did not truncate");
  });
});
