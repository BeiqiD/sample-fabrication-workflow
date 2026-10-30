import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFabuBloxWorkbook } from "./fabublox";
import { capabilityInitialPng, capabilityProcessPng, capabilityWorkbookFixture, classicWorkbookWithoutDiagramFixture } from "./fabublox-compat.test-support";

beforeAll(() => {
  Object.defineProperty(globalThis, "DOMParser", { value: DOMParser, configurable: true });
});

describe("classic FabuBlox layouts without diagrams", () => {
  it.each([
    { label: "no capability extension", capability: undefined },
    { label: "a blank substrate capability extension", capability: "" },
    { label: "an independent Process capability extension", capability: "Process" },
  ])("preserves explicit Step 0 when there is no Layer Stacks column and $label", async ({ capability }) => {
    const preview = await parseFabuBloxWorkbook(await classicWorkbookWithoutDiagramFixture(capability));
    expect(preview.detected).toMatchObject({ formatId: "classic-layer-stack", layerStackColumn: null });
    expect(preview.initialSubstrateStep).toMatchObject({ name: "Substrate Stack", stepNumber: "0", sourceRow: 2, parametersText: "Test base / 250 µm", commentsText: "Use recorded start", imageIds: [] });
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0]).toMatchObject({ stepNumber: "1", name: "Prepare film", parametersText: "350 K", commentsText: "Keep timing" });
    if (capability) expect(preview.initialSubstrateStep?.rawCells["Capability Type"]).toBe(capability);
    expect(preview.images).toEqual([]);
    expect(preview.initialStateImageIds).toEqual([]);
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: "initial_substrate_missing_diagram", sourceRow: 2 }));
    expect(preview.warnings.some(warning => warning.code === "missing_initial_substrate_step" || warning.code === "ambiguous_initial_substrate_step")).toBe(false);
  });
});

describe("FabuBlox capability-flow compatibility", () => {
  it("recognizes an explicitly declared unnumbered substrate and keeps its image out of executable steps", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture());
    expect(preview.schemaVersion).toBe(2);
    expect(preview.detected).toMatchObject({ formatId: "capability-flow", headerRow: 1, layerStackColumn: 0 });
    expect(preview.initialSubstrateStep).toMatchObject({ name: "Substrate Stack", stepNumber: "0", sourceRow: 2 });
    expect(preview.initialSubstrateStep?.rawCells["Source substrate name"]).toBe("Test substrate");
    expect(preview.initialStateImageIds).toEqual(["image-1"]);
    expect(preview.initialSubstrateStep?.imageIds).toEqual(["image-1"]);
    expect(preview.images.find(image => image.localId === "image-1")).toMatchObject({ sourcePart: "xl/media/initial-z.png", anchor: { row: 1, col: 0 }, assignedStepLocalId: preview.initialSubstrateStep?.localId });
    expect(preview.images.find(image => image.localId === "image-1")?.data).toEqual(capabilityInitialPng);
    expect(preview.steps.map(step => [step.stepNumber, step.name])).toEqual([["1", "Coat test film"], ["M1", "Inspect test film"]]);
    expect(preview.steps[0].imageIds).toEqual(["image-2"]);
    expect(preview.images.find(image => image.localId === "image-2")?.data).toEqual(capabilityProcessPng);
    expect(preview.steps.every(step => !step.imageIds.includes("image-1"))).toBe(true);
    expect(preview.images).toHaveLength(2);
    expect(preview.images.some(image => image.sourcePart.includes("logo"))).toBe(false);
    expect(preview.warnings.some(warning => warning.code === "missing_initial_substrate_step" || warning.code === "image_outside_layer_column")).toBe(false);
  });

  it("retains split process/tool parameters, notes, recipes, section context and unknown fields", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture());
    const process = preview.steps[0];
    expect(process.parametersText).toContain("Film thickness: 25 nm");
    expect(process.parametersText).toContain("Speed: 4000 rpm\nTime: 30 s");
    expect(process.commentsText).toBe("Keep <5 nm & verify \"α\"");
    expect(process.toolName).toBe("Test spinner");
    expect(process.rawCells).toMatchObject({ "Capability Type": "Coating", "Recipe Name": "Recipe α", "Process Parameters": "Film thickness: 25 nm", "Tool Parameters": "Speed: 4000 rpm\nTime: 30 s", Notes: "Keep <5 nm & verify \"α\"", Witness: "Keep unknown column" });
    expect(preview.sections.map(section => section.name)).toEqual(["Section A — Preparation"]);
    expect(preview.steps.map(step => step.sectionName)).toEqual(["Section A — Preparation", "Section A — Preparation"]);
    expect(preview.steps[1].rawCells["Capability Type"]).toBe("Metrology");
    expect(preview.steps[1]).toMatchObject({ stepNumber: "M1", name: "Inspect test film" });
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: "metrology_rows_retained" }));
    expect(preview.steps.map(step => step.position)).toEqual([0, 1]);
  });

  it("carries the separate substrate description and ordered material/thickness table into the snapshot", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture());
    const raw = preview.initialSubstrateStep?.rawCells;
    expect(raw?.["Substrate description"]).toBe("Two-layer research stack");
    const layers = String(raw?.["Substrate layers"]);
    expect(layers).toContain("Layer 1");
    expect(layers).toContain("Test oxide");
    expect(layers).toContain("25 nm");
    expect(layers).toContain("Layer 2");
    expect(layers).toContain("Test base");
    expect(layers).toContain("300 µm");
    expect(layers.indexOf("Layer 1")).toBeLessThan(layers.indexOf("Layer 2"));
  });

  it("retains a placeholder step name so capability labels do not change existing step identity", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture({ process: { name: "-", capability: "Plasma Etch" } }));
    expect(preview.steps[0]).toMatchObject({ stepNumber: "1", name: "-", rawCells: { "Step Name": "-", "Capability Type": "Plasma Etch" } });
    expect(preview.steps[0].parametersText).toContain("Film thickness: 25 nm");
    expect(preview.steps[0].imageIds).toEqual(["image-2"]);
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: "placeholder_step_name", sourceRow: 4 }));
  });

  it("warns without merging metadata from an auxiliary sheet that names another substrate", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture({ substrateName: "Unrelated substrate" }));
    expect(preview.initialSubstrateStep).toMatchObject({ name: "Substrate Stack", rawCells: { "Source substrate name": "Test substrate" } });
    expect(preview.initialSubstrateStep?.rawCells["Substrate description"]).toBeUndefined();
    expect(preview.initialSubstrateStep?.rawCells["Substrate layers"]).toBeUndefined();
    expect(preview.initialSubstrateStep?.rawCells["Source substrate sheet"]).toBeUndefined();
    expect(preview.initialSubstrateStep?.parametersText).toContain("Layer 1: Test oxide — 25 nm");
    expect(preview.initialStateImageIds).toEqual(["image-1"]);
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: "substrate_metadata_mismatch" }));
  });

  it("recognizes the capability layout when the optional process-parameters column is absent", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture({ columns: ["number", "capability", "name", "tool", "recipe", "toolParameters", "notes", "extension"] }));
    expect(preview.detected).toMatchObject({ formatId: "capability-flow", layerStackColumn: 0 });
    expect(preview.initialSubstrateStep).toMatchObject({ name: "Substrate Stack", stepNumber: "0" });
    expect(preview.initialStateImageIds).toEqual(["image-1"]);
    expect(preview.steps[0].parametersText).toContain("Speed: 4000 rpm\nTime: 30 s");
    expect(preview.steps[0].rawCells["Process Parameters"]).toBeUndefined();
    expect(preview.steps[0].commentsText).toBe("Keep <5 nm & verify \"α\"");
    expect(preview.warnings.some(warning => warning.code === "missing_header")).toBe(false);
  });

  it("uses semantic headers rather than the flow title, Excel producer metadata or content version", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture({ sheetName: "Renamed research plan", columns: ["number", "capability", "notes", "name", "toolParameters", "recipe", "tool", "process", "extension"] }));
    expect(preview.source.sheetName).toBe("Renamed research plan");
    expect(preview.detected).toMatchObject({ formatId: "capability-flow", layerStackColumn: 0 });
    expect(preview.initialSubstrateStep?.name).toBe("Substrate Stack");
    expect(preview.steps[0]).toMatchObject({ name: "Coat test film", toolName: "Test spinner", commentsText: "Keep <5 nm & verify \"α\"" });
    expect(preview.steps[0].parametersText).toContain("Film thickness: 25 nm");
    expect(preview.steps[0].parametersText).toContain("Speed: 4000 rpm");
    expect(preview.initialStateImageIds).toEqual(["image-1"]);
  });

  it("does not choose between two explicit substrate rows", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture({ duplicateInitial: true }));
    expect(preview.initialSubstrateStep).toBeNull();
    expect(preview.initialStateImageIds).toEqual([]);
    expect(preview.steps.map(step => step.name)).toContain("Test substrate");
    expect(preview.steps.map(step => step.name)).toContain("Another test substrate");
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: "ambiguous_initial_substrate_step" }));
  });

  it("does not infer a substrate from an unrelated Step 0 or the presence of a Substrate sheet", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture({ initial: { number: "0", capability: "Anneal", name: "Thermal preparation" } }));
    expect(preview.initialSubstrateStep).toBeNull();
    expect(preview.initialStateImageIds).toEqual([]);
    expect(preview.steps[0]).toMatchObject({ name: "Thermal preparation", stepNumber: "0" });
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: "missing_initial_substrate_step" }));
  });

  it("keeps an explicit substrate without a diagram and never borrows the first process image", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture({ initialImage: false }));
    expect(preview.initialSubstrateStep).toMatchObject({ name: "Substrate Stack", stepNumber: "0", imageIds: [] });
    expect(preview.initialStateImageIds).toEqual([]);
    expect(preview.steps[0].imageIds).toEqual(["image-1"]);
    expect(preview.images[0].sourcePart).toBe("xl/media/process-a.png");
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: "initial_substrate_missing_diagram", sourceRow: 2 }));
  });

  it("does not require the auxiliary Substrate sheet when the flow itself declares the substrate", async () => {
    const preview = await parseFabuBloxWorkbook(await capabilityWorkbookFixture({ substrateSheet: false }));
    expect(preview.initialSubstrateStep).toMatchObject({ name: "Substrate Stack", stepNumber: "0" });
    expect(preview.initialSubstrateStep?.parametersText).toContain("Layer 1: Test oxide — 25 nm");
    expect(preview.initialStateImageIds).toEqual(["image-1"]);
  });
});
