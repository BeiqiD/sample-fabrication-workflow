import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { splitTestSql } from "./lib/test-sql-split-cache.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const namespace = JSON.stringify({ kind: "local-r2", installationId: "54735658-5d90-4c57-9b1e-31f9afff201c", bucketName: "native-role-assets" });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const source = `
import { Hono } from "hono";
import { routes } from "./worker/comment-submission-routes.ts";
import { handleError } from "./worker/platform/http.ts";
const app = new Hono().basePath("/api");
app.onError(handleError);
app.use("*", async (c,next) => { c.set("userEmail","native-role@example.test"); await next(); });
app.route("/",routes);
let puts=0;
export default { async fetch(request,env,ctx) {
  if(new URL(request.url).pathname==="/test-puts")return Response.json({puts});
  const ASSETS={
    put(...args){puts++;return env.BUCKET.put(...args)},
    get(...args){return env.BUCKET.get(...args)},
    head(...args){return env.BUCKET.head(...args)},
    list(...args){return env.BUCKET.list(...args)}
  };
  return app.fetch(request,{...env,ASSETS,R2_BOOTSTRAP_NAMESPACE:${JSON.stringify(namespace)}},ctx);
}};
`;

test("FP1 R2 originals use native bounded streaming and immutable atomic role bootstrap on workerd/D1/R2", { timeout: 90_000 }, async () => {
  const script = (await build({ stdin: { contents: source, resolveDir: root }, bundle: true, format: "esm", platform: "neutral", write: false })).outputFiles[0].text;
  const mf = new Miniflare({ modules: true, script, compatibilityDate: "2026-07-20", d1Databases: ["DB"], r2Buckets: ["BUCKET"], log: new Log(LogLevel.ERROR) });
  try {
    const db = await mf.getD1Database("DB");
    for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(splitTestSql(sql).map(statement => db.prepare(statement)));
    }
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'native-role',? FROM file_shadow_control").bind(now),
      db.prepare("INSERT INTO storage_profiles VALUES('native-r2','r2',?,'bootstrap',NULL,1,'historical',?)").bind(namespace, now),
      db.prepare("INSERT INTO file_shadow_profile_enablements VALUES('native-r2',1,'native-role',?)").bind(now),
      db.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('role-sample','ROLE','Native original',?,?)").bind(now, now),
    ]);
    // Fixture-only transition. Every native acceptance/publication guard stays
    // installed; activation itself has a separate populated native suite.
    const control = await db.prepare("SELECT sql FROM sqlite_schema WHERE name='file_authority_control_update_guard'").first();
    await db.batch([
      db.prepare("DROP TRIGGER file_authority_control_update_guard"),
      db.prepare("UPDATE file_authority_control SET mode='active',updated_at=?").bind(now),
      db.prepare("UPDATE file_authority_runtime_guard SET enabled=1,incarnation=?,enabled_by='native-role',updated_at=?").bind(crypto.randomUUID(), now),
      db.prepare(control.sql),
    ]);
    const bytes = Buffer.alloc(6 * 1024 * 1024 + 19, 37);
    const body = { protocol: "comment-submission/1", id: "native-original-submission", body: "",
      context: { kind: "sample", sampleId: "role-sample", expectedUpdatedAt: now },
      items: [{ id: "native-original-item", kind: "attachment", filename: "measurement.bin", mimeType: "application/octet-stream", byteSize: bytes.length, sha256: hash(bytes) }] };
    const create = () => mf.dispatchFetch("https://app.test/api/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const rejectedBody = { ...body, id: "rejected-submission", context: { ...body.context, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }, items: [{ ...body.items[0], id: "rejected-original" }] };
    const rejected = await mf.dispatchFetch("https://app.test/api/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rejectedBody) });
    assert.equal(rejected.status, 409, await rejected.text());
    assert.equal((await db.prepare("SELECT count(*) n FROM storage_role_defaults").first()).n, 0);
    const accepted = await create(); assert.equal(accepted.status, 201, await accepted.text());
    const before = (await db.prepare("SELECT * FROM storage_role_defaults ORDER BY role").all()).results;
    assert.equal(before.length, 2); assert.equal(before[0].created_at, before[1].created_at);
    assert(before.every(row => row.storage_profile_id === "native-r2" && row.policy_revision === 2));
    await assert.rejects(db.prepare("INSERT OR REPLACE INTO storage_role_defaults VALUES('originals','native-r2',1,2,?)")
      .bind("2026-09-01T00:00:00.000Z").run(), /initialized once/);
    assert.deepEqual((await db.prepare("SELECT * FROM storage_role_defaults ORDER BY role").all()).results, before);
    const upload = () => mf.dispatchFetch("https://app.test/api/comment-submissions/native-original-submission/items/native-original-item/content", {
      method: "PUT", headers: { "content-type": "application/octet-stream", "x-upload-size": String(bytes.length), "x-content-sha256": hash(bytes) }, body: bytes,
    });
    const uploaded = await upload(); assert.equal(uploaded.status, 200, await uploaded.text());
    const receipt = await db.prepare("SELECT * FROM comment_item_acceptances").first();
    assert.equal(JSON.parse(receipt.accepted_result_json).storeKind, "r2");
    const replay = await upload(); assert.equal(replay.status, 200, await replay.text());
    assert.deepEqual(await db.prepare("SELECT * FROM comment_item_acceptances").first(), receipt);
    const finalized = await mf.dispatchFetch("https://app.test/api/comment-submissions/native-original-submission/finalize", { method: "POST" });
    assert.equal(finalized.status, 200, await finalized.text());
    const download = await mf.dispatchFetch("https://app.test/api/attachments/native-original-item/download");
    assert.equal(download.status, 200); assert(Buffer.from(await download.arrayBuffer()).equals(bytes));
    const recreated = await create(); assert.equal(recreated.status, 200, await recreated.text());
    assert.deepEqual((await db.prepare("SELECT * FROM storage_role_defaults ORDER BY role").all()).results, before);
    assert.deepEqual(await (await mf.dispatchFetch("https://app.test/test-puts")).json(), { puts: 1 });
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
});
