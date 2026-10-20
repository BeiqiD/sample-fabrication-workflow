import { describe, expect, it } from "vitest";
import { hashStateRepresentation, sha256Hex, stableJson, STATE_HASH_SCHEME } from "../shared/content-addressing";
import type { SampleDetail } from "../shared/types";
import worker from "./index";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const NOW = "2026-09-13T00:00:00.000Z";
const PARENT_ID = "split-parent";
const FINISHED_STATE = "split-finished-state";
const IMAGE_KEY = "synthetic/split-finished.png";
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

function fixture() {
  const database = referenceTestDatabase();
  database.exec(`
    INSERT INTO state_representations (hash, content_json, created_at) VALUES
      ('split-inherited-state', '{}', '${NOW}'),
      ('split-initial-state', '{}', '${NOW}'),
      ('${FINISHED_STATE}', '{}', '${NOW}');
    INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('split-state-image', '${IMAGE_KEY}', 'finished.png', 'image/png', 11, 'ready', '${"a".repeat(64)}', '${NOW}');
    INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('${FINISHED_STATE}', 'split-state-image', 0);
    INSERT INTO samples (id, code, title, status, inherited_state_hash, created_at, updated_at)
      VALUES ('${PARENT_ID}', 'SPLIT-P', 'Synthetic split parent', 'stored', 'split-inherited-state', '${NOW}', '${NOW}');
    INSERT INTO recipe_families (id, name, template_type, created_at)
      VALUES ('split-family', 'Split process', 'process', '${NOW}');
    INSERT INTO template_versions (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at)
      VALUES ('split-template', 'split-family', 'Split process', 'process', 1, 'split-manifest', '{}', '${NOW}');
    INSERT INTO step_definitions (hash, name, canonical_json, created_at)
      VALUES ('split-definition', 'Completed preparation', '{}', '${NOW}');
    INSERT INTO runs (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
      template_name_snapshot, template_type_snapshot, template_version_snapshot, status, created_at, initial_state_hash)
      VALUES ('split-run', '${PARENT_ID}', 'split-family', 'split-template', 1, 'split-group',
        'Split process', 'process', 1, 'complete', '${NOW}', 'split-initial-state');
    INSERT INTO run_steps (id, run_id, position, origin, plan_status, definition_hash, title,
      status, entry_kind, expected_state_hash, created_at, updated_at)
      VALUES ('split-finished-step', 'split-run', 0, 'template', 'current', 'split-definition',
        'Completed preparation', 'done', 'fabrication', '${FINISHED_STATE}', '${NOW}', '${NOW}');
  `);
  const env = {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {} as R2Bucket,
  } satisfies Env;
  const pieces = [
    { code: " SPLIT-A ", title: " First piece ", description: " First description ", status: "stored", location: " Box A " },
    { code: "SPLIT-B", title: "Second piece", status: "active", location: "Box B" },
  ];
  return {
    database,
    env,
    split(expectedUpdatedAt = NOW, suffix = "") {
      return worker.fetch(new Request(`https://app.test/api/samples/${PARENT_ID}/split`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt, parentStatusAfter: "consumed", pieces: pieces.map(piece => ({ ...piece, code: piece.code.trim() + suffix })) }),
      }), env, context);
    },
    async detail(id: string) {
      const response = await worker.fetch(new Request(`https://app.test/api/samples/${id}`), env, context);
      expect(response.status).toBe(200);
      return response.json() as Promise<SampleDetail>;
    },
  };
}

describe("Sample split route characterization", () => {
  it("inherits the completed process structure instead of the parent's inherited or initial state", async () => {
    const f = fixture();
    try {
      const response = await f.split();
      expect(response.status).toBe(201);
      const result = await response.json() as { children: Array<{ id: string; code: string }>; updatedAt: string };
      expect(result.children.map((child) => child.code)).toEqual(["SPLIT-A", "SPLIT-B"]);
      expect(new Set(result.children.map((child) => child.id)).size).toBe(2);
      const parent = await f.detail(PARENT_ID);
      expect(parent).toMatchObject({ status: "consumed", updatedAt: result.updatedAt, currentStateThumbnailKey: IMAGE_KEY });
      expect(parent.children.map((child) => child.id).sort()).toEqual(result.children.map((child) => child.id).sort());
      expect(parent.runs[0].steps[0]).toMatchObject({ id: "split-finished-step", status: "done", expectedStateHash: FINISHED_STATE });
      for (const [index, child] of result.children.entries()) {
        const detail = await f.detail(child.id);
        expect(detail).toMatchObject({
          id: child.id, code: child.code, parentId: PARENT_ID, inheritedStateHash: FINISHED_STATE,
          currentStateThumbnailKey: IMAGE_KEY, parent: { id: PARENT_ID, code: "SPLIT-P" },
          status: index === 0 ? "stored" : "active", runs: [], children: [],
        });
        expect(detail.events.some((event) => event.kind === "created")).toBe(true);
      }
      const first = await f.detail(result.children[0].id);
      expect(first).toMatchObject({ title: "First piece", description: "First description", location: "Box A" });
      expect(f.database.prepare("SELECT inherited_state_hash FROM samples WHERE id = ?").get(PARENT_ID))
        .toEqual({ inherited_state_hash: "split-inherited-state" });
    } finally {
      f.database.close();
    }
  });

  it("rejects a stale parent revision without changing samples, structures, or audit events", async () => {
    const f = fixture();
    try {
      const before = {
        samples: f.database.prepare("SELECT * FROM samples ORDER BY id").all(),
        states: f.database.prepare("SELECT * FROM state_representations ORDER BY hash").all(),
        events: f.database.prepare("SELECT * FROM events ORDER BY id").all(),
      };
      const response = await f.split("2000-01-01T00:00:00.000Z");
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "This sample changed elsewhere. Reload it before splitting." });
      expect(f.database.prepare("SELECT * FROM samples ORDER BY id").all()).toEqual(before.samples);
      expect(f.database.prepare("SELECT * FROM state_representations ORDER BY hash").all()).toEqual(before.states);
      expect(f.database.prepare("SELECT * FROM events ORDER BY id").all()).toEqual(before.events);
      const parent = await f.detail(PARENT_ID);
      expect(parent).toMatchObject({ status: "stored", inheritedStateHash: "split-inherited-state", currentStateThumbnailKey: IMAGE_KEY, children: [] });
    } finally {
      f.database.close();
    }
  });
});

async function withExecutionImages(f: ReturnType<typeof fixture>) {
  const images = await Promise.all([5, 2].map(async (position, index) => {
    const body = `synthetic-execution-image-${index}`;
    return { id: `actual-image-${index}`, key: `synthetic/actual-${index}.png`, position, body, sha256: await sha256Hex(body) };
  }));
  for (const image of images) {
    f.database.prepare(`INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES (?, ?, ?, 'image/png', ?, 'ready', ?, ?)`)
      .run(image.id, image.key, `${image.id}.png`, image.body.length, image.sha256, NOW);
    f.database.prepare(`INSERT INTO run_step_assets (id, run_step_id, asset_id, role, position, created_at)
      VALUES (?, 'split-finished-step', ?, 'execution', ?, ?)`)
      .run(`occurrence-${image.id}`, image.id, image.position, NOW);
  }
  f.env.ASSETS = {
    async get(key: string) {
      const image = images.find((candidate) => candidate.key === key);
      return image ? {
        body: new TextEncoder().encode(image.body), httpEtag: `"${image.sha256}"`,
        writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); },
      } : null;
    },
  } as unknown as R2Bucket;
  const ordered = [...images].sort((a, b) => a.position - b.position);
  return { images: ordered, state: await hashStateRepresentation(ordered.map((image) => image.sha256)) };
}

function beforeNextBatch(f: ReturnType<typeof fixture>, mutate: () => void) {
  const original = f.env.DB;
  let armed = true;
  f.env.DB = {
    prepare: original.prepare.bind(original),
    batch(statements: D1PreparedStatement[]) {
      if (armed) { armed = false; mutate(); }
      return original.batch(statements);
    },
  } as D1Database;
}

describe("execution-image structure inheritance", () => {
  it("materializes an ordered persistent diagram, downloads child images, and reuses its immutable identity", async () => {
    const f = fixture();
    try {
      const { images, state } = await withExecutionImages(f);
      expect((await f.detail(PARENT_ID)).currentStateThumbnailKey).toBe(images[0].key);
      const response = await f.split();
      expect(response.status).toBe(201);
      const split = await response.json() as { children: Array<{ id: string }>; updatedAt: string };
      const representation = f.database.prepare("SELECT * FROM state_representations WHERE hash = ?").get(state.hash);
      expect(representation).toMatchObject({ hash_scheme: STATE_HASH_SCHEME, representation_type: "diagram", content_json: stableJson(state.canonical) });
      const relationships = f.database.prepare("SELECT asset_id, position FROM state_representation_assets WHERE state_hash = ? ORDER BY position").all(state.hash);
      expect(relationships).toEqual(images.map((image, position) => ({ asset_id: image.id, position })));
      for (const child of split.children) {
        expect(await f.detail(child.id)).toMatchObject({ inheritedStateHash: state.hash, currentStateThumbnailKey: images[0].key, parentId: PARENT_ID });
      }
      const reference = await worker.fetch(new Request("https://app.test/api/references/resolve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: split.children.map((child) => ({ type: "sample", id: child.id })) }),
      }), f.env, context);
      expect(reference.status).toBe(200);
      const resolved = await reference.json() as { results: Array<{ resolution: string; destination: { openSourceUrl: string } }> };
      expect(resolved.results.map((result) => result.resolution)).toEqual(["resolved", "resolved"]);
      expect(resolved.results.map((result) => result.destination.openSourceUrl)).toEqual(split.children.map((child) => `/samples/${child.id}`));
      for (const image of images) {
        const download = await worker.fetch(new Request(`https://app.test/api/assets/${image.key}`), f.env, context);
        expect(download.status).toBe(200);
        expect(await download.text()).toBe(image.body);
      }
      const again = await f.split(split.updatedAt, "-NEXT");
      expect(again.status).toBe(201);
      expect(f.database.prepare("SELECT * FROM state_representations WHERE hash = ?").get(state.hash)).toEqual(representation);
      expect(f.database.prepare("SELECT asset_id, position FROM state_representation_assets WHERE state_hash = ? ORDER BY position").all(state.hash)).toEqual(relationships);
      expect((await f.detail(PARENT_ID)).status).toBe("consumed");
      f.database.prepare("UPDATE run_step_assets SET position = 0 WHERE id = 'occurrence-actual-image-0'").run();
      expect((await f.detail(PARENT_ID)).currentStateThumbnailKey).toBe(images[1].key);
      expect(await f.detail(split.children[0].id)).toMatchObject({ inheritedStateHash: state.hash, currentStateThumbnailKey: images[0].key });
      expect(f.database.prepare("SELECT asset_id, position FROM state_representation_assets WHERE state_hash = ? ORDER BY position").all(state.hash)).toEqual(relationships);
    } finally { f.database.close(); }
  });

  it.each(["parent revision", "execution order", "completed step"])("rejects a changed %s at the transaction boundary without publishing a state or children", async (changed) => {
    const f = fixture();
    try {
      const { state } = await withExecutionImages(f);
      let eventsAtBatch = f.database.prepare("SELECT * FROM events ORDER BY id").all();
      let parentAtBatch = f.database.prepare("SELECT status, updated_at FROM samples WHERE id = ?").get(PARENT_ID);
      beforeNextBatch(f, () => {
        if (changed === "parent revision") f.database.prepare("UPDATE samples SET updated_at = '2026-09-13T00:00:01.000Z' WHERE id = ?").run(PARENT_ID);
        else if (changed === "execution order") f.database.prepare("UPDATE run_step_assets SET position = 1 WHERE id = 'occurrence-actual-image-0'").run();
        else f.database.prepare("UPDATE run_steps SET status = 'pending' WHERE id = 'split-finished-step'").run();
        eventsAtBatch = f.database.prepare("SELECT * FROM events ORDER BY id").all();
        parentAtBatch = f.database.prepare("SELECT status, updated_at FROM samples WHERE id = ?").get(PARENT_ID);
      });
      const response = await f.split();
      expect(response.status).toBe(409);
      expect(f.database.prepare("SELECT count(*) AS count FROM samples WHERE parent_id = ?").get(PARENT_ID)).toEqual({ count: 0 });
      expect(f.database.prepare("SELECT status, updated_at FROM samples WHERE id = ?").get(PARENT_ID)).toEqual(parentAtBatch);
      expect(f.database.prepare("SELECT * FROM state_representations WHERE hash = ?").all(state.hash)).toEqual([]);
      expect(f.database.prepare("SELECT * FROM state_representation_assets WHERE state_hash = ?").all(state.hash)).toEqual([]);
      expect(f.database.prepare("SELECT * FROM events ORDER BY id").all()).toEqual(eventsAtBatch);
    } finally { f.database.close(); }
  });

  it("rolls the materialized state back when a child code collides", async () => {
    const f = fixture();
    try {
      const { state } = await withExecutionImages(f);
      f.database.prepare("INSERT INTO samples (id, code, title, created_at, updated_at) VALUES ('existing-child-code', 'SPLIT-B', 'Existing', ?, ?)").run(NOW, NOW);
      const response = await f.split();
      expect(response.status).toBe(409);
      expect(f.database.prepare("SELECT count(*) AS count FROM samples WHERE parent_id = ?").get(PARENT_ID)).toEqual({ count: 0 });
      expect(f.database.prepare("SELECT status, updated_at FROM samples WHERE id = ?").get(PARENT_ID)).toEqual({ status: "stored", updated_at: NOW });
      expect(f.database.prepare("SELECT * FROM state_representations WHERE hash = ?").all(state.hash)).toEqual([]);
    } finally { f.database.close(); }
  });

  it.each(["canonical content", "partial mapping", "empty mapping"])("preserves and rejects an inconsistent existing %s", async (conflict) => {
    const f = fixture();
    try {
      const { state, images } = await withExecutionImages(f);
      f.database.prepare("INSERT INTO state_representations (hash, hash_scheme, representation_type, content_json, created_at) VALUES (?, ?, 'diagram', ?, ?)")
        .run(state.hash, STATE_HASH_SCHEME, conflict === "canonical content" ? "{}" : stableJson(state.canonical), NOW);
      if (conflict === "partial mapping") f.database.prepare("INSERT INTO state_representation_assets (state_hash, asset_id, position) VALUES (?, ?, 0)").run(state.hash, images[0].id);
      const before = f.database.prepare("SELECT * FROM state_representations WHERE hash = ?").get(state.hash);
      const beforeAssets = f.database.prepare("SELECT * FROM state_representation_assets WHERE state_hash = ? ORDER BY position").all(state.hash);
      const response = await f.split();
      expect(response.status).toBe(409);
      expect(f.database.prepare("SELECT * FROM state_representations WHERE hash = ?").get(state.hash)).toEqual(before);
      expect(f.database.prepare("SELECT * FROM state_representation_assets WHERE state_hash = ? ORDER BY position").all(state.hash)).toEqual(beforeAssets);
      expect(f.database.prepare("SELECT count(*) AS count FROM samples WHERE parent_id = ?").get(PARENT_ID)).toEqual({ count: 0 });
      expect(f.database.prepare("SELECT status, updated_at FROM samples WHERE id = ?").get(PARENT_ID)).toEqual({ status: "stored", updated_at: NOW });
    } finally { f.database.close(); }
  });

  it("rejects an incomplete representation that appears after the pre-read without filling its empty mapping", async () => {
    const f = fixture();
    try {
      const { state } = await withExecutionImages(f);
      beforeNextBatch(f, () => {
        f.database.prepare("INSERT INTO state_representations (hash, hash_scheme, representation_type, content_json, created_at) VALUES (?, ?, 'diagram', ?, ?)")
          .run(state.hash, STATE_HASH_SCHEME, stableJson(state.canonical), NOW);
      });
      const response = await f.split();
      expect(response.status).toBe(409);
      expect(f.database.prepare("SELECT * FROM state_representation_assets WHERE state_hash = ?").all(state.hash)).toEqual([]);
      expect(f.database.prepare("SELECT content_json, created_at FROM state_representations WHERE hash = ?").get(state.hash))
        .toEqual({ content_json: stableJson(state.canonical), created_at: NOW });
      expect(f.database.prepare("SELECT count(*) AS count FROM samples WHERE parent_id = ?").get(PARENT_ID)).toEqual({ count: 0 });
      expect(f.database.prepare("SELECT status, updated_at FROM samples WHERE id = ?").get(PARENT_ID)).toEqual({ status: "stored", updated_at: NOW });
    } finally { f.database.close(); }
  });
});
