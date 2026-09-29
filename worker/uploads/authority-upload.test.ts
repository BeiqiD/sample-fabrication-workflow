import worker from "../index";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { R2UploadIngress } from "../../shared/contracts/r2-upload";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { enableFutureFileAuthority } from "../files/authority-runtime-test-support";
import type { Env } from "../types";
import { acceptAndUploadR2Asset } from "./r2-upload-acceptance";
import { acceptAndUploadMetrologyReference } from "./metrology-reference-acceptance";

const namespace = JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "authority-uploads" });
const bytes = Uint8Array.of(137, 80, 78, 71, 1, 2, 3, 4);
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });

function fixture() {
  // Apply the official runtime rules. Model activation only in this isolated
  // fixture, restoring its control guard; no publication/binding guard changes.
  readFileSync(new URL("../../migrations/0012_fp1_file_authority_runtime.sql", import.meta.url), "utf8");
  const sql = referenceTestDatabase(); databases.push(sql); sql.exec("PRAGMA foreign_keys=ON");
  const now = new Date().toISOString();
  sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
  sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'operator',? FROM file_shadow_control").run(now);
  sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile',1,'operator',?)").run(now);
  enableFutureFileAuthority(sql, now);
  sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('family','Family','module',?)").run(now);
  sql.prepare(`INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at,template_kind)
    VALUES('template','family','Metrology','module',1,'manifest','{}',?,'metrology')`).run(now);
  const stored = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: ArrayBuffer) => { stored.set(key, new Uint8Array(value.slice(0))); });
  const get = vi.fn(async (key: string) => {
    const value = stored.get(key);
    return value ? { body: new Blob([value]).stream(), size: value.length, httpEtag: '"file"', writeHttpMetadata() {} } : null;
  });
  const adapter = new SqliteD1Database(sql);
  let losePublicationAck = false;
  const batchErrors: string[] = [];
  const db = { prepare: adapter.prepare.bind(adapter), async batch(statements: D1PreparedStatement[]) {
    try {
      const result = await adapter.batch(statements);
      if (losePublicationAck && sql.prepare("SELECT 1 FROM file_acceptance_candidates WHERE state='ready'").get()) {
        losePublicationAck = false; throw new Error("Lost publication acknowledgement");
      }
      return result;
    } catch (error) { batchErrors.push(String(error)); throw error; }
  } } as unknown as D1Database;
  const env = { DB: db, R2_BOOTSTRAP_NAMESPACE: namespace, ASSETS: { get, head: get, put } as unknown as R2Bucket } satisfies Env;
  const base = { actorEmail: "owner@example.test", originalName: "image.png", mimeType: "image/png", bytes: bytes.buffer };
  const r2 = (ingress: R2UploadIngress = "ordinary_image", requestId = crypto.randomUUID()) => acceptAndUploadR2Asset(env, { ...base, ingress, requestId });
  const metrology = (requestId = crypto.randomUUID()) => acceptAndUploadMetrologyReference(env, { ...base, templateId: "template", requestId });
  return { sql, env, r2, metrology, put, get, stored, batchErrors, loseAck: () => { losePublicationAck = true; } };
}

describe("active accepted R2 and metrology uploads under official runtime guards", () => {
  it.each(["r2", "metrology"] as const)("publishes %s atomically, reconciles a lost ACK, and replays without another PUT", async kind => {
    const f = fixture(), requestId = crypto.randomUUID(); f.loseAck();
    const upload = () => kind === "r2" ? f.r2("ordinary_image", requestId) : f.metrology(requestId);
    const first = await upload();
    expect(first.state.status, f.batchErrors.join("\n")).toBe("ready"); expect(first.fresh).toBe(true);
    const candidate = f.sql.prepare("SELECT state,result_file_id,result_location_id FROM file_acceptance_candidates").get()!;
    expect(candidate.state).toBe("ready");
    expect(f.sql.prepare("SELECT file_id FROM file_usable_publications").get()!.file_id).toBe(candidate.result_file_id);
    if (kind === "metrology") expect(f.sql.prepare("SELECT file_id FROM metrology_template_references").get()!.file_id).toBe(candidate.result_file_id);
    expect(f.sql.prepare("SELECT count(*) n FROM assets").get()!.n).toBe(1);
    const changes = f.sql.prepare("SELECT total_changes() n").get()!.n;
    expect(await upload()).toEqual({ state: first.state, fresh: false });
    expect(f.put).toHaveBeenCalledOnce();
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(changes);
    if (kind === "metrology") {
      const referenceId = f.sql.prepare("SELECT id FROM metrology_template_references").get()!.id;
      const path = `https://app.test/api/metrology-templates/template/references/${referenceId}`;
      const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
      expect((await worker.fetch(new Request(path, { method: "DELETE" }), { ...f.env, AUTH_MODE: "disabled" }, context)).status).toBe(200);
      const restored = await worker.fetch(new Request(`${path}/restore`, { method: "POST" }), { ...f.env, AUTH_MODE: "disabled" }, context);
      expect(restored.status, await restored.clone().text()).toBe(200);
      expect(f.sql.prepare("SELECT file_id,deleted_at FROM metrology_template_references").get())
        .toEqual({ file_id: candidate.result_file_id, deleted_at: null });
      expect(f.put).toHaveBeenCalledOnce();
    }

    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("separates equal bytes by purpose and reuses the research File across R2 and metrology", async () => {
    const f = fixture();
    const image = await f.r2(), source = await f.metrology(), project = await f.r2("project_attachment"), sourceAgain = await f.metrology();
    expect([image.state.status, source.state.status, project.state.status, sourceAgain.state.status], f.batchErrors.join("\n"))
      .toEqual(["ready", "ready", "ready", "ready"]);
    if (image.state.status !== "ready" || source.state.status !== "ready" || project.state.status !== "ready" || sourceAgain.state.status !== "ready") throw new Error("Uploads did not publish");
    expect(source.state.result.assetId).not.toBe(image.state.result.id);
    expect(source.state.result.deduplicated).toBe(false);
    expect(project.state.result).toEqual({ id: source.state.result.assetId, key: source.state.result.reference.assetKey, deduplicated: true });
    expect(sourceAgain.state.result).toEqual({ ...source.state.result, deduplicated: true });
    expect(sourceAgain.fresh).toBe(false);
    expect(f.sql.prepare("SELECT purpose FROM file_usable_publications ORDER BY purpose").all())
      .toEqual([{ purpose: "embedded_content" }, { purpose: "research_source" }]);
    expect(f.sql.prepare("SELECT count(*) n FROM assets").get()!.n).toBe(2);
    expect(f.sql.prepare("SELECT count(*) n FROM metrology_template_references").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT count(*) n FROM file_acceptance_candidates WHERE state='ready'").get()!.n).toBe(4);
  });

  it.each(["r2", "metrology"] as const)("rolls back %s publication, alias and bindings when receipt completion fails; retry cannot PUT again", async kind => {
    const f = fixture(), requestId = crypto.randomUUID();
    const table = kind === "r2" ? "r2_upload_requests" : "metrology_reference_upload_requests";
    f.sql.exec(`CREATE TRIGGER test_reject_receipt BEFORE UPDATE ON ${table} WHEN NEW.status='ready'
      BEGIN SELECT RAISE(ABORT,'receipt rejected'); END;`);
    const upload = () => kind === "r2" ? f.r2("ordinary_image", requestId) : f.metrology(requestId);
    expect((await upload()).state.status).toBe("pending");
    for (const table of ["file_publications", "file_location_publications", "assets", "metrology_template_references"]) {
      expect(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    }
    expect(f.sql.prepare("SELECT state FROM file_acceptance_candidates").get()!.state).toBe("candidate");
    expect((await upload()).state.status).toBe("pending"); expect(f.put).toHaveBeenCalledOnce();
  });
});
