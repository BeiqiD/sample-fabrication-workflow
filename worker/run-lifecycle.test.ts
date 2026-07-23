import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ACTIVATE_SAMPLE_FOR_RUN_SQL } from "./run-lifecycle";

const migration = readFileSync(new URL("../migrations/0001_alpha_state_chain.sql", import.meta.url), "utf8");

function createSample(status: "active" | "stored" | "consumed" | "lost") {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
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
