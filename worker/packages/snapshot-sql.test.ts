import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { packageUnionAllCtes } from "./snapshot-sql";

it.each([false, true])("preserves the closed UNION ALL rows, NULLs and duplicate identities with all leaves populated=%s", populated => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE occurrences(branch INTEGER,kind TEXT,id TEXT,file_id TEXT,purpose TEXT)");
    const insert = db.prepare("INSERT INTO occurrences VALUES(?,?,?,?,?)");
    for (let branch = 0; branch < 34; branch++) if (populated || branch % 2 === 0) {
      insert.run(branch, branch < 2 ? "event" : "fileAlias", "shared-identity", branch % 3 ? "file" : null, branch % 2 ? "embedded_content" : null);
    }
    // Identical occurrences within one leaf must survive too. Presence is its
    // ordinal, even when the File and expected purpose are both NULL.
    insert.run(0, "event", "shared-identity", null, null);
    const columns = ["kind", "id", "file_id", "purpose"], leaves = Array.from({ length: 34 }, (_, branch) =>
      `SELECT ${columns.join(",")} FROM occurrences WHERE branch=${branch}`);
    const canonical = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
    const actual = db.prepare(`WITH ${packageUnionAllCtes("captured", columns, leaves)} SELECT * FROM captured`).all();
    const expected = db.prepare(leaves.join(" UNION ALL ")).all();
    expect(canonical(actual)).toEqual(canonical(expected));
    expect(actual.filter(row => row.kind === "event" && row.file_id === null && row.purpose === null)).toHaveLength(2);
    db.exec("DELETE FROM occurrences");
    expect(db.prepare(`WITH ${packageUnionAllCtes("captured", columns, leaves)} SELECT * FROM captured`).all()).toEqual([]);
  } finally { db.close(); }
});

it("keeps correlated scalar and ordered array relationships local to each Event", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE events(id TEXT,metadata_json TEXT)");
    const insert = db.prepare("INSERT INTO events VALUES(?,?)");
    insert.run("one", JSON.stringify({ runId: "run-one", stepIds: ["first", "first", "last"] }));
    insert.run("two", JSON.stringify({ runId: "run-two", stepIds: ["other"] }));
    insert.run("three", JSON.stringify({ runId: 1, stepIds: [1, "valid"] }));
    const leaves = [
      "SELECT 'runId' field,'run' kind,json_extract(s.metadata_json,'$.runId') id WHERE json_type(s.metadata_json,'$.runId')='text'",
      "SELECT 'stepIds['||j.key||']','runStep',j.value FROM json_each(s.metadata_json,'$.stepIds') j WHERE j.type='text'",
    ];
    const aggregate = (from: string) => `SELECT json_group_array(json_object('field',field,'kind',kind,'id',id)) FROM ${from}`;
    const actual = db.prepare(`SELECT id,(WITH ${packageUnionAllCtes("relationships", ["field", "kind", "id"], leaves)}
      ${aggregate("relationships")}) relationships FROM events s ORDER BY id`).all();
    const expected = db.prepare(`SELECT id,(${aggregate(`(${leaves.join(" UNION ALL ")})`)}) relationships FROM events s ORDER BY id`).all();
    expect(actual).toEqual(expected);
    expect(JSON.parse(String(actual[0].relationships)).filter((row: { field: string }) => row.field.startsWith("stepIds")))
      .toEqual([{ field: "stepIds[0]", kind: "runStep", id: "first" }, { field: "stepIds[1]", kind: "runStep", id: "first" },
        { field: "stepIds[2]", kind: "runStep", id: "last" }]);
  } finally { db.close(); }
});
