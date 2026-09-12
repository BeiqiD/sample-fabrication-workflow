import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../shared/project-api";
import { REFERENCE_TARGET_TYPES, type ReferenceTarget } from "../shared/reference-types";
import worker from "./index";
import { createProject, createReferenceProjectItem, removeProjectItem } from "./projects/service";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";
import type { Env } from "./types";

const ACTOR = "scale-user@example.com";
const NOW = "2026-09-12T00:00:00.000Z";
const PROJECT_ID = "project-reference-scale";
const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

async function fixture() {
  const database = referenceTestDatabase();
  const adapter = new SqliteD1Database(database);
  const db = adapter as unknown as D1Database;
  const env = { AUTH_MODE: "disabled", DB: db, ASSETS: {} as R2Bucket } satisfies Env;
  await createProject(db, { id: PROJECT_ID, title: "Reference scale", operationId: "create-scale" }, ACTOR, NOW);
  let revision = 1;
  let itemNumber = 0;
  return {
    database,
    adapter,
    db,
    async append(target: ReferenceTarget) {
      itemNumber += 1;
      const itemId = `item-${itemNumber}`;
      const result = await createReferenceProjectItem(db, PROJECT_ID, {
        itemId,
        placementId: `placement-${itemNumber}`,
        target,
        geometry,
        expectedProjectRevision: revision,
        operationId: `insert-${itemNumber}`,
      }, ACTOR, NOW);
      revision = result.project.revision;
      return itemId;
    },
    async snapshot(includeDeleted = false) {
      const response = await worker.fetch(new Request(
        `https://app.test/api/projects/${PROJECT_ID}${includeDeleted ? "?includeDeleted=1" : ""}`,
      ), env, executionContext);
      const payload = await response.json();
      expect(response.status).toBe(200);
      return payload as ProjectSnapshot;
    },
  };
}

function seedSamples(database: ReturnType<typeof referenceTestDatabase>, count: number): ReferenceTarget[] {
  const statement = database.prepare(`
    INSERT INTO samples (id, code, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `);
  return Array.from({ length: count }, (_, index) => {
    const id = `scale-sample-${String(index + 1).padStart(4, "0")}`;
    statement.run(id, `SCALE-${index + 1}`, `Scale sample ${index + 1}`, NOW, NOW);
    return { type: "sample", id };
  });
}

describe("Project snapshots beyond one Reference resolver batch", () => {
  it.each([200, 201, 500])("reads %i distinct references through the Worker without losing items", async (count) => {
    const f = await fixture();
    try {
      const targets = seedSamples(f.database, count);
      const itemIds: string[] = [];
      for (const target of targets) itemIds.push(await f.append(target));
      f.adapter.resetQueryCount();
      const snapshot = await f.snapshot();
      expect(snapshot.items.map((item) => item.id)).toEqual(itemIds);
      expect(snapshot.placements).toHaveLength(count);
      expect(snapshot.references.map((reference) => reference.resolution.target)).toEqual(targets);
      expect(snapshot.references.every((reference) => reference.resolution.resolution === "resolved")).toBe(true);
      expect(snapshot.references.map((reference) => reference.resolution.source?.title))
        .toEqual(targets.map((_, index) => `Scale sample ${index + 1}`));
      // Source queries scale with bounded batches, not individual occurrences.
      expect(f.adapter.queryCount).toBeLessThanOrEqual(7 + 2 * Math.ceil(count / 200));
    } finally {
      f.database.close();
    }
  });

  it("preserves distinct mixed-type resolutions and repeated Project occurrences across batches", async () => {
    const f = await fixture();
    try {
      seedReferenceGraph(f.database);
      const targets = seedSamples(f.database, 198);
      const mixedTargets: ReferenceTarget[] = [
        { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
        { type: "run", id: REFERENCE_FIXTURE_IDS.runA },
        { type: "run_step", id: REFERENCE_FIXTURE_IDS.stepA },
        { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
        { type: "comment_occurrence", id: REFERENCE_FIXTURE_IDS.commentOccurrenceA },
        { type: "comment_attachment", id: REFERENCE_FIXTURE_IDS.commentAttachment },
        { type: "execution_image", id: REFERENCE_FIXTURE_IDS.executionImage },
        { type: "metrology_reference", id: REFERENCE_FIXTURE_IDS.metrologyReference },
        { type: "recipe_revision", id: REFERENCE_FIXTURE_IDS.recipeRevision },
      ];
      targets.push(...mixedTargets);
      const occurrences = [...targets, targets[0], targets.at(-1)!, mixedTargets[3], targets[0]];
      const itemIds: string[] = [];
      for (const target of occurrences) itemIds.push(await f.append(target));

      const snapshot = await f.snapshot();
      expect(snapshot.items.map((item) => item.id)).toEqual(itemIds);
      expect(snapshot.references).toHaveLength(targets.length);
      expect(new Set(snapshot.references.map((reference) => reference.resolution.target.type)))
        .toEqual(new Set(REFERENCE_TARGET_TYPES));
      const expectedTargets = [...targets].sort((left, right) => {
        const a = `${left.type}\u0000${left.id}`;
        const b = `${right.type}\u0000${right.id}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      expect(snapshot.references.map((reference) => reference.resolution.target)).toEqual(expectedTargets);
      expect(snapshot.references.every((reference) => reference.resolution.resolution === "resolved")).toBe(true);
      const byRegistryId = new Map(snapshot.references.map((reference) => [reference.registryId, reference.resolution]));
      expect(snapshot.items.map((item) => byRegistryId.get(item.referenceTargetId!)?.target)).toEqual(occurrences);
      const common = snapshot.references.find((reference) => reference.resolution.target.type === "comment")!;
      expect(common.resolution.contexts).toHaveLength(2);
    } finally {
      f.database.close();
    }
  });

  it("reads accumulated Trash exceeding the resolver limit even when the active Project is smaller", async () => {
    const f = await fixture();
    try {
      const targets = seedSamples(f.database, 201);
      const itemIds: string[] = [];
      for (const target of targets) itemIds.push(await f.append(target));
      for (const itemId of itemIds.slice(0, 151)) {
        await removeProjectItem(f.db, PROJECT_ID, itemId, {
          expectedItemRevision: 1,
          operationId: `remove-${itemId}`,
        }, ACTOR, NOW);
      }

      const active = await f.snapshot();
      expect(active.items.map((item) => item.id)).toEqual(itemIds.slice(151));
      expect(active.references).toHaveLength(50);
      const withTrash = await f.snapshot(true);
      expect(withTrash.items.map((item) => item.id)).toEqual(itemIds);
      expect(withTrash.references.map((reference) => reference.resolution.target)).toEqual(targets);
      expect(withTrash.items.filter((item) => item.deletedAt)).toHaveLength(151);
      expect(withTrash.references.every((reference) => reference.resolution.resolution === "resolved")).toBe(true);
    } finally {
      f.database.close();
    }
  });
});
