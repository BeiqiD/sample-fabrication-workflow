import { describe, expect, it } from "vitest";
import type { ReferenceTargetType } from "../shared/reference-types";
import {
  ReferenceSearchInputError,
  normalizeReferenceSearchInput,
  searchReferences,
} from "./references/search";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  database.exec(`
    UPDATE run_steps
    SET notes = 'Plasma etch pressure observation',
        tool_name = 'Oxford plasma tool',
        parameters_text = 'Pressure 7 mTorr',
        comments_text = 'Reference process note',
        deviation_note = 'No deviation'
    WHERE id = '${REFERENCE_FIXTURE_IDS.stepA}';

    UPDATE comment_submission_items
    SET description = 'Microscopy attachment evidence',
        external_url = 'https://example.test/reference-image'
    WHERE id = '${REFERENCE_FIXTURE_IDS.commentAttachment}';

    INSERT INTO run_step_comments
      (id, run_step_id, scope, body, actor_email, created_at, updated_at)
    VALUES
      ('reference-legacy-occurrence', '${REFERENCE_FIXTURE_IDS.stepB}', 'individual',
       'Reference legacy occurrence body', 'reference@example.com',
       '2026-08-01T04:30:00.000Z', '2026-08-01T04:30:00.000Z');
  `);
  const d1 = new SqliteD1Database(database);
  return { database, d1, db: d1 as unknown as D1Database };
}

function resultTypes(results: Array<{ target: { type: ReferenceTargetType } }>) {
  return new Set(results.map((result) => result.target.type));
}

describe("deterministic reference search", () => {
  it("normalizes and validates its domain input", () => {
    expect(normalizeReferenceSearchInput({
      query: "  REF-A  ",
      types: ["sample", "sample", "run"],
      sampleId: REFERENCE_FIXTURE_IDS.sampleA,
      from: "2026-08-01",
      to: "2026-08-02T00:00:00.000Z",
      limit: 5,
    })).toMatchObject({
      query: "REF-A",
      normalizedQuery: "ref-a",
      tokens: ["ref-a"],
      types: ["sample", "run"],
      sampleId: REFERENCE_FIXTURE_IDS.sampleA,
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      limit: 5,
    });

    const invalidInputs: unknown[] = [
      null,
      {},
      { query: "" },
      { query: "x".repeat(201) },
      { query: "reference", types: ["unknown"] },
      { query: "reference", types: null },
      { query: "reference", sampleId: " sample " },
      { query: "reference", from: "not-a-date" },
      { query: "reference", from: "2026-08-02", to: "2026-08-01" },
      { query: "reference", limit: 0 },
      { query: "reference", limit: 51 },
    ];
    for (const input of invalidInputs) {
      expect(() => normalizeReferenceSearchInput(input))
        .toThrow(ReferenceSearchInputError);
    }
  });

  it("covers all nine target types without writing the registry or leaking locators", async () => {
    const { database, db } = fixture();
    const response = await searchReferences(db, { query: "Reference", limit: 50 });

    expect(resultTypes(response.results)).toEqual(new Set<ReferenceTargetType>([
      "sample",
      "run",
      "run_step",
      "comment",
      "comment_occurrence",
      "comment_attachment",
      "execution_image",
      "metrology_reference",
      "recipe_revision",
    ]));
    expect(response.results.every((result) => result.resolution.resolution === "resolved")).toBe(true);
    expect(response.results.some((result) => result.target.id === "reference-legacy-occurrence")).toBe(true);
    expect(response.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.commentOccurrenceA)).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reference_targets").get()).toEqual({ count: 0 });

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("reference/private/");
    expect(serialized).not.toContain("r2_key");
    expect(serialized).not.toContain("object_key");
    database.close();
  });

  it("uses explainable ranking tiers and deterministic tie-breaking", async () => {
    const { database, db } = fixture();

    const exactId = await searchReferences(db, {
      query: REFERENCE_FIXTURE_IDS.sampleA,
      types: ["sample"],
    });
    expect(exactId.results[0]).toMatchObject({
      target: { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
      match: { tier: "exact_id" },
    });

    const exactPrimary = await searchReferences(db, {
      query: "Reference sample A",
      types: ["sample"],
    });
    expect(exactPrimary.results[0]).toMatchObject({
      target: { id: REFERENCE_FIXTURE_IDS.sampleA },
      match: { tier: "exact_primary" },
    });

    const prefixPrimary = await searchReferences(db, {
      query: "Reference sam",
      types: ["sample"],
    });
    expect(prefixPrimary.results.map((result) => result.target.id)).toEqual([
      REFERENCE_FIXTURE_IDS.sampleA,
      REFERENCE_FIXTURE_IDS.sampleB,
    ]);
    expect(prefixPrimary.results.every((result) => result.match.tier === "prefix_primary")).toBe(true);

    const content = await searchReferences(db, {
      query: "First fixture",
      types: ["sample"],
    });
    expect(content.results[0]).toMatchObject({
      target: { id: REFERENCE_FIXTURE_IDS.sampleA },
      match: { tier: "content" },
    });

    const metadata = await searchReferences(db, {
      query: "Box A",
      types: ["sample"],
    });
    expect(metadata.results[0]).toMatchObject({
      target: { id: REFERENCE_FIXTURE_IDS.sampleA },
      match: { tier: "metadata" },
    });
    database.close();
  });

  it("prefers the canonical logical Comment and exposes occurrences only by exact ID or legacy body", async () => {
    const { database, db } = fixture();

    const bodySearch = await searchReferences(db, {
      query: "Shared reference Comment body",
      types: ["comment", "comment_occurrence"],
    });
    expect(bodySearch.results.map((result) => result.target)).toEqual([
      { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
    ]);

    const occurrenceId = await searchReferences(db, {
      query: REFERENCE_FIXTURE_IDS.commentOccurrenceA,
      types: ["comment_occurrence"],
    });
    expect(occurrenceId.results[0]).toMatchObject({
      target: {
        type: "comment_occurrence",
        id: REFERENCE_FIXTURE_IDS.commentOccurrenceA,
      },
      match: { tier: "exact_id" },
    });

    const legacy = await searchReferences(db, {
      query: "legacy occurrence",
      types: ["comment_occurrence"],
    });
    expect(legacy.results[0].target).toEqual({
      type: "comment_occurrence",
      id: "reference-legacy-occurrence",
    });
    database.close();
  });

  it("applies type, Sample, time, deletion, and archive policies", async () => {
    const { database, db } = fixture();

    const sampleFiltered = await searchReferences(db, {
      query: "Reference",
      sampleId: REFERENCE_FIXTURE_IDS.sampleB,
      limit: 50,
    });
    expect(sampleFiltered.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.sampleB)).toBe(true);
    expect(sampleFiltered.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.runB)).toBe(true);
    expect(sampleFiltered.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.stepB)).toBe(true);
    expect(sampleFiltered.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.comment)).toBe(true);
    expect(sampleFiltered.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.commentAttachment)).toBe(true);
    expect(sampleFiltered.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.sampleA)).toBe(false);
    expect(sampleFiltered.results.some((result) => result.target.type === "recipe_revision")).toBe(false);
    expect(sampleFiltered.results.some((result) => result.target.type === "metrology_reference")).toBe(false);

    const typeFiltered = await searchReferences(db, {
      query: "execution",
      types: ["execution_image"],
    });
    expect(typeFiltered.results.map((result) => result.target)).toEqual([
      { type: "execution_image", id: REFERENCE_FIXTURE_IDS.executionImage },
    ]);

    const timeFiltered = await searchReferences(db, {
      query: "Reference",
      from: "2026-08-01T04:45:00.000Z",
      limit: 50,
    });
    expect(resultTypes(timeFiltered.results)).toEqual(new Set<ReferenceTargetType>([
      "execution_image",
      "metrology_reference",
    ]));

    database.exec(`
      UPDATE template_versions
      SET archived_at = '2026-08-08T00:00:00.000Z'
      WHERE id IN ('${REFERENCE_FIXTURE_IDS.recipeRevision}', '${REFERENCE_FIXTURE_IDS.metrologyRevision}');
    `);
    const archived = await searchReferences(db, {
      query: "Reference",
      types: ["recipe_revision", "metrology_reference"],
      limit: 50,
    });
    expect(archived.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.recipeRevision)).toBe(true);
    expect(archived.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.metrologyReference)).toBe(true);

    database.exec(`
      UPDATE samples SET deleted_at = '2026-08-08T01:00:00.000Z'
      WHERE id = '${REFERENCE_FIXTURE_IDS.sampleA}';
    `);
    const afterSampleDeletion = await searchReferences(db, { query: "Reference", limit: 50 });
    expect(afterSampleDeletion.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.sampleA)).toBe(false);
    expect(afterSampleDeletion.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.runA)).toBe(false);
    expect(afterSampleDeletion.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.stepA)).toBe(false);
    expect(afterSampleDeletion.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.executionImage)).toBe(false);
    expect(afterSampleDeletion.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.comment)).toBe(true);
    expect(afterSampleDeletion.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.commentAttachment)).toBe(true);

    database.exec(`
      UPDATE template_versions SET deleted_at = '2026-08-08T02:00:00.000Z'
      WHERE id = '${REFERENCE_FIXTURE_IDS.metrologyRevision}';
    `);
    const afterRecipeDeletion = await searchReferences(db, {
      query: "Reference",
      types: ["recipe_revision", "metrology_reference"],
      limit: 50,
    });
    expect(afterRecipeDeletion.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.metrologyRevision)).toBe(false);
    expect(afterRecipeDeletion.results.some((result) => result.target.id === REFERENCE_FIXTURE_IDS.metrologyReference)).toBe(false);
    database.close();
  });

  it("keeps query count independent of result count and reports bounded truncation", async () => {
    const { database, d1, db } = fixture();
    const insert = database.prepare(`
      INSERT INTO samples
        (id, code, title, description, status, location, pinned, created_at, updated_at)
      VALUES (?, ?, 'Bulk search sample', 'Bulk deterministic search fixture',
              'stored', 'Bulk box', 0,
              '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z')
    `);
    for (let index = 0; index < 80; index += 1) {
      insert.run(`bulk-search-${index}`, `BULK-${String(index).padStart(3, "0")}`);
    }

    d1.resetQueryCount();
    const one = await searchReferences(db, {
      query: "Bulk search",
      types: ["sample"],
      limit: 1,
    });
    const oneQueryCount = d1.queryCount;

    d1.resetQueryCount();
    const fifty = await searchReferences(db, {
      query: "Bulk search",
      types: ["sample"],
      limit: 50,
    });
    const fiftyQueryCount = d1.queryCount;

    expect(one.results).toHaveLength(1);
    expect(fifty.results).toHaveLength(50);
    expect(one.truncated).toBe(true);
    expect(fifty.truncated).toBe(true);
    expect(oneQueryCount).toBe(fiftyQueryCount);
    expect(oneQueryCount).toBeLessThanOrEqual(3);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reference_targets").get()).toEqual({ count: 0 });
    database.close();
  });
});
