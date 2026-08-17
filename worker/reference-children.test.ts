import { describe, expect, it } from "vitest";
import {
  ReferenceChildrenInputError,
  listReferenceChildren,
  normalizeReferenceChildrenInput,
} from "./references/children";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  const adapter = new SqliteD1Database(database);
  return { database, db: adapter as unknown as D1Database };
}

function targets(response: Awaited<ReturnType<typeof listReferenceChildren>>) {
  return response.children.map((child) => child.target);
}

describe("authoritative reference child listing", () => {
  it("normalizes one stable parent target and a bounded optional limit", () => {
    expect(normalizeReferenceChildrenInput({
      parent: { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
    })).toEqual({
      parent: { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
      limit: 50,
    });
    expect(normalizeReferenceChildrenInput({
      parent: { type: "run", id: REFERENCE_FIXTURE_IDS.runA },
      limit: 3,
    }).limit).toBe(3);

    const invalid: unknown[] = [
      null,
      {},
      { parent: { type: "unknown", id: "one" } },
      { parent: { type: "sample", id: " sample " } },
      { parent: { type: "sample", id: "sample" }, limit: 0 },
      { parent: { type: "sample", id: "sample" }, limit: 101 },
      { parent: { type: "sample", id: "sample" }, limit: 1.5 },
    ];
    for (const value of invalid) {
      expect(() => normalizeReferenceChildrenInput(value))
        .toThrow(ReferenceChildrenInputError);
    }
  });

  it("exposes direct source hierarchy without writing the reference registry", async () => {
    const { database, db } = fixture();

    expect(targets(await listReferenceChildren(db, {
      parent: { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
    }))).toEqual([
      { type: "run", id: REFERENCE_FIXTURE_IDS.runA },
    ]);

    expect(targets(await listReferenceChildren(db, {
      parent: { type: "run", id: REFERENCE_FIXTURE_IDS.runA },
    }))).toEqual([
      { type: "run_step", id: REFERENCE_FIXTURE_IDS.stepA },
    ]);

    expect(targets(await listReferenceChildren(db, {
      parent: { type: "run_step", id: REFERENCE_FIXTURE_IDS.stepA },
    }))).toEqual([
      { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
      { type: "execution_image", id: REFERENCE_FIXTURE_IDS.executionImage },
    ]);

    expect(targets(await listReferenceChildren(db, {
      parent: { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
    }))).toEqual([
      { type: "comment_occurrence", id: REFERENCE_FIXTURE_IDS.commentOccurrenceA },
      { type: "comment_occurrence", id: REFERENCE_FIXTURE_IDS.commentOccurrenceB },
      { type: "comment_attachment", id: REFERENCE_FIXTURE_IDS.commentAttachment },
    ]);

    expect(targets(await listReferenceChildren(db, {
      parent: { type: "comment_occurrence", id: REFERENCE_FIXTURE_IDS.commentOccurrenceA },
    }))).toEqual([
      { type: "comment_attachment", id: REFERENCE_FIXTURE_IDS.commentAttachment },
    ]);

    expect(targets(await listReferenceChildren(db, {
      parent: { type: "recipe_revision", id: REFERENCE_FIXTURE_IDS.metrologyRevision },
    }))).toEqual([
      { type: "metrology_reference", id: REFERENCE_FIXTURE_IDS.metrologyReference },
    ]);

    const leaf = await listReferenceChildren(db, {
      parent: { type: "execution_image", id: REFERENCE_FIXTURE_IDS.executionImage },
    });
    expect(leaf.parentEligible).toBe(true);
    expect(leaf.children).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reference_targets").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("uses canonical Comment identity for submitted Step comments and occurrence identity for legacy comments", async () => {
    const { database, db } = fixture();
    database.exec(`
      INSERT INTO run_step_comments
        (id, run_step_id, scope, body, actor_email, created_at, updated_at)
      VALUES
        ('legacy-child-comment', '${REFERENCE_FIXTURE_IDS.stepA}', 'individual',
         'Legacy direct child', 'reference@example.com',
         '2026-08-01T04:30:00.000Z', '2026-08-01T04:30:00.000Z')
    `);

    expect(targets(await listReferenceChildren(db, {
      parent: { type: "run_step", id: REFERENCE_FIXTURE_IDS.stepA },
    }))).toEqual([
      { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
      { type: "comment_occurrence", id: "legacy-child-comment" },
      { type: "execution_image", id: REFERENCE_FIXTURE_IDS.executionImage },
    ]);
    database.close();
  });

  it("returns no children for an unavailable parent and filters children with deleted source context", async () => {
    const { database, db } = fixture();
    database.exec(`
      UPDATE samples
      SET deleted_at = '2026-08-17T00:00:00.000Z'
      WHERE id = '${REFERENCE_FIXTURE_IDS.sampleA}'
    `);

    const sample = await listReferenceChildren(db, {
      parent: { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
    });
    expect(sample.parent.resolution).toBe("resolved");
    expect(sample.parentEligible).toBe(false);
    expect(sample.children).toEqual([]);

    const run = await listReferenceChildren(db, {
      parent: { type: "run", id: REFERENCE_FIXTURE_IDS.runA },
    });
    expect(run.parentEligible).toBe(false);
    expect(run.children).toEqual([]);

    database.exec(`
      UPDATE samples SET deleted_at = NULL
      WHERE id = '${REFERENCE_FIXTURE_IDS.sampleA}';
      UPDATE run_step_assets
      SET deleted_at = '2026-08-17T00:01:00.000Z'
      WHERE id = '${REFERENCE_FIXTURE_IDS.executionImage}'
    `);
    expect(targets(await listReferenceChildren(db, {
      parent: { type: "run_step", id: REFERENCE_FIXTURE_IDS.stepA },
    }))).toEqual([
      { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
    ]);
    database.close();
  });

  it("keeps direct-child reads bounded and reports deterministic truncation", async () => {
    const { database, db } = fixture();
    const insert = database.prepare(`
      INSERT INTO run_steps
        (id, run_id, position, origin, plan_status, definition_hash, title, status,
         entry_kind, created_at, updated_at)
      VALUES (?, ?, ?, 'template', 'current', 'reference-step-definition', ?,
              'pending', 'fabrication', '2026-08-02T00:00:00.000Z',
              '2026-08-02T00:00:00.000Z')
    `);
    for (let index = 1; index <= 120; index += 1) {
      const id = `child-step-${String(index).padStart(3, "0")}`;
      insert.run(
        id,
        REFERENCE_FIXTURE_IDS.runA,
        index,
        `Child step ${String(index).padStart(3, "0")}`,
      );
    }

    const response = await listReferenceChildren(db, {
      parent: { type: "run", id: REFERENCE_FIXTURE_IDS.runA },
      limit: 10,
    });
    expect(response.children).toHaveLength(10);
    expect(response.children[0].target).toEqual({
      type: "run_step",
      id: REFERENCE_FIXTURE_IDS.stepA,
    });
    expect(response.children[1].target).toEqual({
      type: "run_step",
      id: "child-step-001",
    });
    expect(response.truncated).toBe(true);
    database.close();
  });
});
