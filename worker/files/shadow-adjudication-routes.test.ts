import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { shadowAdjudicationRoutes } from "./shadow-adjudication-routes";
import type { ShadowAdjudicationPreparation, ShadowAdjudicationResult } from "./shadow-adjudication-service";
import type { ShadowAdjudicationRequest } from "../../shared/contracts/file-shadow-adjudication";

const databases: DatabaseSync[] = [];
const time = "2026-09-28T08:00:00.000Z";
const key = { consumerKind: "project_content_attachment" as const, consumerId: "content", consumerSubId: "", fileSlot: "primary" as const };
function fixture() {
  const sql = referenceTestDatabase(); databases.push(sql);
  const db = new SqliteD1Database(sql), io = vi.fn();
  const namespace = JSON.stringify({ kind: "local-r2", installationId: "12345678-1234-4123-8123-123456789abc", bucketName: "fixture-bucket" });
  sql.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES('asset','source','source.png','image/png',2,'ready',?,?)").run("a".repeat(64), time);
  sql.prepare("INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES('project','Project','create-project','operator','operator',?,?)").run(time, time);
  sql.prepare("INSERT INTO project_contents(id,project_id,content_type,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES('content','project','attachment','create-content','operator','operator',?,?)").run(time, time);
  sql.prepare("INSERT INTO project_content_attachments(project_content_id,asset_id,original_name,mime_type,byte_size,created_by,created_at,creation_operation_id) VALUES('content','asset','source.png','image/png',2,'operator',?,'create-attachment')").run(time);
  sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, time);
  sql.prepare("INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at) SELECT 1,epoch,'operator',? FROM file_shadow_control").run(time);
  const env = { AUTH_MODE: "access", FILE_EVIDENCE_OPERATOR_EMAILS: "operator@example.org", R2_BOOTSTRAP_NAMESPACE: namespace,
    DB: db as unknown as D1Database, ASSETS: { get: io, head: io, put: io, delete: io, list: io } as unknown as R2Bucket } satisfies Env;
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  // Production middleware validates Access first; this harness supplies its result.
  app.use("*", async (c, next) => { c.set("userEmail", "operator@example.org"); await next(); });
  app.route("/", shadowAdjudicationRoutes);
  const send = (action: string, value: unknown, bindings: Env = env) => app.request(`/files/shadow/evidence/${action}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }, bindings);
  const request = async (): Promise<ShadowAdjudicationRequest> => {
    const response = await send("prepare", { key }); expect(response.status).toBe(200);
    const prepared = await response.json() as ShadowAdjudicationPreparation;
    return { requestId: crypto.randomUUID(), key, ...prepared.preconditions!, sourceProfile: { profileId: "profile", configurationRevision: 1 },
      purpose: "research_source", purposeStatement: "Retain as research source", namespaceStatement: "Archived binding record", evidenceReference: "Operator record" };
  };
  return { sql, db, env, io, send, request };
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe("operator evidence metadata endpoints", () => {
  it("prepares, accepts, reads and revokes metadata with exact deployed binding and no provider calls", async () => {
    const f = fixture(), request = await f.request();
    const response = await f.send("accept", request); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const accepted = await response.json() as ShadowAdjudicationResult;
    expect(accepted).toMatchObject({ status: "accepted", request, createdBy: "operator@example.org" });
    expect(await (await f.send("request", request)).json()).toEqual(accepted);
    expect(await (await f.send("withdraw", request)).json()).toEqual(accepted);
    const revoke = { requestId: crypto.randomUUID(), adjudicationId: request.requestId, adjudicationRequestSha256: accepted.requestSha256, reason: "Correction required" };
    expect((await f.send("revocation/request", revoke)).status).toBe(404);
    expect((await f.send("revoke", revoke)).status).toBe(200);
    expect(await (await f.send("revocation/request", revoke)).json()).toMatchObject({ status: "revoked", revocation: { request: revoke } });
    expect(f.io).not.toHaveBeenCalled();
  });

  it("rejects a configured binding mismatch without registering another profile or accepting evidence", async () => {
    const f = fixture(), request = await f.request();
    const response = await f.send("accept", request, { ...f.env, R2_BOOTSTRAP_NAMESPACE: f.env.R2_BOOTSTRAP_NAMESPACE.replace("fixture-bucket", "different-bucket") });
    expect(response.status).toBe(409);
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_adjudications").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT count(*) n FROM storage_profiles").get()!.n).toBe(1);
    expect((await f.send("request", request)).status).toBe(404); expect(f.io).not.toHaveBeenCalled();
  });

  it("validates shapes and bounds before reading database metadata", async () => {
    const f = fixture(); f.db.resetQueryCount();
    for (const [action, value] of [["prepare", { key, extra: true }], ["prepare", { key: { ...key, consumerKind: "event" } }],
      ["accept", { requestId: crypto.randomUUID() }], ["revoke", {}], ["withdraw", "x".repeat(90 * 1024)], ["revocation/request", []]] as const)
      expect((await f.send(action, value)).status).toBe(400);
    expect(f.db.queryCount).toBe(0); expect(f.io).not.toHaveBeenCalled();
  });
});
