import { describe, expect, it } from "vitest";
import { MAX_PROJECT_TITLE_LENGTH } from "../shared/project-types";
import { referenceTestDatabase } from "./reference-test-support";

const ACTOR = "unicode-guard@example.com";
const NOW = "2026-08-10T14:00:00.000Z";

type Database = ReturnType<typeof referenceTestDatabase>;

function insertProject(
  database: Database,
  id: string,
  title: string,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO projects (
      id, title, last_mutation_id,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, operationId, ACTOR, ACTOR, NOW, NOW);
}

function insertAttachmentContent(
  database: Database,
  id: string,
  sourceUrl: string,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO project_contents (
      id, project_id, content_type, attachment_caption, attachment_source_url,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'project-safe', 'attachment', NULL, ?, ?, ?, ?, ?, ?)
  `).run(id, sourceUrl, operationId, ACTOR, ACTOR, NOW, NOW);
}

describe("Project Unicode payload persistence contract", () => {
  it("counts Project title ceilings in Unicode code points on insert and update", () => {
    const database = referenceTestDatabase();
    const titleAtLimit = "😀".repeat(MAX_PROJECT_TITLE_LENGTH);
    const titleOverLimit = `${titleAtLimit}😀`;

    insertProject(
      database,
      "project-unicode-limit",
      titleAtLimit,
      "create-project-unicode-limit",
    );
    expect(database.prepare(`
      SELECT title, revision
      FROM projects
      WHERE id = 'project-unicode-limit'
    `).get()).toEqual({ title: titleAtLimit, revision: 1 });

    expect(() => insertProject(
      database,
      "project-unicode-over-limit",
      titleOverLimit,
      "create-project-unicode-over-limit",
    )).toThrow(/between 1 and 200 characters/);

    const replacementAtLimit = "🧪".repeat(MAX_PROJECT_TITLE_LENGTH);
    database.prepare(`
      UPDATE projects
      SET title = ?, revision = 2,
          last_mutation_id = 'rename-project-unicode-limit',
          updated_by = ?, updated_at = ?
      WHERE id = 'project-unicode-limit'
    `).run(replacementAtLimit, ACTOR, NOW);

    expect(() => database.prepare(`
      UPDATE projects
      SET title = ?, revision = 3,
          last_mutation_id = 'rename-project-unicode-over-limit',
          updated_by = ?, updated_at = ?
      WHERE id = 'project-unicode-limit'
    `).run(titleOverLimit, ACTOR, NOW))
      .toThrow(/between 1 and 200 characters/);

    expect(database.prepare(`
      SELECT title, revision, last_mutation_id
      FROM projects
      WHERE id = 'project-unicode-limit'
    `).get()).toEqual({
      title: replacementAtLimit,
      revision: 2,
      last_mutation_id: "rename-project-unicode-limit",
    });
    database.close();
  });

  it("matches ECMAScript title trim semantics on insert and update", () => {
    const database = referenceTestDatabase();
    const untrimmedTitles = [
      "\tTitle",
      "Title\t",
      "\u00A0Title\u00A0",
      "\uFEFFTitle",
      "Title\n",
    ];

    untrimmedTitles.forEach((title, index) => {
      expect(() => insertProject(
        database,
        `project-untrimmed-${index}`,
        title,
        `create-project-untrimmed-${index}`,
      )).toThrow(/title must be trimmed/);
    });

    insertProject(
      database,
      "project-safe",
      "Safe Project",
      "create-project-safe",
    );
    untrimmedTitles.forEach((title, index) => {
      expect(() => database.prepare(`
        UPDATE projects
        SET title = ?, revision = 2,
            last_mutation_id = ?,
            updated_by = ?, updated_at = ?
        WHERE id = 'project-safe'
      `).run(
        title,
        `rename-project-untrimmed-${index}`,
        ACTOR,
        NOW,
      )).toThrow(/title must be trimmed/);
    });

    expect(database.prepare(`
      SELECT title, revision, last_mutation_id
      FROM projects
      WHERE id = 'project-safe'
    `).get()).toEqual({
      title: "Safe Project",
      revision: 1,
      last_mutation_id: "create-project-safe",
    });
    database.close();
  });

  it("matches ECMAScript source-URL trim semantics on insert and update", () => {
    const database = referenceTestDatabase();
    insertProject(
      database,
      "project-safe",
      "Safe Project",
      "create-project-safe",
    );
    const untrimmedUrls = [
      "\thttps://example.test/source",
      "https://example.test/source\t",
      "https://example.test/source\u00A0",
      "\u00A0https://example.test/source",
      "\uFEFFhttps://example.test/source",
    ];

    untrimmedUrls.forEach((sourceUrl, index) => {
      expect(() => insertAttachmentContent(
        database,
        `content-untrimmed-url-${index}`,
        sourceUrl,
        `create-content-untrimmed-url-${index}`,
      )).toThrow(/source URL must use http or https/);
    });

    insertAttachmentContent(
      database,
      "content-safe-url",
      "https://example.test/source",
      "create-content-safe-url",
    );
    untrimmedUrls.forEach((sourceUrl, index) => {
      expect(() => database.prepare(`
        UPDATE project_contents
        SET attachment_source_url = ?, revision = 2,
            last_mutation_id = ?,
            updated_by = ?, updated_at = ?
        WHERE id = 'content-safe-url'
      `).run(
        sourceUrl,
        `update-content-untrimmed-url-${index}`,
        ACTOR,
        NOW,
      )).toThrow(/source URL must use http or https/);
    });

    expect(database.prepare(`
      SELECT attachment_source_url, revision, last_mutation_id
      FROM project_contents
      WHERE id = 'content-safe-url'
    `).get()).toEqual({
      attachment_source_url: "https://example.test/source",
      revision: 1,
      last_mutation_id: "create-content-safe-url",
    });
    database.close();
  });
});
