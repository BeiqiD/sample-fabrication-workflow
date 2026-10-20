import { describe, expect, it } from "vitest";
import {
  createProject,
  removeProjectItem,
} from "./projects/service";
import {
  referenceTestDatabase,
  SqliteD1Database,
} from "./reference-test-support";

const ACTOR = "placement-user@example.com";
const NOW = "2026-08-10T00:00:00.000Z";

describe("Project authoritative placement requirement", () => {
  it("rejects lifecycle mutation of a malformed item before committing any row", async () => {
    const database = referenceTestDatabase();
    const db = new SqliteD1Database(database) as unknown as D1Database;
    await createProject(db, {
      id: "project-placement",
      title: "Placement Project",
      operationId: "create-project-placement",
    }, ACTOR, NOW);
    database.prepare(`
      INSERT INTO project_contents (
        id, project_id, content_type, markdown_source,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'content-without-placement', 'project-placement', 'markdown', '# malformed',
        1, 'create-content-without-placement', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW);
    database.prepare(`
      INSERT INTO project_items (
        id, project_id, item_type, project_content_id, created_sequence,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'item-without-placement', 'project-placement', 'content',
        'content-without-placement', 1,
        1, 'create-item-without-placement', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW);

    await expect(removeProjectItem(db, "project-placement", "item-without-placement", {
      expectedItemRevision: 1,
      expectedContentRevision: 1,
      operationId: "remove-item-without-placement",
    }, ACTOR, "2026-08-10T00:01:00.000Z")).rejects.toMatchObject({
      code: "conflict",
      message: "Project item is missing its authoritative placement",
    });

    expect(database.prepare(`
      SELECT deleted_at, revision
      FROM project_items WHERE id = 'item-without-placement'
    `).get()).toEqual({ deleted_at: null, revision: 1 });
    expect(database.prepare(`
      SELECT deleted_at, revision
      FROM project_contents WHERE id = 'content-without-placement'
    `).get()).toEqual({ deleted_at: null, revision: 1 });
    database.close();
  });
});
