import { describe, expect, it } from "vitest";
import { resolveReferences } from "./references/resolver";
import {
  ReferenceRegistrationError,
  refreshReferenceTarget,
  registerReferenceTarget,
} from "./references/registry";
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
  return { database, db: d1 as unknown as D1Database };
}

describe("reference target registry service", () => {
  it("registers one canonical row idempotently and preserves soft-deleted targets", async () => {
    const { database, db } = fixture();
    const target = { type: "sample" as const, id: REFERENCE_FIXTURE_IDS.sampleA };
    database.prepare("UPDATE samples SET deleted_at = '2026-08-08T00:00:00.000Z' WHERE id = ?")
      .run(target.id);

    const first = await registerReferenceTarget(
      db,
      target,
      "2026-08-08T01:00:00.000Z",
      "reference-registry-id",
    );
    const second = await registerReferenceTarget(
      db,
      target,
      "2026-08-08T02:00:00.000Z",
      "ignored-racing-id",
    );

    expect(first.id).toBe("reference-registry-id");
    expect(second.id).toBe(first.id);
    expect(second.lastValidatedAt).toBe("2026-08-08T02:00:00.000Z");
    expect(second.lastKnownContexts[0].segments[0].deletedAt)
      .toBe("2026-08-08T00:00:00.000Z");
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM reference_targets
      WHERE target_type = 'sample' AND target_id = ?
    `).get(target.id)).toEqual({ count: 1 });
    database.close();
  });

  it("keeps ordinary resolution read-only and refreshes only through an explicit service call", async () => {
    const { database, db } = fixture();
    const target = { type: "run_step" as const, id: REFERENCE_FIXTURE_IDS.stepA };
    await registerReferenceTarget(db, target, "2026-08-08T01:00:00.000Z", "registry-step");
    database.prepare("UPDATE samples SET title = 'Renamed sample' WHERE id = ?")
      .run(REFERENCE_FIXTURE_IDS.sampleA);

    await resolveReferences(db, [target]);
    expect(database.prepare("SELECT last_validated_at FROM reference_targets WHERE id = 'registry-step'").get())
      .toEqual({ last_validated_at: "2026-08-08T01:00:00.000Z" });

    const refreshed = await refreshReferenceTarget(db, target, "2026-08-08T03:00:00.000Z");
    expect(refreshed.lastValidatedAt).toBe("2026-08-08T03:00:00.000Z");
    expect(refreshed.lastKnownContexts[0].segments[0].label).toBe("REF-A · Renamed sample");
    database.close();
  });

  it("does not let stale registration validation overwrite newer registry metadata", async () => {
    const { database, db } = fixture();
    const target = { type: "sample" as const, id: REFERENCE_FIXTURE_IDS.sampleA };
    database.prepare("UPDATE samples SET title = 'Newer registration context' WHERE id = ?")
      .run(target.id);
    await registerReferenceTarget(
      db,
      target,
      "2026-08-08T02:00:00.000Z",
      "registry-registration-race",
    );

    database.prepare("UPDATE samples SET title = 'Stale registration context' WHERE id = ?")
      .run(target.id);
    const staleResult = await registerReferenceTarget(
      db,
      target,
      "2026-08-08T01:00:00.000Z",
      "ignored-stale-registration-id",
    );

    expect(staleResult.lastValidatedAt).toBe("2026-08-08T02:00:00.000Z");
    expect(staleResult.lastKnownContexts[0].segments[0].label)
      .toBe("REF-A · Newer registration context");
    database.close();
  });

  it("returns newer registry metadata instead of treating a stale refresh as a tombstone", async () => {
    const { database, db } = fixture();
    const target = { type: "sample" as const, id: REFERENCE_FIXTURE_IDS.sampleA };
    await registerReferenceTarget(
      db,
      target,
      "2026-08-08T01:00:00.000Z",
      "registry-refresh-race",
    );
    database.prepare("UPDATE samples SET title = 'Newer refresh context' WHERE id = ?")
      .run(target.id);
    await refreshReferenceTarget(db, target, "2026-08-08T03:00:00.000Z");

    database.prepare("UPDATE samples SET title = 'Stale refresh context' WHERE id = ?")
      .run(target.id);
    const staleResult = await refreshReferenceTarget(db, target, "2026-08-08T02:00:00.000Z");

    expect(staleResult.lastValidatedAt).toBe("2026-08-08T03:00:00.000Z");
    expect(staleResult.lastKnownContexts[0].segments[0].label)
      .toBe("REF-A · Newer refresh context");
    database.close();
  });

  it("rejects missing, inconsistent, and tombstoned registration targets", async () => {
    const { database, db } = fixture();
    await expect(registerReferenceTarget(
      db,
      { type: "sample", id: "missing-sample" },
      "2026-08-08T01:00:00.000Z",
      "registry-missing",
    )).rejects.toMatchObject<Partial<ReferenceRegistrationError>>({ code: "not_resolvable" });

    database.exec(`
      INSERT INTO reference_targets
        (id, target_type, target_id, first_registered_at, last_validated_at, tombstoned_at)
      VALUES ('registry-tombstoned', 'sample', '${REFERENCE_FIXTURE_IDS.sampleA}',
              '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z',
              '2026-08-08T00:30:00.000Z');
    `);
    await expect(registerReferenceTarget(
      db,
      { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
      "2026-08-08T02:00:00.000Z",
      "ignored-id",
    )).rejects.toMatchObject<Partial<ReferenceRegistrationError>>({ code: "tombstoned" });
    database.close();
  });
});
