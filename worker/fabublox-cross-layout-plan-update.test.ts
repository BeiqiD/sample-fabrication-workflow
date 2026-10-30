import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FabubloxImportResult } from "../shared/contracts/fabublox-import";
import type { PlanUpdatePreview, ProcessingSampleDetail, RunStartPreview } from "../shared/types";
import { parseFabuBloxWorkbook } from "../src/lib/fabublox";
import { capabilityProcessPng, capabilityWorkbookFixture } from "../src/lib/fabublox-compat.test-support";
import type { FabubloxWorkbookFormatId } from "../src/lib/fabublox-formats";
import worker from "./index";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const sampleId = "cross-layout-sample";
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
beforeAll(() => Object.defineProperty(globalThis, "DOMParser", { value: DOMParser, configurable: true }));
afterEach(() => databases.splice(0).forEach(database => database.close()));

function escaped(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface SourceStep { name: string; number: string; capability: string; identity: string }
const originalSteps: SourceStep[] = [
  { name: "Clean", number: "1", capability: "Cleaning", identity: "clean" },
  { name: "Coat", number: "2", capability: "Coating", identity: "coat-first" },
  { name: "Inspect", number: "M1", capability: "Metrology", identity: "inspect" },
  { name: "Coat", number: "3", capability: "Coating", identity: "coat-second" },
  { name: "-", number: "4", capability: "Cleave", identity: "placeholder-first" },
  { name: "-", number: "5", capability: "Bond", identity: "placeholder-second" },
];
const updatedSteps: SourceStep[] = [
  { ...originalSteps[0], number: "100" },
  { ...originalSteps[2], number: "M19" },
  { name: "Rinse", number: "200", capability: "Cleaning", identity: "rinse" },
  { ...originalSteps[1], number: "201" },
  { ...originalSteps[3], number: "202" },
  { ...originalSteps[4], number: "300" },
  { ...originalSteps[5], number: "301" },
];

/** Independent input layouts, not converter output: both adapters must reach
 * the same mature server matching path even when columns and numbers change. */
async function workbook(layout: FabubloxWorkbookFormatId, revision: 1 | 2) {
  const source = await capabilityWorkbookFixture({ substrateSheet: false });
  const zip = await JSZip.loadAsync(await source.arrayBuffer());
  const classic = layout === "classic-layer-stack";
  const headers = classic
    ? ["Step #", "Step Name", "Tool Name", "Parameters", "Comments", "Layer Stacks", "Capability Type", "Witness"]
    : ["", "Step Number", "Capability Type", "Name", "Tool", "Recipe Name", "Tool Parameters", "Notes", "Process Parameters", "Witness"];
  const row = (number: number, values: unknown[]) => `<row r="${number}">${values.map((value, column) => value === null || value === undefined || value === "" ? ""
    : `<c r="${String.fromCharCode(65 + column)}${number}" t="inlineStr"><is><t xml:space="preserve">${escaped(String(value))}</t></is></c>`).join("")}</row>`;
  const substrate = classic
    ? ["0", "Substrate Stack", "", `Initial stack revision ${revision}`, "Initial source note", "", "Substrate", "Initial witness"]
    : ["", "", "Substrate", `Research substrate revision ${revision}`, "", "", "", "Initial source note", `Initial stack revision ${revision}`, "Initial witness"];
  const steps = revision === 1 ? originalSteps : updatedSteps;
  const rows = [row(1, headers), row(2, substrate), row(3, ["Section α — Preparation"]), ...steps.map((step, index) => {
    const process = `Plan ${revision}: ${step.identity}`;
    const tool = `Setting ${revision}: ${step.identity}`;
    return row(index + 4, classic
      ? [step.number, step.name, `Tool ${revision}`, `${process}\n\nTool parameters:\n${tool}`, `Plan note ${revision}: ${step.identity}`, "", step.capability, step.identity]
      : ["", step.number, step.capability, step.name, `Tool ${revision}`, `Recipe ${revision}`, tool, `Plan note ${revision}: ${step.identity}`, process, step.identity]);
  })];
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${rows.join("")}</sheetData><drawing r:id="rFlowDrawing"/></worksheet>`);
  if (classic) {
    const drawing = await zip.file("xl/drawings/flow.xml")!.async("text");
    zip.file("xl/drawings/flow.xml", drawing.replaceAll("<xdr:col>0</xdr:col>", "<xdr:col>5</xdr:col>").replaceAll("<xdr:col>1</xdr:col>", "<xdr:col>6</xdr:col>"));
  }
  return new File([new Uint8Array(await zip.generateAsync({ type: "uint8array" }))], `${layout}-v${revision}.xlsx`, { type: source.type });
}

function fixture() {
  const database = referenceTestDatabase();
  databases.push(database);
  database.prepare("INSERT INTO samples(id,code,title,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)")
    .run(sampleId, "CROSS-LAYOUT", "Cross-layout process", "2026-10-29T10:00:00.000Z", "2026-10-29T10:00:00.000Z");
  const stored = new Map<string, Uint8Array>();
  const get = async (key: string) => {
    const bytes = stored.get(key);
    return bytes ? { body: new Response(bytes).body!, size: bytes.byteLength, httpEtag: '"fixture"', writeHttpMetadata() {} } : null;
  };
  const env = {
    AUTH_MODE: "disabled",
    R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: "local-r2", installationId: "61bcda31-b78f-4b5a-b2b8-9698e6baa30b", bucketName: "cross-layout-fixture" }),
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: { get, head: get,
      async put(key: string, value: BodyInit) { stored.set(key, new Uint8Array(await new Response(value).arrayBuffer())); },
      async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) stored.delete(key); },
    } as unknown as R2Bucket,
  } satisfies Env;
  async function request<T>(path: string, body?: unknown, method = "POST", status = 200): Promise<T> {
    const response = await worker.fetch(new Request(`https://app.test/api${path}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }), env, context);
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
    return value as T;
  }
  async function importWorkbook(file: File, recipeFamilyId?: string) {
    const preview = await parseFabuBloxWorkbook(file);
    expect(preview.schemaVersion).toBe(2);
    expect(preview.initialSubstrateStep).toMatchObject({ stepNumber: "0", name: "Substrate Stack" });
    expect(preview.steps.map(step => step.name)).toEqual((file.name.endsWith("v1.xlsx") ? originalSteps : updatedSteps).map(step => step.name));
    expect(preview.steps.every(step => step.stepNumber !== "0")).toBe(true);
    const form = new FormData();
    form.set("workbook", file);
    form.set("manifest", new File([JSON.stringify({ ...preview, recipeFamilyId,
      images: preview.images.map(({ data: _data, ...image }) => image),
    })], "manifest.json", { type: "application/json" }));
    for (const image of preview.images) form.set(`image:${image.localId}`, new File([new Uint8Array(image.data)], image.sourcePart.split("/").at(-1)!, { type: image.mimeType }));
    const response = await worker.fetch(new Request("https://app.test/api/imports/fabublox", {
      method: "POST", headers: { "X-Import-Request-Id": crypto.randomUUID() }, body: form,
    }), env, context);
    const result = await response.json() as FabubloxImportResult;
    expect(response.status, JSON.stringify(result)).toBe(201);
    return { preview, result };
  }
  return { database, stored, request, importWorkbook };
}

function confirmation(preview: RunStartPreview, revision?: string) {
  return { confirmed: true, expectedSampleUpdatedAt: preview.sampleUpdatedAt,
    expectedPreviousStateHash: preview.sampleCurrentState.hash,
    expectedTemplateStructureKey: preview.comparisonTarget!.key,
    expectedTemplateStateHash: preview.comparisonTarget!.stateHash,
    expectedLatestRunId: preview.expectedLatestRunId,
    ...(revision ? { expectedCurrentPlanRevisionId: revision } : {}),
  };
}

describe("FabuBlox cross-layout re-import updates an existing process run", () => {
  // Covers real parsing, accepted multipart publication, run writes and every
  // SQL migration; this is a bounded integration fixture, not a latency check.
  it.each([
    ["classic-layer-stack", "capability-flow"],
    ["capability-flow", "classic-layer-stack"],
  ] as const)("preserves execution and identity across %s → %s", async (originalLayout, nextLayout) => {
    const { database, stored, request, importWorkbook } = fixture();
    const original = await importWorkbook(await workbook(originalLayout, 1));
    const originalTemplate = database.prepare("SELECT recipe_family_id, initial_state_hash, content_json FROM template_versions WHERE id=?")
      .get(original.result.templateVersionId) as { recipe_family_id: string; initial_state_hash: string; content_json: string };
    const startPreview = await request<RunStartPreview>(`/samples/${sampleId}/runs/preview`, { templateVersionId: original.result.templateVersionId });
    expect(startPreview.canConfirm).toBe(true);
    const { id: runId } = await request<{ id: string }>(`/samples/${sampleId}/runs`, {
      templateVersionId: original.result.templateVersionId, substrateConfirmation: confirmation(startPreview),
    }, "POST", 201);
    const originalRun = database.prepare("SELECT initial_state_hash, current_plan_revision_id FROM runs WHERE id=?")
      .get(runId) as { initial_state_hash: string; current_plan_revision_id: string };
    const initialSnapshot = database.prepare("SELECT content_json FROM state_representations WHERE hash=?").get(originalRun.initial_state_hash);
    const before = database.prepare("SELECT id,logical_step_key,updated_at,expected_state_hash FROM run_steps WHERE run_id=? ORDER BY position")
      .all(runId) as Array<{ id: string; logical_step_key: string; updated_at: string; expected_state_hash: string }>;
    expect(before).toHaveLength(originalSteps.length);
    const completed = before[0];
    const image = database.prepare("SELECT a.id,a.r2_key FROM state_representation_assets s JOIN assets a ON a.id=s.asset_id WHERE s.state_hash=?")
      .get(completed.expected_state_hash) as { id: string; r2_key: string };
    await request(`/samples/${sampleId}/runs/${runId}/steps/${completed.id}`, {
      status: "done", title: "Clean", toolName: "Actual cleaning tool", parametersText: "Actual pressure: 1 Pa",
      commentsText: "Actual operator comment α", deviationNote: "Recorded actual deviation", notes: "Actual execution notes",
      expectedUpdatedAt: completed.updated_at, assetId: image.id,
    }, "PATCH");
    database.prepare("INSERT INTO run_step_comments(id,run_step_id,scope,legacy_body,actor_email,created_at) VALUES(?,?,'individual',?,?,?)")
      .run("actual-comment", completed.id, "Retain completed-step evidence", "operator@example.com", new Date().toISOString());
    const actual = () => database.prepare("SELECT id,status,tool_name,parameters_text,comments_text,deviation_note,notes,actualized_at FROM run_steps WHERE id=?").get(completed.id);
    const actualBefore = actual();
    const commentsBefore = database.prepare("SELECT * FROM run_step_comments WHERE run_step_id=?").all(completed.id);
    const assetsBefore = database.prepare("SELECT * FROM run_step_assets WHERE run_step_id=?").all(completed.id);
    expect(assetsBefore).toHaveLength(1);
    expect(stored.get(image.r2_key)).toEqual(capabilityProcessPng);

    const next = await importWorkbook(await workbook(nextLayout, 2), originalTemplate.recipe_family_id);
    expect(next.result.version).toBe(original.result.version + 1);
    expect(database.prepare("SELECT initial_state_hash FROM template_versions WHERE id=?").get(next.result.templateVersionId)?.initial_state_hash)
      .not.toBe(originalRun.initial_state_hash);
    const preview = await request<PlanUpdatePreview>(`/samples/${sampleId}/runs/${runId}/plan-update/preview`, { templateVersionId: next.result.templateVersionId });
    expect(preview).toMatchObject({ compatible: true, preservedCount: 6, additionCount: 1, supersededCount: 0, skippedAdditionCount: 0 });
    expect(preview.historicalDifferences).toContainEqual(expect.objectContaining({ kind: "modified_executed_step", existingStepId: completed.id }));
    await request(`/samples/${sampleId}/runs/${runId}/plan-update`, {
      templateVersionId: next.result.templateVersionId,
      substrateConfirmation: confirmation(preview.substrateTransition, originalRun.current_plan_revision_id),
    });

    expect(actual()).toEqual(actualBefore);
    expect(database.prepare("SELECT * FROM run_step_comments WHERE run_step_id=?").all(completed.id)).toEqual(commentsBefore);
    expect(database.prepare("SELECT * FROM run_step_assets WHERE run_step_id=?").all(completed.id)).toEqual(assetsBefore);
    expect(stored.get(image.r2_key)).toEqual(capabilityProcessPng);
    expect(database.prepare("SELECT initial_state_hash FROM runs WHERE id=?").get(runId)).toEqual({ initial_state_hash: originalRun.initial_state_hash });
    expect(database.prepare("SELECT content_json FROM state_representations WHERE hash=?").get(originalRun.initial_state_hash)).toEqual(initialSnapshot);
    expect(database.prepare("SELECT content_json FROM template_versions WHERE id=?").get(original.result.templateVersionId))
      .toEqual({ content_json: originalTemplate.content_json });

    const after = await request<ProcessingSampleDetail>(`/samples/${sampleId}?view=processing`, undefined, "GET");
    const run = after.runs.find(candidate => candidate.id === runId)!;
    expect(run).toMatchObject({ templateVersionId: next.result.templateVersionId, planRevisionNumber: 2, initialStateHash: originalRun.initial_state_hash, status: "active" });
    expect(run.steps).toHaveLength(updatedSteps.length);
    for (const previous of before) {
      const matched = run.steps.find(step => step.logicalStepKey === previous.logical_step_key)!;
      expect(matched, previous.logical_step_key).toBeDefined();
      expect(matched.id).toBe(previous.id);
      expect(matched.status).toBe(previous.id === completed.id ? "done" : "pending");
      expect(matched.plannedParametersText).toContain("Plan 2:");
    }
    expect(run.steps.find(step => step.id === completed.id)).toMatchObject({ parametersText: "Actual pressure: 1 Pa", commentsText: "Actual operator comment α", toolName: "Actual cleaning tool" });
    const ordered = [...run.steps].sort((left, right) => left.planPosition! - right.planPosition!);
    expect(ordered.map(step => step.plannedTitle)).toEqual(updatedSteps.map(step => step.name));
    expect(ordered.map(step => step.id)).toEqual([before[0].id, before[2].id, expect.any(String), before[1].id, before[3].id, before[4].id, before[5].id]);
    expect(ordered[2]).toMatchObject({ status: "pending", plannedTitle: "Rinse" });
    expect(before.some(step => step.id === ordered[2].id)).toBe(false);
    expect(ordered.filter(step => step.plannedTitle === "-").map(step => step.logicalStepKey)).toEqual(["name:-:1", "name:-:2"]);
    expect(run.steps.some(step => step.plannedTitle === "Substrate Stack")).toBe(false);
  }, 45_000);
});
