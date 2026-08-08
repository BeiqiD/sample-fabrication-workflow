import { describe, expect, it } from "vitest";
import {
  ReferenceSearchInputError,
  createSqliteSourceReferenceSearchBackend,
  normalizeReferenceSearchInput,
  searchReferences,
} from "./references/search";
import {
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  const d1 = new SqliteD1Database(database);
  const insert = database.prepare(`
    INSERT INTO samples
      (id, code, title, description, status, location, pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'stored', 'Matcher box', 0,
            '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')
  `);
  const addSample = (id: string, code: string, title: string, description: string) => {
    insert.run(id, code, title, description);
  };
  return { database, d1, db: d1 as unknown as D1Database, addSample };
}

describe("reference search matcher and input boundaries", () => {
  it("matches literal backslashes, percent signs, underscores, long tokens, and multibyte text", async () => {
    const { database, db, addSample } = fixture();
    const longToken = "a".repeat(60);
    const multibyteToken = "实验".repeat(30);
    addSample("id\\path", "ESCAPE-ID", "Escaped identity", "literal marker");
    addSample("literal-special", "ESCAPE-TEXT", "Literal matcher", "literal 100%_ready\\path");
    addSample("short-pattern", "SHORT-48", "Short pattern", "a".repeat(48));
    addSample("long-pattern", "LONG-60", "Long pattern", longToken);
    addSample("multibyte-pattern", "WIDE-60", "Multibyte pattern", multibyteToken);

    const escapedId = await searchReferences(db, { query: "id\\path", types: ["sample"] });
    expect(escapedId.results[0]).toMatchObject({
      target: { type: "sample", id: "id\\path" },
      match: { tier: "exact_id" },
    });

    const literal = await searchReferences(db, {
      query: "%_ready\\path",
      types: ["sample"],
    });
    expect(literal.results.map((result) => result.target.id)).toEqual(["literal-special"]);

    const long = await searchReferences(db, { query: longToken, types: ["sample"] });
    expect(long.results.map((result) => result.target.id)).toEqual(["long-pattern"]);

    const multibyte = await searchReferences(db, {
      query: multibyteToken,
      types: ["sample"],
    });
    expect(multibyte.results.map((result) => result.target.id)).toEqual(["multibyte-pattern"]);
    database.close();
  });

  it("uses byte-exact Unicode matching with an ASCII-only case fold", async () => {
    const { database, db, addSample, d1 } = fixture();
    addSample("ÄBC", "UNICODE-ID", "Épitaxy", "Accented exact-case content");
    addSample("unicode-nfd", "UNICODE-NFD", "E\u0301pitaxy", "Decomposed title");

    expect(createSqliteSourceReferenceSearchBackend(d1).kind).toBe("sqlite-source-scan");

    const exactId = await searchReferences(db, { query: "ÄBC", types: ["sample"] });
    expect(exactId.results[0]).toMatchObject({
      target: { id: "ÄBC" },
      match: { tier: "exact_id" },
    });

    const asciiCaseFallback = await searchReferences(db, { query: "Äbc", types: ["sample"] });
    expect(asciiCaseFallback.results[0]).toMatchObject({
      target: { id: "ÄBC" },
      match: { tier: "exact_id" },
    });

    const differentUnicodeCase = await searchReferences(db, { query: "äbc", types: ["sample"] });
    expect(differentUnicodeCase.results.some((result) => result.target.id === "ÄBC")).toBe(false);

    const accentedTitle = await searchReferences(db, { query: "ÉPITAXY", types: ["sample"] });
    expect(accentedTitle.results[0]).toMatchObject({
      target: { id: "ÄBC" },
      match: { tier: "exact_primary" },
    });

    const differentAccentedCase = await searchReferences(db, { query: "épitaxy", types: ["sample"] });
    expect(differentAccentedCase.results.some((result) => result.target.id === "ÄBC")).toBe(false);

    const nfd = await searchReferences(db, { query: "E\u0301PITAXY", types: ["sample"] });
    expect(nfd.results[0]).toMatchObject({
      target: { id: "unicode-nfd" },
      match: { tier: "exact_primary" },
    });

    const nfc = await searchReferences(db, { query: "Épitaxy", types: ["sample"] });
    expect(nfc.results.some((result) => result.target.id === "ÄBC")).toBe(true);
    expect(nfc.results.some((result) => result.target.id === "unicode-nfd")).toBe(false);
    database.close();
  });

  it("accepts only date-only or RFC 3339 timestamps with explicit timezones", () => {
    expect(normalizeReferenceSearchInput({
      query: "reference",
      from: "2026-08-01",
      to: "2026-08-01T02:30:00+02:00",
    })).toMatchObject({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-01T00:30:00.000Z",
    });

    const invalidTimes = [
      "August 1, 2026",
      "2026-02-30",
      "2026-08-01T12:00:00",
      "2026-08-01 12:00:00Z",
      "2026-08-01T24:00:00Z",
      "2026-08-01T12:00:00.1234Z",
      "2026-08-01T12:00:00+24:00",
    ];
    for (const from of invalidTimes) {
      expect(() => normalizeReferenceSearchInput({ query: "reference", from }))
        .toThrow(ReferenceSearchInputError);
    }
  });
});
