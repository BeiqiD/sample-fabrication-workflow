import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFabuBloxWorkbook } from "./fabublox";

beforeAll(() => {
  Object.defineProperty(globalThis, "DOMParser", { value: DOMParser, configurable: true });
});

const transparentPng = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64"));

async function syntheticDrawingFixture() {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Synthetic" sheetId="1" r:id="rSheet1"/></sheets>
    </workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rSheet1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`);
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <si><t>Step #</t></si><si><t>Step Name</t></si><si><r><t>Co</t></r><r><t>at</t></r></si>
    </sst>`);
  const worksheetPath = "xl/worksheets/sheet1.xml";
  zip.file(worksheetPath, `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheetData>
        <row r="1">
          <c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>
          <c r="C1" t="inlineStr"><is><t>Tool Name</t></is></c><c r="D1" t="inlineStr"><is><t>Parameters</t></is></c>
          <c r="E1" t="inlineStr"><is><t>Comments</t></is></c><c r="J1" t="inlineStr"><is><t>Layer Stacks</t></is></c>
        </row>
        <row r="2"><c r="A2"><v>0</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="inlineStr"><is><t>Spinner</t></is></c><c r="D2" t="inlineStr"><is><t>4000 rpm</t></is></c></row>
        <row r="3"><c r="A3"><v>1</v></c><c r="B3" t="inlineStr"><is><t>Develop</t></is></c><c r="D3" t="inlineStr"><is><t>30 s</t></is></c></row>
      </sheetData>
      <drawing r:id="rIdDrawing"/>
    </worksheet>`);
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
    </Relationships>`);
  const anchor = (row: number, relationshipId: string) => `<xdr:twoCellAnchor>
    <xdr:from><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic><xdr:blipFill><a:blip r:embed="${relationshipId}"/></xdr:blipFill></xdr:pic><xdr:clientData/>
  </xdr:twoCellAnchor>`;
  zip.file("xl/drawings/drawing1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      ${anchor(1, "rImageA")}${anchor(2, "rImageB")}${anchor(8, "rUnassigned")}
    </xdr:wsDr>`);
  zip.file("xl/drawings/_rels/drawing1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rImageA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image9.png"/>
      <Relationship Id="rImageB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
      <Relationship Id="rUnassigned" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image5.png"/>
    </Relationships>`);
  zip.file("xl/media/image1.png", transparentPng);
  zip.file("xl/media/image5.png", transparentPng);
  zip.file("xl/media/image9.png", transparentPng);
  return new File([await zip.generateAsync({ type: "uint8array" })], "synthetic.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

describe("OOXML drawing relationships", () => {
  it("supports twoCellAnchor and does not trust media filename order", async () => {
    const preview = await parseFabuBloxWorkbook(await syntheticDrawingFixture());
    expect(preview.steps).toHaveLength(2);
    expect(preview.images.map((image) => image.sourcePart)).toEqual([
      "xl/media/image9.png",
      "xl/media/image1.png",
      "xl/media/image5.png",
    ]);
    expect(preview.steps[0].imageIds).toEqual(["image-1"]);
    expect(preview.steps[1].imageIds).toEqual(["image-2"]);
    expect(preview.unassignedImageIds).toEqual(["image-3"]);
  });
});
