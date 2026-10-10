import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ReadSqlDatabase } from "../worker/runtime/read-sql";
import { configurationSqlInteger } from "../worker/runtime/configuration-sql";
import { readSqlFileAuthorityMode, FileAuthorityUnavailableError } from "../worker/files/authority-mode";
import { templateReadFamilyOptionRow, templateReadReferenceRow } from "../worker/process-definition/read-decoding";
import { createTemplateReadService, templateFamilyOptions, templateFamilyDirectory, templateFamilyVersions,
  metrologyTemplateDirectory, templateList, templateDetail } from "../worker/process-definition/read-service";
import { createTemplateReadSurface } from "../worker/process-definition/read-surface";
import { TEMPLATE_READ_FIXTURE_SQL, TEMPLATE_READ_FIXTURE_TABLES } from "../test/template-read-fixture";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "./installation-catalog";
import { installReviewedSqliteCatalog } from "./migrations";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";
import { asStorageConfigurationSqlDatabase } from "./storage-configuration-sql";

// Actual installed current23/native SQL library fixtures. This deliberately is
// not a mounted Node product/authentication/physical writer-lease witness.
const actor = "local-account:template_read_fixture";
let directory = "", pristine = "", sequence = 0;
const cores: SqliteCapability[] = [], natives: DatabaseSync[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "rt1-template-reads-")); pristine = join(directory, "pristine.sqlite");
  console.info("Private template read fixtures:", directory);
  const native = new DatabaseSync(pristine, { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    native.exec("PRAGMA journal_mode=WAL");
    expect(installReviewedSqliteCatalog(native, CURRENT_NODE_INSTALLATION_CATALOG).checkpointId).toBe("portable-runtime/v25");
    expect(native.prepare("SELECT COUNT(*) n FROM node_migrations").get()?.n).toBe(23);
  } finally { native.close(); }
});
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
  for (const native of natives.splice(0)) if (native.isOpen) native.close();
  // Retain every synthetic fixture; no workspace state is copied or opened.
});
function fixture() {
  const filename = join(directory, `${++sequence}.sqlite`); copyFileSync(pristine, filename);
  const native = new DatabaseSync(filename, { allowExtension: false, enableForeignKeyConstraints: true });
  const core = createSqliteCapability(native); cores.push(core); native.exec(TEMPLATE_READ_FIXTURE_SQL);
  const sql: ReadSqlDatabase = asStorageConfigurationSqlDatabase(core);
  return { filename, native, core, sql, authority: () => sql };
}
function metadata(native: DatabaseSync) {
  return TEMPLATE_READ_FIXTURE_TABLES.map(table => [table, native.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
}
const fixtureIds = <T extends { id: string }>(rows: T[]) => rows.filter(row => row.id.startsWith("qa-"));

// Six finite scopes; no arbitrary concurrency/provider responses or guard bypass.
describe("Shared template reads over genuine installed Node SQL", () => {
  it("retains latest published family ordering, older-version search, pagination and version serialization", async () => {
    const f = fixture(), before = metadata(f.native);
    expect((await templateFamilyOptions(f.sql)).payload.families.filter(row => row.recipeFamilyId.startsWith("qa-")))
      .toEqual([{ recipeFamilyId: "qa-family-a", name: "QA Alpha etch", latestVersion: 2 }, { recipeFamilyId: "qa-family-b", name: "QA Beta mask", latestVersion: 1 }]);
    const page = (await templateFamilyDirectory(f.sql, { query: "QA", page: "2", pageSize: "1" })).payload;
    expect(page.families.map(row => row.recipeFamilyId)).toEqual(["qa-family-b"]);
    expect(page.pagination).toEqual({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    const searched = (await templateFamilyDirectory(f.sql, { query: "legacy_wafer.xlsx" })).payload;
    expect(searched.families).toEqual([expect.objectContaining({ recipeFamilyId: "qa-family-a", latestVersion: 2, versionCount: 2,
      latest: expect.objectContaining({ stepCount: 2, hasInitialSubstrateStep: true, initialStateImageCount: 2 }) })]);
    expect((await templateFamilyVersions(f.sql, "qa-family-a", "")).payload.versions.map(row => row.id)).toEqual(["qa-a2", "qa-a1"]);
    expect((await templateFamilyVersions(f.sql, "missing", "")).payload).toEqual({ versions: [] });
    expect((await templateFamilyDirectory(f.sql, { query: "QA", page: "bad", pageSize: "0" })).payload.pagination).toMatchObject({ page: 1, pageSize: 20 });
    expect(metadata(f.native)).toEqual(before);
  });
  it("retains metrology-only search, literal wildcard escaping, whitespace default-content policy and pagination", async () => {
    const f = fixture(), before = metadata(f.native);
    const page = (await metrologyTemplateDirectory(f.sql, { query: "QA", page: "1", pageSize: "1" })).payload;
    expect(page.templates).toEqual([{ id: "qa-m1", name: "QA AFM %_", toolName: "Dimension 3100", hasDefaultContent: true, createdAt: "2026-08-01T00:00:00.000Z" }]);
    expect(page.pagination).toEqual({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
    const escaped = (await metrologyTemplateDirectory(f.sql, { query: "%_" })).payload;
    expect(escaped.templates.map(row => row.id)).toEqual(["qa-m1"]);
    expect((await metrologyTemplateDirectory(f.sql, { query: "Flatten order" })).payload.templates.map(row => row.id)).toEqual(["qa-m1"]);
    expect((await metrologyTemplateDirectory(f.sql, { query: "QA Zulu" })).payload.templates[0].hasDefaultContent).toBe(false);
    expect((await metrologyTemplateDirectory(f.sql, { query: "QA", pageSize: "101" })).payload.pagination.pageSize).toBe(100);
    expect(metadata(f.native)).toEqual(before);
  });
  it("retains full and picker list projections while skipping authority/assets for the picker", async () => {
    const f = fixture(), before = metadata(f.native); let authorityCalls = 0;
    const full = await templateList(f.sql, false, () => { authorityCalls++; return f.sql; });
    expect(fixtureIds(full.payload.templates).map(row => row.id)).toEqual(["qa-m1", "qa-a2", "qa-a1", "qa-b1", "qa-z1"]);
    expect(full.payload.templates.find(row => row.id === "qa-a2")).toMatchObject({ version: 2, stepCount: 2,
      initialStateImageKeys: ["qa/initial-a.png", "qa/initial-b.png"], initialSubstrateStep: { stepNumber: "0", name: "Substrate Stack" } });
    expect(full.serverTiming).toMatch(/^d1;dur=\d+\.\d, serialize;dur=\d+\.\d$/); expect(authorityCalls).toBe(1);
    const picker = await templateList(f.sql, true, () => { throw new Error("Picker must never select authority"); });
    expect(picker.payload.templates.find(row => row.id === "qa-a2")).toMatchObject({ version: 2, initialStateImageKeys: [], initialSubstrateStep: null });
    expect(metadata(f.native)).toEqual(before); expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("retains process and metrology detail order, publication filters, archived visibility and exact missing errors", async () => {
    const f = fixture(), before = metadata(f.native); let primarySelections = 0;
    const detail = await templateDetail(f.sql, "qa-a2", () => { primarySelections++; return f.sql; });
    expect(detail.payload.template.steps.map(row => [row.id, row.position, row.sourceRow]))
      .toEqual([["qa-a2-step-first", 0, 5], ["qa-a2-step-last", 1, 12]]);
    expect(detail.payload.template.steps[0].imageKeys).toEqual(["qa/initial-b.png"]);
    expect(detail.payload.template.initialStateImageKeys).toEqual(["qa/initial-a.png", "qa/initial-b.png"]);
    expect(primarySelections).toBe(3); expect(detail).not.toHaveProperty("serverTiming");
    const metrology = (await templateDetail(f.sql, "qa-m1", f.authority)).payload.template;
    expect(metrology).toMatchObject({ templateKind: "metrology", metrologyNotes: "Measured notes", referenceAttachments: [
      { id: "qa-ref-a", filename: "a.png", mimeType: "image/png", byteSize: 4, assetKey: "qa/initial-a.png", createdAt: "2026-08-02T00:00:00.000Z" },
      { id: "qa-ref-b", filename: "b.png", mimeType: "image/png", byteSize: 8, assetKey: "qa/initial-b.png", createdAt: "2026-08-01T00:00:00.000Z" }] });
    expect((await templateDetail(f.sql, "qa-a3", f.authority)).payload.template.archived).toBe(true);
    for (const id of ["qa-a4", "qa-a5", "missing"]) await expect(templateDetail(f.sql, id, f.authority)).rejects.toMatchObject({ status: 404, message: "Template version not found" });
    expect(metadata(f.native)).toEqual(before);
  });
  it("retains exact SQL cells, checks named consumed integers and fails closed absent/denied authority without activating it", async () => {
    const f = fixture();
    const cells = await f.sql.prepare("SELECT 9007199254740993 AS unconsumed, 9007199254740991 AS version, 'f' AS recipe_family_id, 'Name' AS name, x'00ff' AS bytes").first();
    expect(cells!.unconsumed).toBe(9007199254740993n); expect(cells!.bytes).toEqual(new Uint8Array([0, 255]));
    expect(templateReadFamilyOptionRow(cells!).version).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => templateReadFamilyOptionRow({ ...cells!, version: cells!.unconsumed })).toThrow(/template.version/);
    expect(() => configurationSqlInteger(cells!.unconsumed, "templateStep.sourceRow", Number.MIN_SAFE_INTEGER)).toThrow(/templateStep.sourceRow/);
    expect(() => templateReadReferenceRow({ asset_id: "a", r2_key: null, file_id: "f", id: "r", display_name: "file", mime_type: "image/png",
      byte_size: 9007199254740993n, created_at: "now" })).toThrow(/metrologyReference.byteSize/);
    expect((await f.sql.prepare("SELECT ? AS n").bind(1n).bind(2n).first())?.n).toBe(2n);
    expect(await readSqlFileAuthorityMode(f.authority)).toBe("legacy");
    const actual = f.native as DatabaseSync & { setAuthorizer(callback: ((action: number, arg1: string | null, arg2: string | null) => number) | null): void };
    const nativeConstants = constants as unknown as Record<string, number>;
    actual.setAuthorizer((action, table, column) => action === nativeConstants.SQLITE_READ && table === "file_authority_control" && column === "mode"
      ? nativeConstants.SQLITE_DENY : nativeConstants.SQLITE_OK);
    try { await expect(readSqlFileAuthorityMode(f.authority)).rejects.toBeInstanceOf(FileAuthorityUnavailableError); }
    finally { actual.setAuthorizer(null); }
    const old = new DatabaseSync(join(directory, `${++sequence}-contracted.sqlite`), { allowExtension: false }); natives.push(old);
    const oldCore = createSqliteCapability(old); cores.push(oldCore); const oldSql = asStorageConfigurationSqlDatabase(oldCore);
    expect(await readSqlFileAuthorityMode(() => oldSql)).toBe("legacy");
    f.core.close(); await expect(readSqlFileAuthorityMode(f.authority)).rejects.toBeInstanceOf(FileAuthorityUnavailableError);
  });
  it("owns exactly six method-scoped original Requests and rejects before/read-after fixture admission without provider or CRUD paths", async () => {
    const f = fixture(), before = metadata(f.native), selected: Request[] = [], admitted: string[] = []; let enabled = true;
    const surface = createTemplateReadSurface<Record<string, never>>((request) => {
      selected.push(request);
      return createTemplateReadService({ database: () => f.sql, authorityDatabase: f.authority,
        admit: async currentActor => { admitted.push(currentActor); if (!enabled) throw new HTTPException(403, { message: "Fixture admission unavailable" }); } });
    });
    const app = new Hono<{ Bindings: Record<string, never>; Variables: { userEmail: string } }>();
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); }); app.route("/api", surface);
    const paths = ["/template-families/options", "/template-families?q=QA", "/template-families/qa-family-a/versions",
      "/metrology-templates?q=QA", "/templates?view=picker", "/templates/qa-a2"];
    for (const path of paths) {
      const request = new Request(`http://127.0.0.1/api${path}`), response = await app.fetch(request, {});
      expect(response.status).toBe(200); expect(selected.at(-1)).toBe(request);
      expect(response.headers.has("Server-Timing")).toBe(!path.startsWith("/templates/"));
    }
    expect(admitted).toEqual(Array.from({ length: 12 }, () => actor));
    enabled = false; expect((await app.request("/api/templates/qa-a2", {}, {})).status).toBe(403);
    enabled = true;
    const actual = f.native as DatabaseSync & { setAuthorizer(callback: ((action: number, arg1: string | null) => number) | null): void };
    const nativeConstants = constants as unknown as Record<string, number>;
    actual.setAuthorizer((action, table) => { if (action === nativeConstants.SQLITE_READ && table === "template_versions") enabled = false; return nativeConstants.SQLITE_OK; });
    try { expect((await app.request("/api/template-families/options", {}, {})).status).toBe(403); }
    finally { actual.setAuthorizer(null); enabled = true; }
    for (const path of ["/metrology-templates/qa-m1/reference-upload-requests/q", "/templates/qa-a2/file"])
      expect((await app.request(`/api${path}`, {}, {})).status).toBe(404);
    expect((await app.request("/api/metrology-templates", { method: "POST", body: "{}" }, {})).status).toBe(404);
    expect(metadata(f.native)).toEqual(before);
  });
});
