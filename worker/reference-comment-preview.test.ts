import { describe, expect, it } from "vitest";
import { resolveReferences } from "./references/resolver";
import { REFERENCE_FIXTURE_IDS, referenceTestDatabase, seedReferenceGraph, SqliteD1Database } from "./reference-test-support";

describe("resolved Comment reference preview contracts", () => {
  it("preserves bounded Markdown for both Comment identities while leaving other sources plain", async () => {
    const database = referenceTestDatabase();
    try {
      seedReferenceGraph(database);
      const body = String.raw`# Diffusion check

$L=\sqrt{2Dt}$.

$$
D=D_0 e^{-E_a/(k_B T)}
$$`;
      database.prepare("UPDATE comment_submissions SET body = ? WHERE id = ?").run(body, REFERENCE_FIXTURE_IDS.comment);
      const results = await resolveReferences(new SqliteD1Database(database) as unknown as D1Database, [
        { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
        { type: "comment_occurrence", id: REFERENCE_FIXTURE_IDS.commentOccurrenceA },
        { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
      ]);
      for (const result of results.slice(0, 2)) {
        expect(result.source).toMatchObject({ title: "Diffusion check", excerpt: body, excerptFormat: "markdown" });
        expect(result.destination.referenceUrl).toContain("/references/");
        expect(result.destination.contextOpenSourceUrls.some(Boolean)).toBe(true);
      }
      expect(results[2].source?.excerptFormat).toBeUndefined();
    } finally { database.close(); }
  });

  it("does not expose a split long formula or grow the summary into a full-body payload", async () => {
    const database = referenceTestDatabase();
    try {
      seedReferenceGraph(database);
      const body = `Diffusion check.\n\n$$\nx=1\n\n${"a + ".repeat(100)}z\n$$`;
      database.prepare("UPDATE comment_submissions SET body = ? WHERE id = ?").run(body, REFERENCE_FIXTURE_IDS.comment);
      const [result] = await resolveReferences(new SqliteD1Database(database) as unknown as D1Database, [
        { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
      ]);
      expect(result.source?.excerpt).toBe("Diffusion check.");
      expect(result.source?.excerptFormat).toBe("markdown");
      expect(JSON.stringify(result)).not.toContain("a + a + a +");
      expect(result.destination.referenceUrl).toContain("/references/");
      expect(result.destination.contextOpenSourceUrls.some(Boolean)).toBe(true);
    } finally { database.close(); }
  });
});
