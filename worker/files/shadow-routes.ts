import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { checkedShadowKey, readShadowBaseline } from "./shadow-baseline";
import { openShadowProfile } from "./shadow-profile";
import { admitShadowUnresolved, cancelShadowOperation, convertShadowConsumer, readShadowOperation, reconcileShadowOperation,
  ShadowConflictError, ShadowUnavailableError, type ShadowServiceContext } from "./shadow-service";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const shadowRoutes = new Hono<Bindings>();

function badInput(): never { throw new HTTPException(400, { message: "Invalid File shadow request" }); }
function keys(body: Body, allowed: string[]) {
  if (Object.keys(body).sort().join(",") !== [...allowed].sort().join(",")) badInput();
}
function id(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) badInput(); return value; }
function consumerKey(value: unknown) {
  try { return checkedShadowKey(value); } catch { return badInput(); }
}
function epoch(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) badInput(); return value; }
function profile(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) badInput();
  const input = value as Body; keys(input, ["profileId", "configurationRevision"]);
  if (typeof input.profileId !== "string" || !input.profileId || input.profileId.length > 256
    || input.profileId.includes("\0") || input.configurationRevision !== 1) badInput();
  return { profileId: input.profileId, configurationRevision: 1 };
}
async function body(request: Request): Promise<Body> {
  // Administrative commands are small metadata, never provider bytes or URLs.
  if (!request.body) badInput();
  const reader = request.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { text += decoder.decode(); break; }
      bytes += next.value.byteLength;
      if (bytes > 80 * 1024) { await reader.cancel(); badInput(); }
      text += decoder.decode(next.value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof HTTPException) throw error;
    badInput();
  } finally { reader.releaseLock(); }
  try { const value: unknown = JSON.parse(text); if (value && typeof value === "object" && !Array.isArray(value)) return value as Body; }
  catch { /* Report a fixed public error. */ }
  return badInput();
}
function context(env: Env, actor: string, incarnation: unknown): ShadowServiceContext {
  return { db: env.DB, actor, runtimeIncarnation: id(incarnation), openProfile: (frozen, access) => openShadowProfile(env, frozen, access) };
}
const counts = `SELECT count(*) current_count,
  COALESCE(sum(d.decision='resolved' AND f.file_id IS NOT NULL AND f.active_location_id=d.location_id),0) resolved_count,
  COALESCE(sum(d.decision='admitted_unresolved'),0) unresolved_count,
  count(*)-COALESCE(sum(d.decision='resolved' AND f.file_id IS NOT NULL AND f.active_location_id=d.location_id),0)-COALESCE(sum(d.decision='admitted_unresolved'),0) pending_count
  FROM file_shadow_heads h LEFT JOIN file_shadow_decisions d ON d.occurrence_id=h.occurrence_id
  LEFT JOIN file_usable_publications f ON f.file_id=d.file_id WHERE h.present=1`;
async function status(database: D1Database) {
  return primaryD1(database).prepare(`SELECT a.mode,c.epoch,r.enabled,r.incarnation,r.enabled_by,r.updated_at,
    summary.current_count,summary.resolved_count,summary.unresolved_count,summary.pending_count,
    (SELECT count(*) FROM file_shadow_attempts WHERE state IN('staged','write_started','unknown','verified')) AS unfinished_attempts
    FROM file_authority_control a JOIN file_shadow_control c ON c.singleton=a.singleton
    JOIN file_shadow_runtime_guard r ON r.singleton=a.singleton CROSS JOIN (${counts}) summary WHERE a.singleton=1`).first();
}
function fence(db: D1Database, expectedEpoch: number, incarnation: string | null, enabled?: number) {
  return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_shadow_control c JOIN file_shadow_runtime_guard r ON r.singleton=c.singleton
    WHERE c.singleton=1 AND c.epoch=? AND r.incarnation IS ? ${enabled === undefined ? "" : "AND r.enabled=?"})
    THEN 1 ELSE json('File shadow state changed') END`).bind(expectedEpoch, incarnation, ...(enabled === undefined ? [] : [enabled]));
}

shadowRoutes.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof ShadowConflictError) return c.json({ error: error.message }, 409);
  if (error instanceof ShadowUnavailableError) return c.json({ error: error.message }, 503);
  return c.json({ error: "File shadow state is unavailable or changed. Inspect the current state before retrying." }, 409);
});

shadowRoutes.get("/files/shadow/status", async (c) => c.json(await status(c.env.DB)));

shadowRoutes.get("/files/shadow/consumers", async (c) => {
  const limitText = c.req.query("limit") ?? "20";
  if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > 20) badInput();
  const limit = Number(limitText), cursorText = c.req.query("after");
  if (cursorText !== undefined && new TextEncoder().encode(cursorText).length > 64 * 1024) badInput();
  let after;
  try { after = cursorText === undefined ? null : checkedShadowKey(JSON.parse(cursorText)); }
  catch { return badInput(); }
  const rows = await primaryD1(c.env.DB).prepare(`SELECT h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,h.generation,h.occurrence_id,
    CASE WHEN d.decision='resolved' AND f.file_id IS NOT NULL AND f.active_location_id=d.location_id THEN 'resolved'
      WHEN d.decision='admitted_unresolved' THEN 'admitted_unresolved' ELSE 'pending' END AS state
    FROM file_shadow_heads h LEFT JOIN file_shadow_decisions d ON d.occurrence_id=h.occurrence_id
    LEFT JOIN file_usable_publications f ON f.file_id=d.file_id
    WHERE h.present=1 AND (?=0 OR (h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot)>(?,?,?,?))
    ORDER BY h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot LIMIT ?`)
    .bind(after ? 1 : 0, after?.consumerKind ?? "", after?.consumerId ?? "", after?.consumerSubId ?? "", after?.fileSlot ?? "", limit + 1)
    .all<{ consumer_kind: string; consumer_id: string; consumer_sub_id: string; file_slot: string; generation: number; occurrence_id: string; state: string }>();
  if (!rows.success) throw new ShadowUnavailableError();
  const records = rows.results.slice(0, limit), last = records.at(-1);
  const result = { records, nextCursor: rows.results.length > limit && last ? {
    consumerKind: last.consumer_kind, consumerId: last.consumer_id, consumerSubId: last.consumer_sub_id, fileSlot: last.file_slot,
  } : null };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 512 * 1024) throw new ShadowUnavailableError();
  return c.json(result);
});

shadowRoutes.post("/files/shadow/baseline", async (c) => {
  const input = await body(c.req.raw); keys(input, ["key"]);
  return c.json(await readShadowBaseline(c.env.DB, consumerKey(input.key)));
});

shadowRoutes.post("/files/shadow/enable", async (c) => {
  const input = await body(c.req.raw); keys(input, ["requestId", "expectedEpoch", "expectedIncarnation"]);
  const requestId = id(input.requestId), expectedEpoch = epoch(input.expectedEpoch);
  const previous = input.expectedIncarnation === null ? null : id(input.expectedIncarnation);
  const db = primaryD1(c.env.DB), now = new Date().toISOString(), actor = c.get("userEmail");
  const current = await db.prepare("SELECT incarnation,enabled,enabled_by FROM file_shadow_runtime_guard WHERE singleton=1")
    .first<{ incarnation: string | null; enabled: number; enabled_by: string | null }>();
  if (current?.incarnation === requestId && current.enabled === 1 && current.enabled_by === actor) return c.json(await status(db));
  await db.batch([fence(db, expectedEpoch, previous),
    db.prepare(`INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at)
      SELECT 1,?,?,? WHERE NOT EXISTS(SELECT 1 FROM file_shadow_enablements WHERE singleton=1)`).bind(expectedEpoch, actor, now),
    db.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by=?,updated_at=? WHERE singleton=1").bind(requestId, actor, now),
  ]);
  return c.json(await status(db));
});

shadowRoutes.post("/files/shadow/disable", async (c) => {
  const input = await body(c.req.raw); keys(input, ["runtimeIncarnation", "expectedEpoch"]);
  const incarnation = id(input.runtimeIncarnation), db = primaryD1(c.env.DB);
  await db.batch([fence(db, epoch(input.expectedEpoch), incarnation),
    db.prepare("UPDATE file_shadow_runtime_guard SET enabled=0,enabled_by=?,updated_at=? WHERE singleton=1")
      .bind(c.get("userEmail"), new Date().toISOString()),
  ]);
  return c.json(await status(db));
});

shadowRoutes.post("/files/shadow/profiles/enable", async (c) => {
  const input = await body(c.req.raw); keys(input, ["profile", "runtimeIncarnation", "expectedEpoch"]);
  const frozen = profile(input.profile), db = primaryD1(c.env.DB);
  await openShadowProfile(c.env, frozen, "read");
  await db.batch([fence(db, epoch(input.expectedEpoch), id(input.runtimeIncarnation), 1),
    db.prepare(`INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at)
      SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM file_shadow_profile_enablements WHERE storage_profile_id=?)`)
      .bind(frozen.profileId, frozen.configurationRevision, c.get("userEmail"), new Date().toISOString(), frozen.profileId),
  ]);
  return c.json(await status(db));
});

shadowRoutes.post("/files/shadow/convert", async (c) => {
  const input = await body(c.req.raw); keys(input, ["operationId", "key", "expectedBaselineSha256", "destinationProfile", "runtimeIncarnation"]);
  if (typeof input.expectedBaselineSha256 !== "string") badInput();
  return c.json(await convertShadowConsumer(context(c.env, c.get("userEmail"), input.runtimeIncarnation), {
    operationId: id(input.operationId), key: consumerKey(input.key), expectedBaselineSha256: input.expectedBaselineSha256,
    destinationProfile: profile(input.destinationProfile),
  }));
});

shadowRoutes.post("/files/shadow/reconcile", async (c) => {
  const input = await body(c.req.raw); keys(input, ["operationId", "runtimeIncarnation"]);
  return c.json(await reconcileShadowOperation(context(c.env, c.get("userEmail"), input.runtimeIncarnation), { operationId: id(input.operationId) }));
});

shadowRoutes.post("/files/shadow/cancel", async (c) => {
  const input = await body(c.req.raw); keys(input, ["operationId", "runtimeIncarnation"]);
  return c.json(await cancelShadowOperation(context(c.env, c.get("userEmail"), input.runtimeIncarnation), { operationId: id(input.operationId) }));
});

shadowRoutes.post("/files/shadow/admit-unresolved", async (c) => {
  const input = await body(c.req.raw); keys(input, ["operationId", "key", "expectedBaselineSha256", "reason", "runtimeIncarnation"]);
  if (typeof input.reason !== "string" || typeof input.expectedBaselineSha256 !== "string") badInput();
  return c.json(await admitShadowUnresolved(context(c.env, c.get("userEmail"), input.runtimeIncarnation), {
    operationId: id(input.operationId), key: consumerKey(input.key), expectedBaselineSha256: input.expectedBaselineSha256, reason: input.reason,
  }));
});

shadowRoutes.post("/files/shadow/operation", async (c) => {
  const input = await body(c.req.raw); keys(input, ["operationId", "runtimeIncarnation"]);
  const result = await readShadowOperation(context(c.env, c.get("userEmail"), input.runtimeIncarnation), { operationId: id(input.operationId) });
  if (!result) throw new HTTPException(404, { message: "File shadow operation not found" });
  return c.json(result);
});

shadowRoutes.post("/files/shadow/checkpoint", async (c) => {
  const input = await body(c.req.raw); keys(input, ["requestId", "expectedEpoch", "runtimeIncarnation"]);
  const db = primaryD1(c.env.DB), requestId = id(input.requestId), expectedEpoch = epoch(input.expectedEpoch);
  await db.batch([fence(db, expectedEpoch, id(input.runtimeIncarnation), 1),
    db.prepare(`INSERT INTO file_shadow_checkpoints(id,captured_epoch,current_count,resolved_count,unresolved_count,pending_count,captured_by,captured_at)
      SELECT ?,?,current_count,resolved_count,unresolved_count,pending_count,?,? FROM (${counts})`)
      .bind(requestId, expectedEpoch, c.get("userEmail"), new Date().toISOString()),
  ]);
  return c.json(await db.prepare("SELECT * FROM file_shadow_checkpoints WHERE id=?").bind(requestId).first());
});

shadowRoutes.get("/files/shadow/checkpoints/:requestId", async (c) => {
  const result = await primaryD1(c.env.DB).prepare("SELECT * FROM file_shadow_checkpoints WHERE id=?")
    .bind(id(c.req.param("requestId"))).first();
  if (!result) throw new HTTPException(404, { message: "File shadow checkpoint not found" });
  return c.json(result);
});
