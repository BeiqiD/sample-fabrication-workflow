import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ACTIVATE_SAMPLE_FOR_RUN_SQL } from "./run-lifecycle";

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

function createSample(status: "active" | "stored" | "consumed" | "lost") {
  const database = new DatabaseSync(":memory:");
  database.exec(migration("0001_alpha_state_chain.sql"));
  database.prepare(
    `INSERT INTO samples (id, code, title, status, created_at, updated_at)
     VALUES ('sample-1', 'S-1', 'Sample', ?, '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:00.000Z')`,
  ).run(status);
  return database;
}

describe("sample status when a process run starts", () => {
  it.each(["stored", "consumed", "lost"] as const)("changes %s to active and records the transition", (status) => {
    const database = createSample(status);

    database.prepare(ACTIVATE_SAMPLE_FOR_RUN_SQL).run(
      "operator@example.com",
      "2026-07-23T10:05:00.000Z",
      "sample-1",
    );

    expect(database.prepare("SELECT status, updated_by FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active", updated_by: "operator@example.com" });
    expect(database.prepare("SELECT kind, body FROM events WHERE sample_id = 'sample-1'").get())
      .toEqual({ kind: "status", body: `Status changed from ${status} to active` });
    database.close();
  });

  it("does not add a duplicate status event when the sample is already active", () => {
    const database = createSample("active");

    database.prepare(ACTIVATE_SAMPLE_FOR_RUN_SQL).run(
      "operator@example.com",
      "2026-07-23T10:05:00.000Z",
      "sample-1",
    );

    expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE sample_id = 'sample-1'").get())
      .toEqual({ count: 0 });
    database.close();
  });
});

function createLifecycleDatabase(applyLifecycleMigration = true) {
  const database = new DatabaseSync(":memory:");
  database.exec(migration("0001_alpha_state_chain.sql"));
  if (applyLifecycleMigration) database.exec(migration("0004_sync_sample_run_status.sql"));
  database.exec(`
    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES ('family-1', 'Process', 'process', '2026-07-23T10:00:00.000Z');
    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at)
    VALUES
      ('template-1', 'family-1', 'Process', 'process', 1, 'manifest-1', '{}', '2026-07-23T10:00:00.000Z');
  `);
  return database;
}

function addRun(database: DatabaseSync, sampleStatus: "active" | "stored" | "consumed" | "lost" = "stored") {
  database.prepare(
    `INSERT INTO samples (id, code, title, status, created_at, updated_at)
     VALUES ('sample-1', 'S-1', 'Sample', ?, '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:00.000Z')`,
  ).run(sampleStatus);
  database.exec(`
    INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
       template_name_snapshot, template_type_snapshot, template_version_snapshot,
       created_by, created_at)
    VALUES
      ('run-1', 'sample-1', 'family-1', 'template-1', 1, 'group-1',
       'Process', 'process', 1, 'starter@example.com', '2026-07-23T10:05:00.000Z');
    INSERT INTO run_steps
      (id, run_id, position, status, origin, created_at, updated_by, updated_at)
    VALUES
      ('step-1', 'run-1', 1000, 'pending', 'template',
       '2026-07-23T10:05:00.000Z', 'starter@example.com', '2026-07-23T10:05:00.000Z');
  `);
}

describe("sample and process lifecycle synchronization", () => {
  it.each(["stored", "consumed", "lost"] as const)("makes a %s sample active when a run starts", (status) => {
    const database = createLifecycleDatabase();
    addRun(database, status);

    expect(database.prepare("SELECT status, updated_by FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active", updated_by: "starter@example.com" });
    database.close();
  });

  it("stores an active sample when its final current step completes", () => {
    const database = createLifecycleDatabase();
    addRun(database);

    database.prepare(
      `UPDATE run_steps
       SET status = 'done', actualized_at = ?, updated_by = ?, updated_at = ?
       WHERE id = 'step-1'`,
    ).run(
      "2026-07-23T10:10:00.000Z",
      "finisher@example.com",
      "2026-07-23T10:10:00.000Z",
    );

    expect(database.prepare("SELECT status, completed_at FROM runs WHERE id = 'run-1'").get())
      .toEqual({ status: "complete", completed_at: "2026-07-23T10:10:00.000Z" });
    expect(database.prepare("SELECT status, updated_by, updated_at FROM samples WHERE id = 'sample-1'").get())
      .toEqual({
        status: "stored",
        updated_by: "finisher@example.com",
        updated_at: "2026-07-23T10:10:00.000Z",
      });
    expect(database.prepare(
      "SELECT body, actor_email FROM events WHERE sample_id = 'sample-1' AND kind = 'status' ORDER BY created_at DESC LIMIT 1",
    ).get()).toEqual({
      body: "Status changed from active to stored",
      actor_email: "finisher@example.com",
    });
    database.close();
  });

  it.each(["consumed", "lost"] as const)("does not overwrite an explicit %s state when the run completes", (status) => {
    const database = createLifecycleDatabase();
    addRun(database);
    database.prepare(
      "UPDATE samples SET status = ?, updated_by = 'operator@example.com', updated_at = '2026-07-23T10:08:00.000Z' WHERE id = 'sample-1'",
    ).run(status);

    database.prepare(
      `UPDATE run_steps
       SET status = 'done', updated_by = 'finisher@example.com', updated_at = '2026-07-23T10:10:00.000Z'
       WHERE id = 'step-1'`,
    ).run();

    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status });
    database.close();
  });

  it("makes the sample active again when the latest completed run is reopened", () => {
    const database = createLifecycleDatabase();
    addRun(database);
    database.prepare(
      `UPDATE run_steps
       SET status = 'done', updated_by = 'finisher@example.com', updated_at = '2026-07-23T10:10:00.000Z'
       WHERE id = 'step-1'`,
    ).run();
    database.exec(`
      INSERT INTO run_plan_revisions
        (id, run_id, revision_no, template_version_id, actor_email, created_at)
      VALUES
        ('revision-2', 'run-1', 2, 'template-1', 'reopener@example.com', '2026-07-23T10:15:00.000Z');
      UPDATE runs SET status = 'active', completed_at = NULL WHERE id = 'run-1';
    `);

    expect(database.prepare("SELECT status, updated_by, updated_at FROM samples WHERE id = 'sample-1'").get())
      .toEqual({
        status: "active",
        updated_by: "reopener@example.com",
        updated_at: "2026-07-23T10:15:00.000Z",
      });
    database.close();
  });

  it("repairs an active sample whose latest run was already completed", () => {
    const database = createLifecycleDatabase(false);
    addRun(database, "active");
    database.prepare(
      `UPDATE run_steps
       SET status = 'done', updated_by = 'finisher@example.com', updated_at = '2026-07-23T10:10:00.000Z'
       WHERE id = 'step-1'`,
    ).run();
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active" });

    database.exec(migration("0004_sync_sample_run_status.sql"));

    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });
    database.close();
  });
});
