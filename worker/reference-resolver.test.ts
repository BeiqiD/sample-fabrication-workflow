import { describe, expect, it } from "vitest";
import type { ReferenceTarget } from "../shared/reference-types";
import { resolveReferences } from "./references/resolver";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  const d1 = new SqliteD1Database(database);
  return { database, d1, db: d1 as unknown as D1Database };
}

describe("batch reference resolver", () => {
  it("resolves every v1 target type without exposing physical locators", async () => {
    const { database, db } = fixture();
    const ids = REFERENCE_FIXTURE_IDS;
    const targets: ReferenceTarget[] = [
      { type: "sample", id: ids.sampleA },
      { type: "run", id: ids.runA },
      { type: "run_step", id: ids.stepA },
      { type: "comment", id: ids.comment },
      { type: "comment_occurrence", id: ids.commentOccurrenceA },
      { type: "comment_attachment", id: ids.commentAttachment },
      { type: "execution_image", id: ids.executionImage },
      { type: "metrology_reference", id: ids.metrologyReference },
      { type: "recipe_revision", id: ids.recipeRevision },
    ];
    const results = await resolveReferences(db, targets);

    expect(results).toHaveLength(targets.length);
    expect(results.map((result) => result.resolution)).toEqual(targets.map(() => "resolved"));
    expect(results[0].source).toMatchObject({ title: "Reference sample A", subtitle: "REF-A" });
    expect(results[1].contexts[0].segments.map((segment) => segment.type)).toEqual(["sample", "run"]);
    expect(results[2].contexts[0].segments.map((segment) => segment.type)).toEqual(["sample", "run", "run_step"]);
    expect(results[7].contexts[0].segments[0]).toMatchObject({
      type: "recipe_revision",
      id: ids.metrologyRevision,
    });

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("reference/private/");
    expect(serialized).not.toContain("r2_key");
    expect(serialized).not.toContain("object_key");
    expect(serialized).not.toContain("reference-comment-asset");
    database.close();
  });

  it("preserves every deterministic context for common Comments and their attachments", async () => {
    const { database, db } = fixture();
    const ids = REFERENCE_FIXTURE_IDS;
    const [comment, attachment] = await resolveReferences(db, [
      { type: "comment", id: ids.comment },
      { type: "comment_attachment", id: ids.commentAttachment },
    ]);

    expect(comment.contexts).toHaveLength(2);
    expect(comment.contexts.map((context) => context.segments[0].label)).toEqual([
      "REF-A · Reference sample A",
      "REF-B · Reference sample B",
    ]);
    expect(attachment.contexts).toEqual(comment.contexts);
    expect(comment.source?.excerpt).toContain("Shared reference Comment body");
    database.close();
  });

  it("keeps soft-deleted sources, deleted ancestors, and archived revisions resolvable", async () => {
    const { database, db } = fixture();
    const ids = REFERENCE_FIXTURE_IDS;
    database.exec(`
      UPDATE samples SET deleted_at = '2026-08-08T01:00:00.000Z' WHERE id = '${ids.sampleA}';
      UPDATE runs SET deleted_at = '2026-08-08T02:00:00.000Z' WHERE id = '${ids.runA}';
      UPDATE comment_submissions SET deleted_at = '2026-08-08T03:00:00.000Z' WHERE id = '${ids.comment}';
      UPDATE template_versions SET archived_at = '2026-08-08T04:00:00.000Z',
                                   deleted_at = '2026-08-08T05:00:00.000Z'
      WHERE id = '${ids.recipeRevision}';
    `);

    const [step, comment, recipe] = await resolveReferences(db, [
      { type: "run_step", id: ids.stepA },
      { type: "comment", id: ids.comment },
      { type: "recipe_revision", id: ids.recipeRevision },
    ]);
    expect(step.resolution).toBe("resolved");
    expect(step.contexts[0].segments[0].deletedAt).toBe("2026-08-08T01:00:00.000Z");
    expect(step.contexts[0].segments[1].deletedAt).toBe("2026-08-08T02:00:00.000Z");
    expect(comment.resolution).toBe("resolved");
    expect(comment.source?.deletedAt).toBe("2026-08-08T03:00:00.000Z");
    expect(recipe.resolution).toBe("resolved");
    expect(recipe.source).toMatchObject({
      archivedAt: "2026-08-08T04:00:00.000Z",
      deletedAt: "2026-08-08T05:00:00.000Z",
    });
    database.close();
  });

  it("distinguishes not-found, inconsistent registry, and tombstoned targets", async () => {
    const { database, db } = fixture();
    database.exec(`
      INSERT INTO reference_targets
        (id, target_type, target_id, first_registered_at, last_validated_at, last_known_contexts_json)
      VALUES
        ('registry-missing', 'sample', 'registered-but-missing',
         '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', '[]'),
        ('registry-tombstone', 'sample', 'tombstoned-sample',
         '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z',
         '[{"segments":[{"type":"sample","id":"tombstoned-sample","label":"Old sample","deletedAt":null,"archivedAt":null}]}]');
      UPDATE reference_targets SET tombstoned_at = '2026-08-08T01:00:00.000Z'
      WHERE id = 'registry-tombstone';
    `);

    const results = await resolveReferences(db, [
      { type: "sample", id: "never-registered" },
      { type: "sample", id: "registered-but-missing" },
      { type: "sample", id: "tombstoned-sample" },
    ]);
    expect(results.map((result) => result.resolution)).toEqual([
      "not_found",
      "inconsistent",
      "tombstoned",
    ]);
    expect(results[2].source).toBeNull();
    expect(results[2].contexts[0].segments[0].label).toBe("Old sample");
    database.close();
  });

  it("preserves input order and duplicates while bounding queries by target type", async () => {
    const { database, d1, db } = fixture();
    const ids = REFERENCE_FIXTURE_IDS;
    const pattern: ReferenceTarget[] = [
      { type: "sample", id: ids.sampleA },
      { type: "run_step", id: ids.stepA },
      { type: "comment", id: ids.comment },
      { type: "sample", id: ids.sampleA },
    ];
    const targets = Array.from({ length: 200 }, (_, index) => pattern[index % pattern.length]);
    d1.resetQueryCount();
    const results = await resolveReferences(db, targets);

    expect(results).toHaveLength(200);
    expect(results.map((result) => result.target)).toEqual(targets);
    expect(results.every((result) => result.resolution === "resolved")).toBe(true);
    expect(d1.queryCount).toBeLessThanOrEqual(7);
    database.close();
  });
});
