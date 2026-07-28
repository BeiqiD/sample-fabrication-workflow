import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./types";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.database, this.query, bindings);
  }

  private statement(): StatementSync {
    return this.database.prepare(this.query);
  }

  async first<T>() {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement().all(...this.bindings) as T[],
      meta: {},
    };
  }

  async run() {
    return this.execute();
  }

  execute() {
    const result = this.statement().run(...this.bindings);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    };
  }
}

class SqliteD1Database {
  constructor(readonly database: DatabaseSync) {}

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
  database.exec(`
    INSERT INTO samples (id, code, title, status, created_at, updated_at)
    VALUES ('sample-1', 'S-1', 'Sample', 'active', '2026-07-28T10:00:00.000Z', '2026-07-28T10:10:00.000Z');

    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES ('family-1', 'Process', 'process', '2026-07-28T10:00:00.000Z');

    INSERT INTO state_representations (hash, content_json, created_at)
    VALUES
      ('initial-state', '{}', '2026-07-28T10:00:00.000Z'),
      ('pre-clean-state', '{}', '2026-07-28T10:00:00.000Z'),
      ('old-clean-state', '{}', '2026-07-28T10:00:00.000Z'),
      ('new-clean-state', '{}', '2026-07-28T10:00:00.000Z');

    INSERT INTO assets
      (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
    VALUES
      ('new-clean-asset', 'imports/new-clean.png', 'new-clean.png', 'image/png', 10, 'ready',
       'new-clean-image-hash', '2026-07-28T10:00:00.000Z');
    INSERT INTO state_representation_assets (state_hash, asset_id, position)
    VALUES ('new-clean-state', 'new-clean-asset', 0);

    INSERT INTO step_definitions
      (hash, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
    VALUES
      ('old-clean-definition', 'Clean', 'Old cleaner', 'Old parameters', 'Old note', '{}', '2026-07-28T10:00:00.000Z'),
      ('old-obsolete-definition', 'Obsolete step', NULL, NULL, NULL, '{}', '2026-07-28T10:00:00.000Z'),
      ('old-coat-definition', 'Coat', NULL, NULL, NULL, '{}', '2026-07-28T10:00:00.000Z'),
      ('new-pre-clean-definition', 'Pre-clean', NULL, NULL, NULL, '{}', '2026-07-28T10:00:00.000Z'),
      ('new-clean-definition', 'Clean', 'New cleaner', 'New parameters', 'New note', '{}', '2026-07-28T10:00:00.000Z'),
      ('new-descum-definition', 'Descum', NULL, NULL, NULL, '{}', '2026-07-28T10:00:00.000Z'),
      ('new-coat-definition', 'Coat', NULL, NULL, NULL, '{}', '2026-07-28T10:00:00.000Z');

    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash, initial_state_hash,
       content_json, created_at, template_kind)
    VALUES
      ('template-v1', 'family-1', 'Process', 'process', 1, 'manifest-v1', 'initial-state',
       '{}', '2026-07-28T10:00:00.000Z', 'process'),
      ('template-v2', 'family-1', 'Process', 'process', 2, 'manifest-v2', NULL,
       '{}', '2026-07-28T10:00:00.000Z', 'process');

    INSERT INTO template_steps
      (id, template_version_id, logical_step_key, position, definition_hash, expected_state_hash)
    VALUES
      ('old-clean', 'template-v1', 'name:clean:1', 0, 'old-clean-definition', 'old-clean-state'),
      ('old-obsolete', 'template-v1', 'name:obsolete-step:1', 1, 'old-obsolete-definition', NULL),
      ('old-coat', 'template-v1', 'name:coat:1', 2, 'old-coat-definition', NULL),
      ('new-pre-clean', 'template-v2', 'name:pre-clean:1', 0, 'new-pre-clean-definition', 'pre-clean-state'),
      ('new-clean', 'template-v2', 'name:clean:1', 1, 'new-clean-definition', 'new-clean-state'),
      ('new-descum', 'template-v2', 'name:descum:1', 2, 'new-descum-definition', NULL),
      ('new-coat', 'template-v2', 'name:coat:1', 3, 'new-coat-definition', NULL);

    INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, current_plan_revision_id,
       sequence_no, run_group_id, template_name_snapshot, template_type_snapshot,
       template_version_snapshot, status, created_at, initial_state_hash, run_kind)
    VALUES
      ('run-1', 'sample-1', 'family-1', 'template-v1', NULL, 1, 'group-1',
       'Process', 'process', 1, 'active', '2026-07-28T10:00:00.000Z', 'initial-state', 'process');

    INSERT INTO run_plan_revisions
      (id, run_id, revision_no, template_version_id, actor_email, created_at)
    VALUES ('revision-1', 'run-1', 1, 'template-v1', 'operator@example.com', '2026-07-28T10:00:00.000Z');
    UPDATE runs SET current_plan_revision_id = 'revision-1' WHERE id = 'run-1';

    INSERT INTO run_steps
      (id, run_id, previous_step_id, position, template_step_id, logical_step_key,
       definition_hash, expected_state_hash, status, actualized_at, created_at, updated_at)
    VALUES
      ('run-clean', 'run-1', NULL, 1000, 'old-clean', 'name:clean:1',
       'old-clean-definition', 'old-clean-state', 'done', '2026-07-28T10:05:00.000Z',
       '2026-07-28T10:00:00.000Z', '2026-07-28T10:05:00.000Z'),
      ('run-obsolete', 'run-1', 'run-clean', 1500, 'old-obsolete', 'name:obsolete-step:1',
       'old-obsolete-definition', NULL, 'pending', '2026-07-28T10:06:00.000Z',
       '2026-07-28T10:00:00.000Z', '2026-07-28T10:06:00.000Z'),
      ('run-coat', 'run-1', 'run-obsolete', 2000, 'old-coat', 'name:coat:1',
       'old-coat-definition', NULL, 'pending', NULL,
       '2026-07-28T10:00:00.000Z', '2026-07-28T10:00:00.000Z');

    INSERT INTO run_step_plan_links
      (run_plan_revision_id, template_step_id, run_step_id, relation, created_at)
    VALUES
      ('revision-1', 'old-clean', 'run-clean', 'historical', '2026-07-28T10:00:00.000Z'),
      ('revision-1', 'old-obsolete', 'run-obsolete', 'historical', '2026-07-28T10:00:00.000Z'),
      ('revision-1', 'old-coat', 'run-coat', 'planned', '2026-07-28T10:00:00.000Z');

    INSERT INTO run_step_comments
      (id, run_step_id, scope, body, actor_email, created_at)
    VALUES
      ('obsolete-comment', 'run-obsolete', 'individual', 'Keep this observation',
       'operator@example.com', '2026-07-28T10:06:00.000Z');
  `);
  return database;
}

describe("plan update route", () => {
  it("inserts a new step before rewiring the following matched step to it", async () => {
    const database = createDatabase();
    const env = {
      AUTH_MODE: "disabled",
      DB: new SqliteD1Database(database),
      ASSETS: {},
    } as unknown as Env;
    const previewResponse = await worker.fetch(new Request(
      "https://samples.run/api/samples/sample-1/runs/run-1/plan-update/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateVersionId: "template-v2" }),
      },
    ), env, {} as ExecutionContext);
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as {
      sampleUpdatedAt: string;
      currentTemplateVersionId: string;
      substrateTransition: {
        sampleUpdatedAt: string;
        expectedLatestRunId: string;
        sampleCurrentState: { hash: string };
        comparisonTarget: { key: string; stateHash: string };
      };
    };

    const applyResponse = await worker.fetch(new Request(
      "https://samples.run/api/samples/sample-1/runs/run-1/plan-update",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateVersionId: "template-v2",
          substrateConfirmation: {
            confirmed: true,
            expectedSampleUpdatedAt: preview.substrateTransition.sampleUpdatedAt,
            expectedPreviousStateHash: preview.substrateTransition.sampleCurrentState.hash,
            expectedTemplateStructureKey: preview.substrateTransition.comparisonTarget.key,
            expectedTemplateStateHash: preview.substrateTransition.comparisonTarget.stateHash,
            expectedLatestRunId: preview.substrateTransition.expectedLatestRunId,
            expectedCurrentPlanRevisionId: "revision-1",
          },
        }),
      },
    ), env, {} as ExecutionContext);

    expect(applyResponse.status).toBe(200);
    const inserted = database.prepare(
      "SELECT id FROM run_steps WHERE run_id = 'run-1' AND template_step_id = 'new-descum'",
    ).get() as { id: string };
    expect(database.prepare(
      "SELECT previous_step_id FROM run_steps WHERE id = 'run-coat'",
    ).get()).toEqual({ previous_step_id: inserted.id });
    expect(database.prepare(
      "SELECT current_plan_revision_id, template_version_id FROM runs WHERE id = 'run-1'",
    ).get()).toEqual({
      current_plan_revision_id: expect.any(String),
      template_version_id: "template-v2",
    });
    expect(database.prepare(
      `SELECT template_step_id, definition_hash, expected_state_hash, status, actualized_at
       FROM run_steps WHERE id = 'run-clean'`,
    ).get()).toEqual({
      template_step_id: "new-clean",
      definition_hash: "new-clean-definition",
      expected_state_hash: "new-clean-state",
      status: "done",
      actualized_at: "2026-07-28T10:05:00.000Z",
    });
    expect(database.prepare(
      "SELECT plan_status FROM run_steps WHERE id = 'run-obsolete'",
    ).get()).toEqual({ plan_status: "superseded" });

    const processingResponse = await worker.fetch(new Request(
      "https://samples.run/api/samples/sample-1?view=processing",
    ), env, {} as ExecutionContext);
    expect(processingResponse.status).toBe(200);
    const processing = await processingResponse.json() as {
      runs: Array<{
        id: string;
        steps: Array<{
          id: string;
          title: string;
          position: number;
          planPosition: number | null;
          status: string;
          planStatus: string;
          plannedTitle: string | null;
          plannedToolName: string | null;
          plannedParametersText: string | null;
          plannedCommentsText: string | null;
          plannedImageKeys: string[];
          comments: Array<{ body: string }>;
        }>;
      }>;
    };
    const steps = processing.runs.find((run) => run.id === "run-1")!.steps;
    const clean = steps.find((step) => step.id === "run-clean")!;
    const preClean = steps.find((step) => step.plannedTitle === "Pre-clean")!;
    const obsolete = steps.find((step) => step.id === "run-obsolete")!;
    expect(clean).toMatchObject({
      title: "Clean",
      position: 1000,
      planPosition: 1,
      plannedTitle: "Clean",
      plannedToolName: "New cleaner",
      plannedParametersText: "New parameters",
      plannedCommentsText: "New note",
      plannedImageKeys: ["imports/new-clean.png"],
    });
    expect(preClean).toMatchObject({
      status: "skipped",
      planPosition: 0,
      plannedTitle: "Pre-clean",
    });
    expect(obsolete).toMatchObject({
      planPosition: null,
      planStatus: "superseded",
    });
    expect(obsolete.comments).toEqual([
      expect.objectContaining({ body: "Keep this observation" }),
    ]);
    database.close();
  });
});
