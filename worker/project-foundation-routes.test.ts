import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { PROJECT_EXPORT_SCHEMA_VERSION } from "../shared/project-types";
import {
  PROJECT_EXPORT_TABLE_QUERIES,
} from "./project-foundation-routes";
import { routes as referenceRoutes } from "./reference-routes";
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

describe("Project foundation export route", () => {
  it("wins before the legacy handler and snapshots every current table in one batch", async () => {
    const app = new Hono<AppBindings>();
    app.route("/", referenceRoutes);
    app.get("/exports/all", (c) => c.json({ legacy: true }, 599));
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

  it("keeps every legacy export table while adding the Project tables", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const block = source.match(
      /app\.get\("\/exports\/all"[\s\S]*?const tableQueries = \{([\s\S]*?)\n  \} as const;/,
    )?.[1];
    expect(block).toBeDefined();
    const legacyNames = [...block!.matchAll(/^    ([a-z_]+):/gm)].map((match) => match[1]);
    expect(legacyNames.length).toBeGreaterThan(20);
    expect(Object.keys(PROJECT_EXPORT_TABLE_QUERIES)).toEqual(expect.arrayContaining(legacyNames));
    expect(Object.keys(PROJECT_EXPORT_TABLE_QUERIES)).toEqual(expect.arrayContaining([
      "projects",
      "project_contents",
      "project_content_attachments",
      "project_items",
      "project_map_placements",
      "project_edges",
    ]));
  });
});
