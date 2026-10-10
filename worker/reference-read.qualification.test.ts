import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeReferenceRouteId } from "../shared/reference-destinations";
import type { ReferenceTarget, ResolveReferencesResponse } from "../shared/reference-types";
import type { ListReferenceChildrenResponse } from "../shared/reference-children";
import type { SearchReferencesResponse } from "../shared/reference-search";

// SOURCE-ONLY qualification candidate, UNEXECUTED. Bundle the actual Worker
// entry and use genuine Miniflare D1/R2 bindings and the full current catalog.
// No test-adapter/default schema, fake Env, JWT success or provider-byte claim.
let native: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let script = "";
function actualWorker(authMode: "disabled" | "invalid") {
  return new Miniflare({ modules: true, script, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], r2Buckets: ["ASSETS"], bindings: { AUTH_MODE: authMode }, log: new Log(LogLevel.ERROR) });
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", write: false });
  script = bundle.outputFiles[0].text; native = actualWorker("disabled");
  database = await native.getD1Database("DB");
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
  expect(migrations).toHaveLength(23); expect(migrations.at(-1)).toBe("0023_portable_local_identity.sql");
  for (const name of migrations) {
    await database.batch(splitSql(readFileSync(new URL(name, directory), "utf8")).map(sql => database.prepare(sql)));
  }
  await database.batch(splitSql(readFileSync(new URL("./fixtures/reference-graph.sql", import.meta.url), "utf8"))
    .map(sql => database.prepare(sql)));
  // All graph assets are ready before links are installed; the genuine fixture
  // needs no File-authority transition or publication-guard exceptions.
  await database.batch([
    database.prepare(`INSERT INTO reference_targets
      (id,target_type,target_id,first_registered_at,last_validated_at,last_known_contexts_json)
      VALUES('qualification-registry-missing','sample','registered-but-missing',?,?, '[]')`)
      .bind("2026-08-08T00:00:00.000Z", "2026-08-08T00:00:00.000Z"),
    database.prepare(`INSERT INTO reference_targets
      (id,target_type,target_id,first_registered_at,last_validated_at,tombstoned_at,last_known_contexts_json)
      VALUES('qualification-registry-tombstone','sample','tombstoned-sample',?,?,?,?)`)
      .bind("2026-08-08T00:00:00.000Z", "2026-08-08T00:00:00.000Z", "2026-08-08T01:00:00.000Z",
        JSON.stringify([{ segments: [{ type: "sample", id: "tombstoned-sample", label: "Old sample", deletedAt: null, archivedAt: null }] }])),
    database.prepare(`INSERT INTO samples(id,code,title,created_at,updated_at,deleted_at)
      VALUES('qualification-deleted-sample','QA-DELETED','Deleted parent',?,?,?)`)
      .bind("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
    database.prepare(`INSERT INTO samples(id,code,title,description,created_at,updated_at)
      VALUES('qualification-literal-sample','QA-LITERAL','Literal matcher',?,?,?)`)
      .bind("literal 100%_ready\\path", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
    ...Array.from({ length: 80 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return database.prepare(`INSERT INTO samples(id,code,title,description,created_at,updated_at)
        VALUES(?,?,'Qualification bulk sample','Bounded source scan',?,?)`)
        .bind(`qualification-bulk-${suffix}`, `QA-BULK-${suffix}`, "2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
    }),
  ]);
  expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}, 30_000);
afterAll(async () => { await native?.dispose(); });

const paths = ["/references/resolve", "/references/children", "/references/search"] as const;
const post = (path: string, input: unknown, headers: Record<string, string> = {}) => native.dispatchFetch(`https://app.test/api${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input),
});
async function payload<T>(path: string, input: unknown): Promise<T> {
  const response = await post(path, input); expect(response.status).toBe(200); return await response.json() as T;
}
const ownedTables = ["step_definitions", "recipe_families", "template_versions", "template_steps", "samples", "runs", "run_steps",
  "assets", "comment_submissions", "comment_submission_targets", "run_step_comments", "comment_submission_items",
  "run_step_assets", "metrology_template_references", "reference_targets", "file_authority_control"] as const;
async function metadata() {
  const rows = [];
  for (const table of ownedTables) rows.push([table, (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results]);
  return rows;
}
async function unchanged(before: Awaited<ReturnType<typeof metadata>>) {
  expect(await metadata()).toEqual(before);
  expect((await database.prepare("SELECT COUNT(*) n FROM reference_targets").first())?.n).toBe(2);
  expect((await database.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").first())?.mode).toBe("legacy");
  expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect((await (await native.getR2Bucket("ASSETS")).list()).objects).toEqual([]);
}
const childTargets = (response: ListReferenceChildrenResponse) => response.children.map(child => child.target);

describe("Three metadata POSTs through the genuine current Worker entry: four finite scopes", () => {
  it("resolves all nine types, duplicate input and missing/tombstoned registry states without registration or locator exposure", async () => {
    const before = await metadata();
    const nine: ReferenceTarget[] = [
      { type: "sample", id: "reference-sample-a" }, { type: "run", id: "reference-run-a" },
      { type: "run_step", id: "reference-step-a" }, { type: "comment", id: "reference-comment" },
      { type: "comment_occurrence", id: "reference-comment-occurrence-a" },
      { type: "comment_attachment", id: "reference-comment-attachment" },
      { type: "execution_image", id: "reference-execution-image" },
      { type: "metrology_reference", id: "reference-metrology-reference" },
      { type: "recipe_revision", id: "reference-process-template" },
    ];
    const targets = [...nine, nine[0], { type: "sample", id: "never-registered" },
      { type: "sample", id: "registered-but-missing" }, { type: "sample", id: "tombstoned-sample" }];
    const result = await payload<ResolveReferencesResponse>(paths[0], { targets });
    expect(result.results.map(row => row.target)).toEqual(targets);
    expect(result.results.map(row => row.resolution)).toEqual([...nine.map(() => "resolved"), "resolved", "not_found", "inconsistent", "tombstoned"]);
    expect(result.results[1].source?.title).toBe("Reference process v3");
    expect(result.results[3].contexts.map(context => context.segments[0].label))
      .toEqual(["REF-A · Reference sample A", "REF-B · Reference sample B"]);
    expect(result.results[5].contexts).toEqual(result.results[3].contexts);
    expect(result.results[7].contexts[0].segments[0]).toMatchObject({ type: "recipe_revision", id: "reference-metrology-template" });
    expect(result.results.at(-1)).toMatchObject({ source: null, contexts: [{ segments: [{ label: "Old sample" }] }] });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["reference/private/", "r2_key", "object_key", "reference-comment-asset"]) expect(serialized).not.toContain(forbidden);
    await unchanged(before);
  });

  it("preserves direct-child ordering, bounded limits and ineligible-parent behavior without registering children", async () => {
    const before = await metadata();
    const child = (type: ReferenceTarget["type"], id: string, limit?: number) =>
      payload<ListReferenceChildrenResponse>(paths[1], { parent: { type, id }, ...(limit === undefined ? {} : { limit }) });
    expect(childTargets(await child("sample", "reference-sample-a"))).toEqual([{ type: "run", id: "reference-run-a" }]);
    expect(childTargets(await child("run", "reference-run-a"))).toEqual([{ type: "run_step", id: "reference-step-a" }]);
    expect(childTargets(await child("run_step", "reference-step-a"))).toEqual([
      { type: "comment", id: "reference-comment" }, { type: "execution_image", id: "reference-execution-image" }]);
    const comment = await child("comment", "reference-comment");
    expect(childTargets(comment)).toEqual([{ type: "comment_occurrence", id: "reference-comment-occurrence-a" },
      { type: "comment_occurrence", id: "reference-comment-occurrence-b" }, { type: "comment_attachment", id: "reference-comment-attachment" }]);
    expect(comment).toMatchObject({ parentEligible: true, truncated: false });
    const bounded = await child("comment", "reference-comment", 1);
    expect(childTargets(bounded)).toEqual([{ type: "comment_occurrence", id: "reference-comment-occurrence-a" }]);
    expect(bounded.truncated).toBe(true);
    expect(childTargets(await child("comment_occurrence", "reference-comment-occurrence-a")))
      .toEqual([{ type: "comment_attachment", id: "reference-comment-attachment" }]);
    expect(childTargets(await child("recipe_revision", "reference-metrology-template")))
      .toEqual([{ type: "metrology_reference", id: "reference-metrology-reference" }]);
    expect(await child("execution_image", "reference-execution-image")).toMatchObject({ parentEligible: true, children: [], truncated: false });
    for (const [id, resolution] of [["qualification-deleted-sample", "resolved"], ["never-registered", "not_found"], ["tombstoned-sample", "tombstoned"]]) {
      expect(await child("sample", id)).toMatchObject({ parent: { resolution }, parentEligible: false, children: [], truncated: false });
    }
    await unchanged(before);
  });

  it("preserves literal matching, Sample and explicit-time filters, deterministic ranking and bounded truncation", async () => {
    const before = await metadata();
    const search = (input: unknown) => payload<SearchReferencesResponse>(paths[2], input);
    const literal = await search({ query: "%_ready\\path", types: ["sample"] });
    expect(literal.results.map(row => row.target.id)).toEqual(["qualification-literal-sample"]);
    expect(literal.results[0].match).toEqual({ tier: "content", matchedAt: "2026-08-03T00:00:00.000Z" });
    expect((await search({ query: "%_ready\\path", types: ["sample"], to: "2026-08-02" })).results).toEqual([]);
    expect((await search({ query: "%_ready\\path", types: ["sample"], from: "2026-08-03", to: "2026-08-03T02:00:00+02:00" })).results)
      .toEqual(literal.results);
    // Valid local-calendar bounds may normalize across year 1/9999 in UTC.
    // Preserve one-pass validation and the mature SQL TEXT comparison: an
    // expanded positive-year ISO string starts with '+', before '2026'.
    expect((await search({ query: "%_ready\\path", types: ["sample"], from: "0001-01-01T00:00:00+01:00" })).results)
      .toEqual(literal.results);
    expect((await search({ query: "%_ready\\path", types: ["sample"], to: "9999-12-31T23:59:59-01:00" })).results).toEqual([]);
    const sample = await search({ query: "Reference", types: ["sample"], sampleId: "reference-sample-b" });
    expect(sample.results.map(row => row.target.id)).toEqual(["reference-sample-b"]);
    const common = await search({ query: "Shared reference Comment body", types: ["comment"], sampleId: "reference-sample-b" });
    expect(common.results.map(row => row.target.id)).toEqual(["reference-comment"]);
    expect(common.results[0].resolution.contexts).toHaveLength(2);
    expect((await search({ query: "REF-A", types: ["sample", "run", "run_step"], limit: 10 })).results[0])
      .toMatchObject({ target: { type: "sample", id: "reference-sample-a" }, match: { tier: "exact_primary" } });
    const one = await search({ query: "Qualification bulk sample", types: ["sample"], limit: 1 });
    const fifty = await search({ query: "Qualification bulk sample", types: ["sample"], limit: 50 });
    expect(one.results.map(row => row.target.id)).toEqual(["qualification-bulk-000"]);
    expect(fifty.results.map(row => row.target.id)).toEqual(Array.from({ length: 50 }, (_, index) => `qualification-bulk-${String(index).padStart(3, "0")}`));
    expect(one.truncated).toBe(true); expect(fifty.truncated).toBe(true);
    await unchanged(before);
  });

  it("preserves JSON/input/auth errors and method/media ownership while the real R2 binding stays empty", async () => {
    const before = await metadata();
    const valid = [{ targets: [{ type: "sample", id: "reference-sample-a" }] },
      { parent: { type: "sample", id: "reference-sample-a" } }, { query: "REF-A" }];
    for (const [index, path] of paths.entries()) {
      const malformed = await native.dispatchFetch(`https://app.test/api${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{",
      });
      expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ error: "A valid JSON request body is required" });
      const crossOrigin = await post(path, valid[index], { origin: "https://other.test" });
      expect(crossOrigin.status).toBe(403); expect(await crossOrigin.json()).toEqual({ error: "Cross-origin writes are not allowed" });
      for (const method of ["GET", "PUT"]) expect((await native.dispatchFetch(`https://app.test/api${path}`, { method })).status).toBe(404);
    }
    for (const input of [{}, { targets: [] }, { targets: [{ type: "unknown", id: "one" }] },
      { targets: [{ type: "sample", id: " padded " }] }, { targets: Array.from({ length: 201 }, (_, index) => ({ type: "sample", id: `sample-${index}` })) }])
      expect((await post(paths[0], input)).status).toBe(400);
    for (const input of [{}, { parent: { type: "unknown", id: "one" } }, { parent: { type: "sample", id: " padded " } },
      { parent: { type: "sample", id: "reference-sample-a" }, limit: 101 }]) expect((await post(paths[1], input)).status).toBe(400);
    for (const input of [{}, { query: "" }, { query: "x", types: ["unknown"] }, { query: "x", sampleId: " padded " },
      { query: "x", from: "2026-02-30" }, { query: "x", limit: 51 }]) expect((await post(paths[2], input)).status).toBe(400);
    const rejected = actualWorker("invalid");
    try {
      for (const [index, path] of paths.entries()) {
        const response = await rejected.dispatchFetch(`https://app.test/api${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid[index]),
        });
        expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
      }
    } finally { await rejected.dispose(); }
    // Missing metadata and invalid media context stop before provider opening.
    // These assertions do not qualify successful media delivery or File reads.
    const missingImage = `/references/media/execution_image/${encodeReferenceRouteId("missing-execution-image")}`;
    expect((await native.dispatchFetch(`https://app.test/api${missingImage}`)).status).toBe(400);
    expect((await native.dispatchFetch(`https://app.test/api${missingImage}?step=reference-step-a`)).status).toBe(404);
    expect((await post(missingImage, {})).status).toBe(404);
    expect((await native.dispatchFetch("https://app.test/api/assets/missing-reference-media")).status).toBe(404);
    expect((await native.dispatchFetch("https://app.test/api/file-assets/missing-reference-asset")).status).toBe(404);
    await unchanged(before);
  });
});
