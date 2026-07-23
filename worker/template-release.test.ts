import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(migration("0001_alpha_state_chain.sql"));
  database.exec(migration("0002_run_initial_state.sql"));
  return database;
}

function addFamily(database: DatabaseSync, id = "family-1") {
  database.prepare(
    "INSERT INTO recipe_families (id, name, template_type, created_at) VALUES (?, ?, 'process', ?)",
  ).run(id, id, "2026-07-23T10:00:00.000Z");
}

function addTemplate(database: DatabaseSync, id: string, familyId = "family-1", locked = false, version = 1) {
  database.prepare(
    `INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at, locked_at, locked_by)
     VALUES (?, ?, ?, 'process', ?, ?, '{}', ?, ?, ?)`,
  ).run(
    id,
    familyId,
    id,
    version,
    `${id}-manifest`,
    "2026-07-23T10:00:00.000Z",
    locked ? "2026-07-23T10:05:00.000Z" : null,
    locked ? "operator@example.com" : null,
  );
}

function addSample(database: DatabaseSync, id: string) {
  database.prepare(
    `INSERT INTO samples (id, code, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, id, id, "2026-07-23T10:00:00.000Z", "2026-07-23T10:00:00.000Z");
}

function addRun(database: DatabaseSync, sampleId: string, templateId: string, suffix: string, revisionTemplateId = templateId) {
  const runId = `run-${suffix}`;
  database.prepare(
    `INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
       template_name_snapshot, template_type_snapshot, template_version_snapshot, created_at)
     SELECT ?, ?, recipe_family_id, ?, 1, ?, name, template_type, version, ?
     FROM template_versions WHERE id = ?`,
  ).run(runId, sampleId, templateId, `group-${suffix}`, "2026-07-23T10:05:00.000Z", templateId);
  database.prepare(
    `INSERT INTO run_plan_revisions
      (id, run_id, revision_no, template_version_id, created_at)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(`revision-${suffix}`, runId, revisionTemplateId, "2026-07-23T10:05:00.000Z");
}

function lockState(database: DatabaseSync, templateId: string) {
  return database.prepare(
    "SELECT locked_at, locked_by FROM template_versions WHERE id = ?",
  ).get(templateId) as { locked_at: string | null; locked_by: string | null };
}

describe("template release migration", () => {
  it("repairs an existing active template lock with no live references", () => {
    const database = createDatabase();
    addFamily(database);
    addTemplate(database, "template-1", "family-1", true);

    database.exec(migration("0003_release_unreferenced_templates.sql"));

    expect(lockState(database, "template-1")).toEqual({ locked_at: null, locked_by: null });
    database.close();
  });

  it("releases a template after its final sample is deleted", () => {
    const database = createDatabase();
    database.exec(migration("0003_release_unreferenced_templates.sql"));
    addFamily(database);
    addTemplate(database, "template-1");
    addSample(database, "sample-1");
    addRun(database, "sample-1", "template-1", "1");
    expect(lockState(database, "template-1").locked_at).not.toBeNull();

    database.prepare("DELETE FROM samples WHERE id = ?").run("sample-1");

    expect(lockState(database, "template-1")).toEqual({ locked_at: null, locked_by: null });
    database.close();
  });

  it("keeps a shared template locked until every using sample is deleted", () => {
    const database = createDatabase();
    database.exec(migration("0003_release_unreferenced_templates.sql"));
    addFamily(database);
    addTemplate(database, "template-1");
    addSample(database, "sample-1");
    addSample(database, "sample-2");
    addRun(database, "sample-1", "template-1", "1");
    addRun(database, "sample-2", "template-1", "2");

    database.prepare("DELETE FROM samples WHERE id = ?").run("sample-1");
    expect(lockState(database, "template-1").locked_at).not.toBeNull();

    database.prepare("DELETE FROM samples WHERE id = ?").run("sample-2");
    expect(lockState(database, "template-1")).toEqual({ locked_at: null, locked_by: null });
    database.close();
  });

  it("releases every template referenced by a deleted run plan", () => {
    const database = createDatabase();
    database.exec(migration("0003_release_unreferenced_templates.sql"));
    addFamily(database);
    addTemplate(database, "template-1");
    addTemplate(database, "template-2", "family-1", false, 2);
    addSample(database, "sample-1");
    addRun(database, "sample-1", "template-1", "1");
    database.prepare(
      `INSERT INTO run_plan_revisions
        (id, run_id, revision_no, template_version_id, created_at)
       VALUES ('revision-2', 'run-1', 2, 'template-2', '2026-07-23T10:10:00.000Z')`,
    ).run();

    database.prepare("DELETE FROM samples WHERE id = ?").run("sample-1");

    expect(lockState(database, "template-1").locked_at).toBeNull();
    expect(lockState(database, "template-2").locked_at).toBeNull();
    database.close();
  });

  it("keeps a proposal source immutable until the proposal is removed", () => {
    const database = createDatabase();
    database.exec(migration("0003_release_unreferenced_templates.sql"));
    addFamily(database);
    addTemplate(database, "template-1");
    addSample(database, "sample-1");
    addRun(database, "sample-1", "template-1", "1");
    database.prepare(
      `INSERT INTO recipe_change_proposals
        (id, recipe_family_id, source_template_version_id, change_type, body, created_at)
       VALUES ('proposal-1', 'family-1', 'template-1', 'process', 'Review this change', '2026-07-23T10:10:00.000Z')`,
    ).run();

    database.prepare("DELETE FROM samples WHERE id = ?").run("sample-1");
    expect(lockState(database, "template-1").locked_at).not.toBeNull();

    database.prepare("DELETE FROM recipe_change_proposals WHERE id = ?").run("proposal-1");
    expect(lockState(database, "template-1")).toEqual({ locked_at: null, locked_by: null });
    database.close();
  });
});
