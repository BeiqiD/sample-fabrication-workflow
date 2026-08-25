import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { PROJECT_EXPORT_SCHEMA_VERSION } from "../shared/project-types";
import {
  PROJECT_EXPORT_TABLE_QUERIES,
} from "./project-foundation-routes";
import { routes as projectRoutes } from "./project-routes";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

type Statement = { sql: string };

function exportEnvironment() {
  const queryNames = new Map(
    Object.entries(PROJECT_EXPORT_TABLE_QUERIES).map(([name, sql]) => [sql, name]),
  );
  const batch = vi.fn(async (statements: Statement[]) => statements.map((statement) => ({
    success: true,
    results: [{ table: queryNames.get(statement.sql) }],
    meta: {},
  })));
  const database = {
    prepare(sql: string) {
      return { sql };
    },
    batch,
  } as unknown as D1Database;
  return { env: { DB: database } as Env, batch };
}

const PRE_PROJECT_EXPORT_TABLES = [
  "samples",
  "events",
  "recipe_families",
  "step_definitions",
  "state_representations",
  "state_representation_assets",
  "template_versions",
  "template_steps",
  "metrology_template_references",
  "runs",
  "run_plan_revisions",
  "run_steps",
  "run_step_plan_links",
  "run_step_comments",
  "run_step_assets",
  "state_verifications",
  "state_verification_steps",
  "recipe_change_proposals",
  "imports",
  "assets",
  "attachment_derivatives",
  "comment_submissions",
  "comment_submission_targets",
  "comment_submission_items",
  "managed_storage_objects",
  "reference_targets",
  "blob_gc_ledger",
  "blob_integrity_quarantine",
  "blob_retention_edges",
] as const;

describe("Project foundation export route", () => {
  it("owns complete export and snapshots every current table in one batch", async () => {
    expect(PROJECT_EXPORT_SCHEMA_VERSION).toBe(7);
    const app = new Hono<AppBindings>();
    app.route("/", projectRoutes);
    const { env, batch } = exportEnvironment();

    const response = await app.request("/exports/all", {}, env);
    const body = await response.json<{
      schemaVersion: number;
      tables: Record<string, Array<Record<string, unknown>>>;
      blobs: unknown[];
    }>();

    expect(response.status).toBe(200);
    expect(body.schemaVersion).toBe(PROJECT_EXPORT_SCHEMA_VERSION);
    expect(Object.keys(body.tables)).toEqual(Object.keys(PROJECT_EXPORT_TABLE_QUERIES));
    expect(body.tables.attachment_derivatives).toEqual([
      { table: "attachment_derivatives" },
    ]);
    expect(body.tables.projects).toEqual([{ table: "projects" }]);
    expect(body.tables.project_contents).toEqual([{ table: "project_contents" }]);
    expect(body.tables.project_content_attachments).toEqual([
      { table: "project_content_attachments" },
    ]);
    expect(body.tables.project_items).toEqual([{ table: "project_items" }]);
    expect(body.tables.project_map_placements).toEqual([
      { table: "project_map_placements" },
    ]);
    expect(body.tables.project_edges).toEqual([{ table: "project_edges" }]);
    expect(body.blobs).toEqual([]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(Object.keys(PROJECT_EXPORT_TABLE_QUERIES).length);
  });

  it("keeps every pre-Project export table while adding all Project tables", () => {
    expect(Object.keys(PROJECT_EXPORT_TABLE_QUERIES)).toEqual(
      expect.arrayContaining([...PRE_PROJECT_EXPORT_TABLES]),
    );
    expect(Object.keys(PROJECT_EXPORT_TABLE_QUERIES)).toEqual(expect.arrayContaining([
      "projects",
      "project_contents",
      "project_content_attachments",
      "project_items",
      "project_map_placements",
      "project_edges",
    ]));
  });

  it("mounts Project directly in core and leaves the Reference aggregate independent", () => {
    const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const referenceSource = readFileSync(
      new URL("./reference-routes.ts", import.meta.url),
      "utf8",
    );

    expect(indexSource).toContain(
      'import { routes as projectRoutes } from "./project-routes";',
    );
    const projectMount = indexSource.indexOf('app.route("/", projectRoutes);');
    const referenceMount = indexSource.indexOf('app.route("/", referenceRoutes);');
    expect(projectMount).toBeGreaterThan(-1);
    expect(referenceMount).toBeGreaterThan(projectMount);
    expect(indexSource).not.toMatch(/app\.get\("\/exports\/all"/);
    expect(referenceSource).not.toContain("./project-routes");
    expect(referenceSource).not.toContain("projectRoutes");
  });
});
