import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { FULL_EXPORT_ARCHIVE_SCHEMA } from "../shared/contracts/export";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import {
  FULL_EXPORT_TABLE_QUERIES,
} from "./export-catalog";
import { snapshotRoutes } from "./export-routes";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

function exportEnvironment() {
  const database = referenceTestDatabase();
  const d1 = new SqliteD1Database(database);
  const batch = vi.spyOn(d1, "batch");
  return { env: { DB: d1 } as unknown as Env, batch, database };
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

describe("Full export route", () => {
  it("owns complete export and snapshots every current table in one batch", async () => {
    expect(FULL_EXPORT_ARCHIVE_SCHEMA).toBe(8);
    const app = new Hono<AppBindings>();
    app.route("/", snapshotRoutes);
    const { env, batch, database } = exportEnvironment();

    const response = await app.request("/exports/all?archiveSchema=8&archiveWriter=1", {}, env);
    const body = await response.json<{
      schemaVersion: number;
      tables: Record<string, Array<Record<string, unknown>>>;
      blobs: unknown[];
    }>();

    expect(response.status).toBe(200);
    expect(body.schemaVersion).toBe(FULL_EXPORT_ARCHIVE_SCHEMA);
    expect(Object.keys(body.tables)).toEqual(Object.keys(FULL_EXPORT_TABLE_QUERIES));
    for (const name of ["attachment_derivatives", "projects", "project_contents", "project_content_attachments", "project_items", "project_map_placements", "project_edges"]) expect(body.tables[name]).toEqual([]);
    expect(body.blobs).toEqual([]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(Object.keys(FULL_EXPORT_TABLE_QUERIES).length + 3);
    database.close();
  });

  it("keeps every pre-Project export table while adding all Project tables", () => {
    expect(Object.keys(FULL_EXPORT_TABLE_QUERIES)).toEqual(
      expect.arrayContaining([...PRE_PROJECT_EXPORT_TABLES]),
    );
    expect(Object.keys(FULL_EXPORT_TABLE_QUERIES)).toEqual(expect.arrayContaining([
      "projects",
      "project_contents",
      "project_content_attachments",
      "project_items",
      "project_map_placements",
      "project_edges",
    ]));
  });

  it("mounts Export and Project directly in core and leaves the Reference aggregate independent", () => {
    const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const referenceSource = readFileSync(
      new URL("./reference-routes.ts", import.meta.url),
      "utf8",
    );

    expect(indexSource).toContain(
      'import { routes as projectRoutes } from "./project-routes";',
    );
    const foundationMount = indexSource.indexOf('app.route("/", projectFoundationRoutes);');
    const exportMount = indexSource.indexOf('app.route("/", exportSnapshotRoutes);');
    const projectMount = indexSource.indexOf('app.route("/", projectRoutes);');
    const referenceMount = indexSource.indexOf('app.route("/", referenceRoutes);');
    expect(foundationMount).toBeGreaterThan(-1);
    expect(exportMount).toBeGreaterThan(foundationMount);
    expect(projectMount).toBeGreaterThan(exportMount);
    expect(referenceMount).toBeGreaterThan(projectMount);
    expect(indexSource).not.toMatch(/app\.get\("\/exports\/all"/);
    expect(referenceSource).not.toContain("./project-routes");
    expect(referenceSource).not.toContain("projectRoutes");
  });
});
