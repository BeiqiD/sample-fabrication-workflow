import { expect, it } from "vitest";
import { hashStateRepresentation } from "../shared/content-addressing";
import { futureActiveRuntimeDatabase } from "./files/authority-runtime-test-support";
import worker from "./index";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";
import { acceptAndUploadR2Asset } from "./uploads/r2-upload-acceptance";

const namespace = JSON.stringify({ kind: "local-r2", installationId: "a7041580-9c25-4f8e-8b06-59f294750c58", bucketName: "state-consumer-bindings" });
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

it.each(["available", "unavailable-existing", "unavailable-inherited"] as const)(
  "binds active state consumers and checks the exact File when splitting: %s", async (scenario) => {
  const now = new Date().toISOString();
  const sql = futureActiveRuntimeDatabase(database => {
    database.prepare("INSERT INTO storage_profiles VALUES('profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
    database.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile',1,'operator',?)").run(now);
  });
  try {
    const stored = new Map<string, Uint8Array>();
    const get = async (key: string) => {
      const value = stored.get(key);
      return value ? { body: new Blob([value]).stream(), size: value.length, httpEtag: '"file"', writeHttpMetadata() {} } : null;
    };
    const env = {
      AUTH_MODE: "disabled",
      DB: new SqliteD1Database(sql) as unknown as D1Database,
      R2_BOOTSTRAP_NAMESPACE: namespace,
      ASSETS: { get, head: get, async put(key: string, value: ArrayBuffer) { stored.set(key, new Uint8Array(value.slice(0))); },
        async delete(key: string | string[]) { for (const objectKey of typeof key === "string" ? [key] : key) stored.delete(objectKey); } } as unknown as R2Bucket,
    } satisfies Env;
    const images = [] as Array<{ id: string; key: string; fileId: string; sha256: string }>;
    for (const value of [1, 2]) {
      const requestId = crypto.randomUUID();
      const uploaded = await acceptAndUploadR2Asset(env, {
        actorEmail: "owner@example.test", requestId, ingress: "ordinary_image", originalName: `state-${value}.png`,
        mimeType: "image/png", bytes: Uint8Array.of(137, 80, 78, 71, value).buffer,
      });
      expect(uploaded.state.status).toBe("ready");
      if (uploaded.state.status !== "ready") throw new Error("Image did not publish");
      const file = sql.prepare(`SELECT c.result_file_id AS fileId,a.sha256 FROM file_authority_ready_candidate_aliases c
        JOIN assets a ON a.id=? AND a.r2_key=c.result_object_key WHERE c.acceptance_kind='r2_upload'`)
        .get(uploaded.state.result.id) as { fileId: string; sha256: string };
      images.push({ ...uploaded.state.result, ...file });
    }
    sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('family','Family','process',?)").run(now);
    sql.prepare(`INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at)
      VALUES('template','family','Template','process',1,'manifest','{}',?)`).run(now);
    const request = (path: string, method: string, body: unknown) => worker.fetch(new Request(`https://app.test/api${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), env, context);
    const fields = { name: "Preparation", toolName: "", parametersText: "", commentsText: "" };
    const created = await request("/templates/template/steps", "POST", { ...fields, assetKey: images[0].key });
    expect(created.status).toBe(201);
    const step = await created.json() as { id: string };
    const edited = await request(`/templates/template/steps/${step.id}`, "PATCH", { ...fields, assetKey: images[1].key });
    expect(edited.status).toBe(200);
    for (const image of images) {
      expect(sql.prepare("SELECT file_id FROM state_representation_assets WHERE asset_id=?").get(image.id))
        .toEqual({ file_id: image.fileId });
    }

    sql.prepare(`INSERT INTO samples(id,code,title,status,created_at,updated_at)
      VALUES('parent','PARENT','Parent','stored',?,?)`).run(now, now);
    sql.prepare(`INSERT INTO runs(id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,
      template_name_snapshot,template_type_snapshot,template_version_snapshot,status,created_at)
      VALUES('run','parent','family','template',1,'group','Template','process',1,'complete',?)`).run(now);
    sql.prepare(`INSERT INTO run_steps(id,run_id,position,origin,plan_status,definition_hash,expected_state_hash,title,status,entry_kind,created_at,updated_at)
      SELECT 'run-step','run',0,'template','current',definition_hash,expected_state_hash,'Preparation','done','fabrication',?,?
      FROM template_steps WHERE id=?`).run(now, now, step.id);
    let execution = images;
    if (scenario !== "available") {
      const unavailable = images[scenario === "unavailable-existing" ? 0 : 1];
      sql.prepare(`INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,
        expected_sha256,operation_id,detected_at,last_checked_at)
        SELECT active_location_id,'missing',verified_byte_size,verified_sha256,'state-unavailable',?,?
        FROM file_publications WHERE file_id=?`).run(now, now, unavailable.fileId);
      execution = [];
      if (scenario === "unavailable-existing") {
        // A fresh upload of the same content has its own available File. The
        // immutable, already recorded state still names the quarantined File.
        const replacement = await acceptAndUploadR2Asset(env, {
          actorEmail: "owner@example.test", requestId: crypto.randomUUID(), ingress: "ordinary_image",
          originalName: "state-replacement.png", mimeType: "image/png", bytes: Uint8Array.of(137, 80, 78, 71, 1).buffer,
        });
        expect(replacement.state.status).toBe("ready");
        if (replacement.state.status !== "ready") throw new Error("Replacement image did not publish");
        const file = sql.prepare(`SELECT c.result_file_id AS fileId,a.sha256 FROM file_authority_ready_candidate_aliases c
          JOIN assets a ON a.id=? AND a.r2_key=c.result_object_key WHERE c.acceptance_kind='r2_upload'`)
          .get(replacement.state.result.id) as { fileId: string; sha256: string };
        expect(file.fileId).not.toBe(unavailable.fileId);
        execution = [{ ...replacement.state.result, ...file }];
      }
    }
    for (const [position, image] of execution.entries()) {
      sql.prepare(`INSERT INTO run_step_assets(id,run_step_id,asset_id,role,position,created_at,file_id)
        VALUES(?,'run-step',?,'execution',?,?,?)`).run(`occurrence-${position}`, image.id, position, now, image.fileId);
    }
    const split = await request("/samples/parent/split", "POST", {
      expectedUpdatedAt: now, parentStatusAfter: "consumed",
      pieces: [{ code: "PIECE-A", title: "A", status: "stored", location: "Box A" },
        { code: "PIECE-B", title: "B", status: "stored", location: "Box B" }],
    });
    if (scenario !== "available") {
      expect(split.status, await split.clone().text()).toBe(409);
      expect(sql.prepare("SELECT id FROM samples WHERE parent_id='parent'").all()).toEqual([]);
      return;
    }
    expect(split.status, await split.clone().text()).toBe(201);
    const state = await hashStateRepresentation(images.map(image => image.sha256));
    expect(sql.prepare("SELECT asset_id,file_id,position FROM state_representation_assets WHERE state_hash=? ORDER BY position").all(state.hash))
      .toEqual(images.map((image, position) => ({ asset_id: image.id, file_id: image.fileId, position })));
    expect(sql.prepare("SELECT inherited_state_hash FROM samples WHERE parent_id='parent'").all())
      .toEqual([{ inherited_state_hash: state.hash }, { inherited_state_hash: state.hash }]);
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    sql.close();
  }
});
