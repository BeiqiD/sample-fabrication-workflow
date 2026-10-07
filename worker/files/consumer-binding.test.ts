import { expect, it } from "vitest";
import { futureActiveRuntimeDatabase } from "./authority-runtime-test-support";
import { resolveConsumerFileId } from "./consumer-binding";
import { SqliteD1Database } from "../reference-test-support";
import worker from "../index";
import type { Env } from "../types";
import { acceptAndUploadR2Asset } from "../uploads/r2-upload-acceptance";

const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

it("binds ordinary records, execution images, comments and verification to the accepted File atomically", async () => {
  const now = new Date().toISOString();
  const namespace = JSON.stringify({ kind: "local-r2", installationId: "fbd92ad0-ac58-41b4-b677-4bb2a2ec702e", bucketName: "consumer-bindings" });
  const sql = futureActiveRuntimeDatabase(database => {
    database.prepare("INSERT INTO storage_profiles VALUES('profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
    database.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile',1,'operator',?)").run(now);
  });
  try {
    const stored = new Map<string, Uint8Array>();
    const get = async (key: string) => { const value = stored.get(key); return value ? {
      body: new Blob([value]).stream(), size: value.length, httpEtag: '"file"', writeHttpMetadata() {},
    } : null; };
    const env = {
      AUTH_MODE: "disabled", DB: new SqliteD1Database(sql) as unknown as D1Database, R2_BOOTSTRAP_NAMESPACE: namespace,
      ASSETS: { get, head: get, async put(key: string, value: ArrayBuffer) { stored.set(key, new Uint8Array(value.slice(0))); },
        async delete(key: string | string[]) { for (const objectKey of typeof key === "string" ? [key] : key) stored.delete(objectKey); } } as unknown as R2Bucket,
    } satisfies Env;
    const upload = await acceptAndUploadR2Asset(env, { actorEmail: "owner@example.test", requestId: crypto.randomUUID(),
      ingress: "ordinary_image", originalName: "image.png", mimeType: "image/png", bytes: Uint8Array.of(137, 80, 78, 71, 1).buffer });
    expect(upload.state.status).toBe("ready");
    if (upload.state.status !== "ready") throw new Error("Upload did not publish");
    const { id: assetId, key: assetKey } = upload.state.result;
    const fileId = String(sql.prepare("SELECT result_file_id FROM file_acceptance_candidates").get()!.result_file_id);
    expect(await resolveConsumerFileId(env.DB, { assetId, purpose: "embedded_content" })).toBe(fileId);
    await expect(resolveConsumerFileId(env.DB, { assetId, purpose: "research_source" })).rejects.toMatchObject({ status: 409 });
    // No provider call or hash-only inference grants a derived-preview purpose.
    await expect(resolveConsumerFileId(env.DB, { assetId, purpose: "derived_preview", sourceFileId: fileId })).rejects.toMatchObject({ status: 409 });
    sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('family','Family','process',?)").run(now);
    sql.prepare(`INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at)
      VALUES('template','family','Template','process',1,'manifest','{}',?)`).run(now);
    sql.prepare("INSERT INTO samples(id,code,title,status,created_at,updated_at) VALUES('sample','S1','Sample','stored',?,?)").run(now, now);
    sql.prepare(`INSERT INTO runs(id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,
      template_name_snapshot,template_type_snapshot,template_version_snapshot,status,created_at,run_kind)
      VALUES('run','sample','family','template',1,'group','Template','process',1,'active',?,'process')`).run(now);
    sql.prepare(`INSERT INTO run_steps(id,run_id,position,origin,plan_status,title,status,entry_kind,created_at,updated_at)
      VALUES('step','run',1000,'ad_hoc','current','Step','pending','fabrication',?,?)`).run(now, now);
    const request = (path: string, method: string, body: unknown) => worker.fetch(new Request(`https://app.test/api${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), env, context);
    const timestamp = (table: string, id: string) => String(sql.prepare(`SELECT updated_at FROM ${table} WHERE id=?`).get(id)!.updated_at);
    const record = await request("/samples/sample/records", "POST", { expectedUpdatedAt: timestamp("samples", "sample"),
      location: "", pinned: false, status: "stored", body: "Record", assetKey });
    expect(record.status, await record.clone().text()).toBe(201);
    const fields = { title: "Step", toolName: "", parametersText: "", commentsText: "", deviationNote: "", assetKey };
    const created = await request("/samples/sample/runs/run/steps", "POST", { ...fields, title: "Next", afterStepId: "step" });
    expect(created.status, await created.clone().text()).toBe(201);
    const patch = await request("/samples/sample/runs/run/steps/step", "PATCH", { ...fields, status: "done", notes: "",
      expectedUpdatedAt: timestamp("run_steps", "step") });
    expect(patch.status, await patch.clone().text()).toBe(200);
    const comment = await request("/run-step-comments", "POST", { scope: "individual", body: "Evidence", assetKey,
      targets: [{ sampleId: "sample", runId: "run", stepId: "step", expectedUpdatedAt: timestamp("run_steps", "step") }] });
    expect(comment.status, await comment.clone().text()).toBe(201);
    const verification = await request("/samples/sample/runs/run/steps/step/verify-state", "POST", { result: "matched",
      note: "", assetKey, completeStep: false, expectedUpdatedAt: timestamp("run_steps", "step") });
    expect(verification.status, await verification.clone().text()).toBe(201);
    expect(sql.prepare("SELECT file_id FROM run_step_assets").all()).toEqual([{ file_id: fileId }, { file_id: fileId }]);
    expect(sql.prepare("SELECT file_id FROM run_step_comments").all()).toEqual([{ file_id: fileId }]);
    expect(sql.prepare("SELECT evidence_file_id FROM state_verifications").all()).toEqual([{ evidence_file_id: fileId }]);
    expect(sql.prepare("SELECT asset_file_id FROM events WHERE asset_key IS NOT NULL").all())
      .toEqual(Array.from({ length: 5 }, () => ({ asset_file_id: fileId })));
    const sampleRecord = String(sql.prepare("SELECT id FROM events WHERE json_extract(metadata_json,'$.action')='sample_record'").get()!.id);
    const commentId = String(sql.prepare("SELECT id FROM run_step_comments").get()!.id);
    const verificationEvent = String(sql.prepare("SELECT id FROM events WHERE kind='verification'").get()!.id);
    const remove = async (path: string, body: unknown = {}) => {
      const response = await request(path, "DELETE", body);
      expect(response.status, await response.clone().text()).toBe(200);
    };
    const restore = async (path: string, body: unknown = {}) => {
      const response = await request(path, "POST", body);
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await remove(`/samples/sample/events/${sampleRecord}/asset`);
    expect((await request(`/samples/sample/events/${sampleRecord}/asset`, "DELETE", {})).status).toBe(409);
    expect(sql.prepare("SELECT asset_key,asset_file_id FROM events WHERE id=?").get(sampleRecord))
      .toEqual({ asset_key: assetKey, asset_file_id: fileId });
    const detailResponse = await worker.fetch(new Request("https://app.test/api/samples/sample"), env, context);
    const detail = await detailResponse.json() as { events: { id: string; assetKey: string | null }[] };
    expect(detail.events.find(event => event.id === sampleRecord)!.assetKey).toBeNull();
    await remove(`/samples/sample/records/${sampleRecord}`);
    const executionPath = "/samples/sample/runs/run/steps/step/assets";
    await remove(executionPath, { assetKey });
    await restore(`${executionPath}/restore`, { assetKey });
    expect(sql.prepare("SELECT asset_file_id FROM events WHERE json_extract(metadata_json,'$.action')='execution_attachment_restored'").get())
      .toEqual({ asset_file_id: fileId });
    await remove(`/run-step-comments/${commentId}/asset`);
    await restore(`/run-step-comments/${commentId}/asset/restore`);
    await remove(`/run-step-comments/${commentId}`);
    await restore(`/run-step-comments/${commentId}/restore`);
    await remove(`/samples/sample/events/${verificationEvent}/asset`);
    expect(sql.prepare("SELECT evidence_asset_id,evidence_file_id FROM state_verifications").get())
      .toEqual({ evidence_asset_id: assetId, evidence_file_id: fileId });
    // Restoration cannot revive an occurrence whose exact File is unavailable.
    await remove(executionPath, { assetKey });
    sql.prepare(`INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,expected_sha256,operation_id,detected_at,last_checked_at)
      SELECT active_location_id,'missing',verified_byte_size,verified_sha256,'restore-unavailable',?,? FROM file_publications WHERE file_id=?`)
      .run(now, now, fileId);
    expect((await request(`${executionPath}/restore`, "POST", { assetKey })).status).toBe(409);
    expect(sql.prepare("SELECT deleted_at FROM run_step_assets WHERE run_step_id='step'").get()!.deleted_at).not.toBeNull();
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { sql.close(); }
}, 15_000);
