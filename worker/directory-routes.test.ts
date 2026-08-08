import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./types";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, values);
  }

  async all<T>() {
    return {
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      success: true,
      meta: { changes: 0 },
    };
  }

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

function testDatabase() {
  const database = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
  return database;
}

function seedDirectory(database: DatabaseSync) {
  const insertSample = database.prepare(
    `INSERT INTO samples
      (id, code, title, status, location, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let index = 1; index <= 125; index += 1) {
    const id = `sample-${String(index).padStart(3, "0")}`;
    const timestamp = `2026-07-${String((index % 24) + 1).padStart(2, "0")}T10:00:00.000Z`;
    insertSample.run(
      id,
      `PERF-${String(index).padStart(3, "0")}`,
      index === 78 ? "AFM calibration wafer" : `Performance sample ${index}`,
      index <= 30 ? "active" : "stored",
      `Box ${Math.ceil(index / 10)}`,
      index <= 2 ? 1 : 0,
      timestamp,
      timestamp,
    );
  }
  database.prepare("UPDATE samples SET parent_id = 'sample-001' WHERE id IN ('sample-002', 'sample-003')").run();

  database.prepare(
    `INSERT INTO step_definitions
      (hash, name, canonical_json, created_at)
     VALUES ('directory-step', 'Etch', '{}', '2026-07-01T00:00:00.000Z')`,
  ).run();
  const insertFamily = database.prepare(
    `INSERT INTO recipe_families (id, name, template_type, created_at)
     VALUES (?, ?, 'process', '2026-07-01T00:00:00.000Z')`,
  );
  const insertVersion = database.prepare(
    `INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at, template_kind)
     VALUES (?, ?, ?, 'process', ?, ?, ?, ?, 'process')`,
  );
  const insertStep = database.prepare(
    `INSERT INTO template_steps
      (id, template_version_id, logical_step_key, position, definition_hash, raw_json)
     VALUES (?, ?, ?, 0, 'directory-step', '{}')`,
  );
  for (let family = 1; family <= 25; family += 1) {
    const familyId = `process-family-${family}`;
    const name = family === 14 ? "AFM surface preparation" : `Process family ${String(family).padStart(2, "0")}`;
    insertFamily.run(familyId, name);
    for (let version = 1; version <= 2; version += 1) {
      const versionId = `${familyId}-v${version}`;
      insertVersion.run(
        versionId,
        familyId,
        name,
        version,
        `${familyId}-manifest-${version}`,
        JSON.stringify({ initialSubstrateStep: { stepNumber: "0", name: "Substrate Stack" } }),
        `2026-07-${String(version).padStart(2, "0")}T00:00:00.000Z`,
      );
      insertStep.run(`${versionId}-step`, versionId, `${familyId}:step`);
    }
  }
  database.exec(`
    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES ('metrology-family-afm', 'AFM family', 'module', '2026-07-01T00:00:00.000Z');
    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash, content_json,
       created_at, template_kind)
    VALUES
      ('metrology-template-afm', 'metrology-family-afm', 'AFM', 'module', 1,
       'metrology-afm-manifest', '{}', '2026-07-01T00:00:00.000Z', 'metrology');
    INSERT INTO template_steps
      (id, template_version_id, logical_step_key, position, definition_hash, raw_json)
    VALUES
      ('metrology-template-afm-step', 'metrology-template-afm', 'metrology:afm', 0,
       'directory-step', '{}');
  `);

  const runFamily = "process-family-1";
  const runTemplate = `${runFamily}-v2`;
  const insertRun = database.prepare(
    `INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
       template_name_snapshot, template_type_snapshot, template_version_snapshot,
       status, created_at, run_kind)
     VALUES (?, ?, ?, ?, 1, ?, 'Process family 01', 'process', 2, ?, '2026-07-24T10:00:00.000Z', 'process')`,
  );
  for (let index = 1; index <= 25; index += 1) {
    const status = index <= 10 ? "active" : index <= 18 ? "complete" : "cancelled";
    const runId = `run-${index}`;
    insertRun.run(runId, `sample-${String(index <= 10 ? index : index + 20).padStart(3, "0")}`, runFamily, runTemplate, runId, status);
  }
}

function testEnv(database: DatabaseSync): Env {
  return {
    AUTH_MODE: "disabled",
    DB: {
      prepare: (sql: string) => new SqliteD1Statement(database, sql),
    } as unknown as D1Database,
    ASSETS: {} as R2Bucket,
  };
}

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

async function get(env: Env, path: string) {
  return worker.fetch(new Request(`https://app.test${path}`), env, executionContext);
}

describe("paginated directory routes", () => {
  it("paginates lightweight sample rows with stable totals and timing", async () => {
    const database = testDatabase();
    seedDirectory(database);
    const response = await get(testEnv(database), "/api/samples?page=2&pageSize=50");
    const payload = await response.json() as {
      samples: Array<{ code: string; currentStateThumbnailKey: string | null }>;
      pagination: { page: number; pageSize: number; total: number; totalPages: number };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toMatch(/d1;dur=.*serialize;dur=/);
    expect(payload.pagination).toEqual({ page: 2, pageSize: 50, total: 125, totalPages: 3 });
    expect(payload.samples).toHaveLength(50);
    expect(payload.samples.every((sample) => sample.currentStateThumbnailKey === null)).toBe(true);
  });

  it("puts active samples first by default, then preserves pinned and recent ordering inside each tier", async () => {
    const database = testDatabase();
    seedDirectory(database);
    database.prepare(
      "UPDATE samples SET pinned = 1, updated_at = '2026-08-01T10:00:00.000Z' WHERE id = 'sample-125'",
    ).run();
    const response = await get(testEnv(database), "/api/samples?pageSize=50");
    const payload = await response.json() as {
      samples: Array<{ code: string; status: string; pinned: boolean }>;
    };

    expect(payload.samples.slice(0, 30).every((sample) => sample.status === "active")).toBe(true);
    expect(payload.samples[30]).toMatchObject({ code: "PERF-125", status: "stored", pinned: true });
  });

  it("filters processing on the server and returns full-query facets", async () => {
    const database = testDatabase();
    seedDirectory(database);
    const response = await get(testEnv(database), "/api/samples?view=processing&status=complete&pageSize=5");
    const payload = await response.json() as {
      samples: Array<{ latestRunStatus: string }>;
      pagination: { total: number; totalPages: number };
      facets: { active: number; complete: number; cancelled: number; all: number };
    };

    expect(payload.samples).toHaveLength(5);
    expect(payload.samples.every((sample) => sample.latestRunStatus === "complete")).toBe(true);
    expect(payload.pagination).toMatchObject({ total: 8, totalPages: 2 });
    expect(payload.facets).toEqual({ active: 30, complete: 8, cancelled: 7, all: 125 });
  });

  it("limits the process workspace picker to samples with an active run in the same process family", async () => {
    const database = testDatabase();
    seedDirectory(database);
    database.prepare(
      "UPDATE runs SET template_version_id = 'process-family-1-v1', template_version_snapshot = 1 WHERE id = 'run-10'",
    ).run();

    const response = await get(
      testEnv(database),
      "/api/samples?runFamily=process-family-1&runKind=process&runStatus=active&pageSize=20",
    );
    const payload = await response.json() as {
      samples: Array<{ code: string; latestWorkflowVersion: number; latestRunStatus: string }>;
      pagination: { total: number };
    };

    expect(response.status).toBe(200);
    expect(payload.pagination.total).toBe(10);
    expect(payload.samples.every((sample) => sample.latestRunStatus === "active")).toBe(true);
    expect(payload.samples.some((sample) => sample.latestWorkflowVersion === 1)).toBe(true);
  });

  it("combines sample search, filters, and explicit sorting on the server", async () => {
    const database = testDatabase();
    seedDirectory(database);
    const response = await get(
      testEnv(database),
      "/api/samples?q=Performance&status=stored&location=Box%2012&sort=created-desc&pageSize=5",
    );
    const payload = await response.json() as {
      samples: Array<{ code: string; status: string; location: string; createdAt: string }>;
      pagination: { total: number };
    };

    expect(response.status).toBe(200);
    expect(payload.pagination.total).toBe(10);
    expect(payload.samples).toHaveLength(5);
    expect(payload.samples.every((sample) => sample.status === "stored" && sample.location === "Box 12")).toBe(true);
    expect(payload.samples[0]).toMatchObject({
      code: "PERF-119",
      createdAt: "2026-07-24T10:00:00.000Z",
    });

    const relevanceResponse = await get(testEnv(database), "/api/samples?q=AFM");
    const relevancePayload = await relevanceResponse.json() as {
      samples: Array<{ code: string; title: string }>;
      pagination: { total: number };
    };
    expect(relevanceResponse.status).toBe(200);
    expect(relevancePayload.pagination.total).toBe(1);
    expect(relevancePayload.samples[0]).toMatchObject({ code: "PERF-078", title: "AFM calibration wafer" });
  });

  it("filters by parent and latest process text and exposes reusable suggestions", async () => {
    const database = testDatabase();
    seedDirectory(database);
    const env = testEnv(database);
    const parentPayload = await (await get(env, "/api/samples?parent=PERF-001")).json() as {
      samples: Array<{ code: string }>;
      pagination: { total: number };
    };
    const workflowPayload = await (await get(env, "/api/samples?process=family%2001")).json() as {
      pagination: { total: number };
    };
    const optionsResponse = await get(env, "/api/sample-directory-options");
    const options = await optionsResponse.json() as {
      locations: string[];
      parents: Array<{ code: string; title: string }>;
      workflows: string[];
    };

    expect(parentPayload.pagination.total).toBe(2);
    expect(parentPayload.samples.map((sample) => sample.code)).toEqual(["PERF-002", "PERF-003"]);
    expect(workflowPayload.pagination.total).toBe(25);
    expect(optionsResponse.headers.get("server-timing")).toContain("d1;dur=");
    expect(options.locations).toContain("Box 12");
    expect(options.parents).toContainEqual({ id: "sample-001", code: "PERF-001", title: "Performance sample 1" });
    expect(options.workflows).toEqual(["Process family 01"]);
  });

  it("paginates process families, lazy-loads versions, and searches both template kinds", async () => {
    const database = testDatabase();
    seedDirectory(database);
    const env = testEnv(database);
    const familyResponse = await get(env, "/api/template-families?page=2&pageSize=20");
    const familyPayload = await familyResponse.json() as {
      families: Array<{ recipeFamilyId: string; versionCount: number; latest: { version: number } }>;
      pagination: { total: number; totalPages: number };
    };
    const versionsResponse = await get(env, "/api/template-families/process-family-1/versions");
    const versionsPayload = await versionsResponse.json() as { versions: Array<{ version: number }> };
    const processSearch = await (await get(env, "/api/template-families?q=AFM")).json() as { pagination: { total: number } };
    const metrologySearch = await (await get(env, "/api/metrology-templates?q=AFM&pageSize=2")).json() as {
      templates: Array<{ name: string }>;
      pagination: { total: number };
    };

    expect(familyResponse.headers.get("server-timing")).toContain("d1;dur=");
    expect(familyPayload.pagination).toEqual({ page: 2, pageSize: 20, total: 25, totalPages: 2 });
    expect(familyPayload.families).toHaveLength(5);
    expect(familyPayload.families.every((family) => family.versionCount === 2 && family.latest.version === 2)).toBe(true);
    expect(versionsPayload.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(processSearch.pagination.total).toBe(1);
    expect(metrologySearch.pagination.total).toBe(1);
    expect(metrologySearch.templates[0]?.name).toBe("AFM");
  });
});
