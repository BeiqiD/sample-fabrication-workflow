import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

function createDatabase(applyMetrologyStatusMigration = true) {
  const database = new DatabaseSync(":memory:");
  database.exec(migration("0001_alpha_state_chain.sql"));
  database.exec(migration("0004_sync_sample_run_status.sql"));
  database.exec(migration("0006_metrology_templates.sql"));
  if (applyMetrologyStatusMigration) {
    database.exec(migration("0008_sync_metrology_sample_status.sql"));
  }
  database.exec(`
    INSERT INTO samples
      (id, code, title, status, created_at, updated_at)
    VALUES
      ('sample-1', 'S-1', 'Sample', 'stored',
       '2026-07-24T10:00:00.000Z', '2026-07-24T10:00:00.000Z');

    INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
       run_kind, template_name_snapshot, template_type_snapshot, template_version_snapshot,
       created_at)
    VALUES
      ('metrology-run-1', 'sample-1', 'builtin-metrology-family-sem',
       'builtin-metrology-template-sem', 1, 'metrology-group-1', 'metrology',
       'SEM', 'module', 1, '2026-07-24T10:05:00.000Z');

    INSERT INTO run_steps
      (id, run_id, position, status, origin, entry_kind, template_step_id,
       logical_step_key, definition_hash, created_at, updated_at)
    SELECT
      'metrology-record-1', 'metrology-run-1', 1000, 'pending', 'template', 'metrology',
      ts.id, ts.logical_step_key, ts.definition_hash,
      '2026-07-24T10:05:00.000Z', '2026-07-24T10:05:00.000Z'
    FROM template_steps ts
    WHERE ts.template_version_id = 'builtin-metrology-template-sem';
  `);
  return database;
}

function templateFields(database: DatabaseSync) {
  return database.prepare(
    `SELECT sd.name, sd.tool_name, sd.parameters_text, sd.comments_text
     FROM template_steps ts
     JOIN step_definitions sd ON sd.hash = ts.definition_hash
     WHERE ts.template_version_id = 'builtin-metrology-template-sem'`,
  ).get();
}

function runFields(database: DatabaseSync) {
  return database.prepare(
    `SELECT COALESCE(rs.title, sd.name) AS name,
            COALESCE(rs.tool_name, sd.tool_name) AS tool_name,
            COALESCE(rs.parameters_text, sd.parameters_text) AS parameters_text,
            COALESCE(rs.comments_text, sd.comments_text) AS comments_text
     FROM run_steps rs
     JOIN step_definitions sd ON sd.hash = rs.definition_hash
     WHERE rs.id = 'metrology-record-1'`,
  ).get();
}

function addProcessRun(database: DatabaseSync, inlineMetrology = false) {
  database.exec(`
    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES ('process-family-1', 'Process 1', 'process', '2026-07-24T10:20:00.000Z');

    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash,
       content_json, created_at, template_kind)
    VALUES
      ('process-template-1', 'process-family-1', 'Process 1', 'process', 1,
       'process-manifest-1', '{}', '2026-07-24T10:20:00.000Z', 'process');

    INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
       run_kind, template_name_snapshot, template_type_snapshot, template_version_snapshot,
       created_at)
    VALUES
      ('process-run-1', 'sample-1', 'process-family-1', 'process-template-1', 2,
       'process-group-1', 'process', 'Process 1', 'process', 1,
       '2026-07-24T10:20:00.000Z');

    INSERT INTO run_steps
      (id, run_id, position, status, origin, entry_kind, definition_hash,
       created_at, updated_at)
    VALUES
      ('fabrication-step-1', 'process-run-1', 1000, 'pending', 'template',
       'fabrication', 'b340e57f0b53f1d1f657f99ef1bd25c8b9b54dd442a1d50ae7ea7a936af409b5',
       '2026-07-24T10:20:00.000Z', '2026-07-24T10:20:00.000Z')
    ${inlineMetrology ? `,
      ('inline-metrology-1', 'process-run-1', 2000, 'pending', 'ad_hoc',
       'metrology', 'b340e57f0b53f1d1f657f99ef1bd25c8b9b54dd442a1d50ae7ea7a936af409b5',
       '2026-07-24T10:20:00.000Z', '2026-07-24T10:20:00.000Z')` : ""};
  `);
}

describe("metrology template snapshots", () => {
  it("does not update a template when a run record is edited", () => {
    const database = createDatabase();

    database.prepare(
      `UPDATE run_steps
       SET parameters_text = ?, comments_text = ?, updated_at = ?
       WHERE id = 'metrology-record-1'`,
    ).run(
      "Accelerating voltage: 5 kV",
      "Surface is uniform",
      "2026-07-24T10:10:00.000Z",
    );

    expect(runFields(database)).toEqual({
      name: "SEM",
      tool_name: null,
      parameters_text: "Accelerating voltage: 5 kV",
      comments_text: "Surface is uniform",
    });
    expect(templateFields(database)).toEqual({
      name: "SEM",
      tool_name: null,
      parameters_text: null,
      comments_text: null,
    });
    database.close();
  });

  it("keeps an existing run snapshot unchanged when the template is edited later", () => {
    const database = createDatabase();
    const originalRunFields = runFields(database);

    database.exec(`
      INSERT INTO step_definitions
        (hash, hash_scheme, name, tool_name, parameters_text, comments_text,
         canonical_json, created_at)
      VALUES
        ('updated-sem-definition', 'step-definition/v1', 'SEM updated', 'SEM-2',
         'Accelerating voltage: 10 kV', 'New default comment', '{}',
         '2026-07-24T10:15:00.000Z');

      UPDATE template_steps
      SET definition_hash = 'updated-sem-definition'
      WHERE template_version_id = 'builtin-metrology-template-sem';

      UPDATE template_versions
      SET metrology_notes = 'Instrument manual and operating notes'
      WHERE id = 'builtin-metrology-template-sem';
    `);

    expect(templateFields(database)).toEqual({
      name: "SEM updated",
      tool_name: "SEM-2",
      parameters_text: "Accelerating voltage: 10 kV",
      comments_text: "New default comment",
    });
    expect(runFields(database)).toEqual(originalRunFields);
    expect(database.prepare(
      "SELECT metrology_notes FROM template_versions WHERE id = 'builtin-metrology-template-sem'",
    ).get()).toEqual({ metrology_notes: "Instrument manual and operating notes" });
    database.close();
  });
});

describe("metrology run lifecycle", () => {
  it("activates the sample for standalone metrology and stores it when Done", () => {
    const database = createDatabase();

    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active" });

    database.prepare(
      `UPDATE run_steps
       SET status = 'done', updated_by = 'analyst@example.com',
           updated_at = '2026-07-24T10:10:00.000Z'
       WHERE id = 'metrology-record-1'`,
    ).run();

    expect(database.prepare("SELECT status FROM runs WHERE id = 'metrology-run-1'").get())
      .toEqual({ status: "complete" });
    expect(database.prepare("SELECT status, updated_by FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored", updated_by: "analyst@example.com" });
    expect(database.prepare(
      "SELECT body FROM events WHERE sample_id = 'sample-1' AND kind = 'status' ORDER BY created_at DESC LIMIT 1",
    ).get()).toEqual({ body: "Status changed from active to stored" });
    database.close();
  });

  it("keeps completed metrology results editable without reopening the run", () => {
    const database = createDatabase();
    database.exec(`
      UPDATE run_steps
      SET status = 'done', updated_by = 'analyst@example.com',
          updated_at = '2026-07-24T10:10:00.000Z'
      WHERE id = 'metrology-record-1';

      UPDATE run_steps
      SET parameters_text = 'Post-processed roughness: 0.24 nm',
          comments_text = 'Background correction completed',
          updated_by = 'analyst@example.com',
          updated_at = '2026-07-24T10:30:00.000Z'
      WHERE id = 'metrology-record-1';
    `);

    expect(database.prepare(
      "SELECT status, parameters_text, comments_text FROM run_steps WHERE id = 'metrology-record-1'",
    ).get()).toEqual({
      status: "done",
      parameters_text: "Post-processed roughness: 0.24 nm",
      comments_text: "Background correction completed",
    });
    expect(database.prepare("SELECT status FROM runs WHERE id = 'metrology-run-1'").get())
      .toEqual({ status: "complete" });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });
    database.close();
  });

  it("keeps the sample active until concurrent process and metrology runs finish", () => {
    const database = createDatabase();
    addProcessRun(database);

    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active" });

    database.prepare(
      `UPDATE run_steps
       SET status = 'done', updated_at = '2026-07-24T10:25:00.000Z'
       WHERE id = 'fabrication-step-1'`,
    ).run();

    expect(database.prepare("SELECT status FROM runs WHERE id = 'process-run-1'").get())
      .toEqual({ status: "complete" });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active" });

    database.prepare(
      `UPDATE run_steps
       SET status = 'done', updated_at = '2026-07-24T10:30:00.000Z'
       WHERE id = 'metrology-record-1'`,
    ).run();

    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });
    database.close();
  });

  it("does not hold a fabrication process open for an inline metrology record", () => {
    const database = createDatabase();
    database.prepare(
      `UPDATE run_steps
       SET status = 'done', updated_at = '2026-07-24T10:10:00.000Z'
       WHERE id = 'metrology-record-1'`,
    ).run();
    addProcessRun(database, true);

    database.prepare(
      `UPDATE run_steps
       SET status = 'done', updated_at = '2026-07-24T10:25:00.000Z'
       WHERE id = 'fabrication-step-1'`,
    ).run();

    expect(database.prepare("SELECT status FROM runs WHERE id = 'process-run-1'").get())
      .toEqual({ status: "complete" });
    expect(database.prepare("SELECT status FROM run_steps WHERE id = 'inline-metrology-1'").get())
      .toEqual({ status: "pending" });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });
    database.close();
  });

  it("repairs a stored sample with an active standalone metrology run", () => {
    const database = createDatabase(false);

    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });

    database.exec(migration("0008_sync_metrology_sample_status.sql"));

    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active" });
    database.close();
  });
});
