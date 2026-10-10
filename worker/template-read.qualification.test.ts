import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProcessTemplateFamilySummary, TemplateDetail, TemplateRecord, MetrologyTemplateSummary } from "../shared/contracts/template";
import { TEMPLATE_READ_FIXTURE_SQL, TEMPLATE_READ_FIXTURE_TABLES } from "../test/template-read-fixture";

// Genuine bundled Worker and actual Miniflare D1/R2 bindings. No Node D1/Env
// facade, provider response substitution or File-authority transition fixture.
let native: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
beforeAll(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", write: false });
  native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], r2Buckets: ["ASSETS"], bindings: { AUTH_MODE: "disabled" }, log: new Log(LogLevel.ERROR) });
  database = await native.getD1Database("DB");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    await database.batch(splitSql(readFileSync(new URL(name, migrations), "utf8")).map(sql => database.prepare(sql)));
  }
  await database.batch(splitSql(TEMPLATE_READ_FIXTURE_SQL).map(sql => database.prepare(sql)));
}, 30_000); // Existing genuine migration-fixture startup budget; cases retain normal deadlines.
afterAll(async () => { await native?.dispose(); });
const get = (path: string) => native.dispatchFetch(`https://app.test/api${path}`);
const invoke = (path: string, method: string, body: unknown) => native.dispatchFetch(`https://app.test/api${path}`, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
async function metadata() {
  const tables = [];
  for (const table of TEMPLATE_READ_FIXTURE_TABLES) tables.push([table, (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results]);
  return tables;
}
const fixtureIds = <T extends { id: string }>(rows: T[]) => rows.filter(row => row.id.startsWith("qa-"));

describe("Six template GETs through the actual current Worker entry", () => {
  it("preserves six owned routes, published latest/list ordering and current metadata while making no provider writes", async () => {
    const before = await metadata();
    const optionsResponse = await get("/template-families/options"); expect(optionsResponse.status).toBe(200);
    const options = await optionsResponse.json() as { families: Array<{ recipeFamilyId: string; name: string; latestVersion: number }> };
    expect(options.families.filter(row => row.recipeFamilyId.startsWith("qa-"))).toEqual([
      { recipeFamilyId: "qa-family-a", name: "QA Alpha etch", latestVersion: 2 }, { recipeFamilyId: "qa-family-b", name: "QA Beta mask", latestVersion: 1 }]);
    const familiesResponse = await get("/template-families?q=QA"); expect(familiesResponse.status).toBe(200);
    const families = await familiesResponse.json() as { families: ProcessTemplateFamilySummary[] };
    expect(families.families.map(row => [row.recipeFamilyId, row.latestVersion, row.versionCount])).toEqual([["qa-family-a", 2, 2], ["qa-family-b", 1, 1]]);
    const versionsResponse = await get("/template-families/qa-family-a/versions"); expect(versionsResponse.status).toBe(200);
    expect((await versionsResponse.json() as { versions: Array<{ id: string }> }).versions.map(row => row.id)).toEqual(["qa-a2", "qa-a1"]);
    const metrologyResponse = await get("/metrology-templates?q=QA"); expect(metrologyResponse.status).toBe(200);
    expect((await metrologyResponse.json() as { templates: MetrologyTemplateSummary[] }).templates.map(row => [row.id, row.hasDefaultContent])).toEqual([["qa-m1", true], ["qa-z1", false]]);
    const listResponse = await get("/templates"); expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as { templates: TemplateRecord[] };
    expect(fixtureIds(list.templates).map(row => row.id)).toEqual(["qa-m1", "qa-a2", "qa-a1", "qa-b1", "qa-z1"]);
    expect(list.templates.find(row => row.id === "qa-a2")).toMatchObject({ version: 2, stepCount: 2,
      initialStateImageKeys: ["qa/initial-a.png", "qa/initial-b.png"], initialSubstrateStep: { stepNumber: "0", name: "Substrate Stack" } });
    const detailResponse = await get("/templates/qa-a2"); expect(detailResponse.status).toBe(200);
    expect((await detailResponse.json() as { template: TemplateDetail }).template.steps.map(row => row.id)).toEqual(["qa-a2-step-first", "qa-a2-step-last"]);
    for (const response of [optionsResponse, familiesResponse, versionsResponse, metrologyResponse, listResponse])
      expect(response.headers.get("Server-Timing")).toMatch(/^d1;dur=\d+\.\d, serialize;dur=\d+\.\d$/);
    expect(detailResponse.headers.has("Server-Timing")).toBe(false);
    expect(await metadata()).toEqual(before);
    expect((await database.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").first())?.mode).toBe("legacy");
    const objects = await native.getR2Bucket("ASSETS"); expect((await objects.list()).objects).toEqual([]);
  });
  it("preserves older revision search, escaped wildcard metrology queries, directory defaults and pagination bounds", async () => {
    const before = await metadata();
    const older = await (await get("/template-families?q=legacy_wafer.xlsx")).json() as { families: ProcessTemplateFamilySummary[] };
    expect(older.families.map(row => [row.recipeFamilyId, row.latestVersion])).toEqual([["qa-family-a", 2]]);
    const page = await (await get("/template-families?q=QA&page=2&pageSize=1")).json() as { families: ProcessTemplateFamilySummary[]; pagination: unknown };
    expect(page.families.map(row => row.recipeFamilyId)).toEqual(["qa-family-b"]);
    expect(page.pagination).toEqual({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    const escaped = await (await get("/metrology-templates?q=%25_")).json() as { templates: MetrologyTemplateSummary[] };
    expect(escaped.templates.map(row => row.id)).toEqual(["qa-m1"]);
    const tools = await (await get("/metrology-templates?q=Dimension%203100")).json() as { templates: MetrologyTemplateSummary[] };
    expect(tools.templates.map(row => row.id)).toEqual(["qa-m1"]);
    const defaults = await (await get("/metrology-templates?q=QA&page=bad&pageSize=101")).json() as { pagination: unknown };
    expect(defaults.pagination).toMatchObject({ page: 1, pageSize: 100 });
    expect(await metadata()).toEqual(before);
  });
  it("preserves picker, archived/detail, ordered metadata attachment filtering and unchanged missing errors", async () => {
    const before = await metadata();
    const pickerResponse = await get("/templates?view=picker"); expect(pickerResponse.status).toBe(200);
    const picker = await pickerResponse.json() as { templates: TemplateRecord[] };
    expect(picker.templates.find(row => row.id === "qa-a2")).toMatchObject({ version: 2, initialStateImageKeys: [], initialSubstrateStep: null });
    const response = await get("/templates/qa-m1"); expect(response.status).toBe(200);
    const metrology = (await response.json() as { template: TemplateDetail }).template;
    expect(metrology).toMatchObject({ templateKind: "metrology", metrologyNotes: "Measured notes" });
    expect(metrology.referenceAttachments.map(row => [row.id, row.filename, row.byteSize, row.assetKey]))
      .toEqual([["qa-ref-a", "a.png", 4, "qa/initial-a.png"], ["qa-ref-b", "b.png", 8, "qa/initial-b.png"]]);
    expect((await (await get("/templates/qa-a3")).json() as { template: TemplateDetail }).template.archived).toBe(true);
    for (const id of ["qa-a4", "qa-a5", "missing-template"]) {
      const missing = await get(`/templates/${id}`); expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: "Template version not found" });
    }
    expect(await metadata()).toEqual(before); expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("keeps mature metrology creation and notes mutations separate while sharing their metadata read projection", async () => {
    const created = await invoke("/metrology-templates", "POST", { name: "New isolated metrology", toolName: "Real tool", parametersText: "", commentsText: "" });
    expect(created.status).toBe(201); const { id } = await created.json() as { id: string };
    const notes = await invoke(`/metrology-templates/${id}/notes`, "PATCH", { notes: "Private fixture notes" }); expect(notes.status).toBe(200);
    const before = (await database.prepare("SELECT * FROM template_versions WHERE id=?").bind(id).all()).results;
    const response = await get(`/templates/${id}`); expect(response.status).toBe(200);
    const detail = (await response.json() as { template: TemplateDetail }).template;
    expect(detail).toMatchObject({ id, name: "New isolated metrology", templateKind: "metrology", version: 1, metrologyNotes: "Private fixture notes" });
    expect(detail.steps).toEqual([expect.objectContaining({ name: "New isolated metrology", toolName: "Real tool", position: 0, parametersText: null, commentsText: null })]);
    expect((await database.prepare("SELECT * FROM template_versions WHERE id=?").bind(id).all()).results).toEqual(before);
    expect((await invoke("/metrology-templates", "POST", { name: "", toolName: "", parametersText: "", commentsText: "" })).status).toBe(400);
    const objects = await native.getR2Bucket("ASSETS"); expect((await objects.list()).objects).toEqual([]);
  });
});
