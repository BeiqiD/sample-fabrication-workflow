import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";

const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "shadow-http-test" });
const databases: DatabaseSync[] = [];
const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const key = (consumerId = "event-a") => ({ consumerKind: "event", consumerId, consumerSubId: "", fileSlot: "primary" });
const prefix = "/api/files/shadow";

function fixture() {
  const sql = referenceTestDatabase(); databases.push(sql);
  const now = new Date().toISOString();
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample','HTTP','HTTP sample',?,?)").run(now, now);
  for (const id of ["event-a", "event-b"]) sql.prepare(`INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at)
    VALUES(?,'sample','image',?,'{"action":"sample_record"}',?)`).run(id, `historical/${id}`, now);
  sql.prepare("INSERT INTO storage_profiles VALUES('http-profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
  const local = new SqliteD1Database(sql);
  const get = vi.fn(async () => null), head = vi.fn(async () => null), put = vi.fn(), remove = vi.fn(), list = vi.fn();
  const providerFetch = vi.fn(async () => { throw new Error("Unexpected provider I/O"); });
  vi.stubGlobal("fetch", providerFetch);
  const env = { AUTH_MODE: "disabled", DB: local as unknown as D1Database,
    ASSETS: { get, head, put, delete: remove, list } as unknown as R2Bucket, R2_BOOTSTRAP_NAMESPACE: namespace } satisfies Env;
  const epoch = () => Number(sql.prepare("SELECT epoch FROM file_shadow_control WHERE singleton=1").get()!.epoch);
  const noProvider = () => {
    for (const fn of [get, head, put, remove, list, providerFetch]) expect(fn).not.toHaveBeenCalled();
  };
  const post = (path: string, body: unknown, headers: HeadersInit = {}, targetEnv: Env = env) => request(targetEnv, path, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  async function enable(requestId = crypto.randomUUID(), expectedIncarnation: string | null = null) {
    const response = await post("/enable", { requestId, expectedEpoch: epoch(), expectedIncarnation });
    expect(response.status).toBe(200);
    return requestId;
  }
  return { sql, local, env, epoch, post, enable, noProvider };
}
function request(env: Env, path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://app.test${prefix}${path}`, init), env, executionContext);
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const sql of databases.splice(0)) sql.close();
});

describe("File shadow HTTP boundary through the root application", () => {
  it("shows an inert migration and current consumer generations without opening storage", async () => {
    const f = fixture();
    const response = await request(f.env, "/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "legacy", enabled: 0, incarnation: null,
      current_count: 2, resolved_count: 0, unresolved_count: 0, pending_count: 2, unfinished_attempts: 0 });
    const page = await request(f.env, "/consumers?limit=1");
    const first = await page.json() as { records: unknown[]; nextCursor: ReturnType<typeof key> };
    expect(first.records).toHaveLength(1); expect(first.nextCursor).toEqual(key());
    const next = await request(f.env, `/consumers?limit=1&after=${encodeURIComponent(JSON.stringify(first.nextCursor))}`);
    expect(await next.json()).toMatchObject({ records: [{ consumer_id: "event-b", state: "pending" }], nextCursor: null });
    f.noProvider();
  });

  it("authenticates all root routes before database or provider work", async () => {
    const f = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env: Env = { ...f.env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "https://private-access.example", ACCESS_AUD: "test-audience" };
    f.local.resetQueryCount();
    for (const [path, init] of [
      ["/status", undefined], ["/consumers", undefined],
      ["/enable", { method: "POST", body: "{}" }],
      ["/convert", { method: "POST", body: "{}" }],
      ["/reconcile", { method: "POST", body: "{}" }],
    ] as const) {
      const response = await request(env, path, init);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Authentication required" });
    }
    expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it("rejects cross-origin writes before reading metadata", async () => {
    const f = fixture(); f.local.resetQueryCount();
    const response = await f.post("/enable", { requestId: crypto.randomUUID(), expectedEpoch: f.epoch(), expectedIncarnation: null },
      { origin: "https://attacker.example" });
    expect(response.status).toBe(403); expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it.each(["{", "null", "[]", "true", "1", '"text"', "{}"])("rejects malformed command body %s without I/O", async raw => {
    const f = fixture(); f.local.resetQueryCount();
    const response = await request(f.env, "/enable", { method: "POST", body: raw });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid File shadow request" });
    expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it("rejects unknown fields and wrong scalar types before database work", async () => {
    const f = fixture(); f.local.resetQueryCount();
    for (const body of [
      { requestId: crypto.randomUUID(), expectedEpoch: f.epoch(), expectedIncarnation: null, providerUrl: "private://endpoint" },
      { requestId: crypto.randomUUID(), expectedEpoch: String(f.epoch()), expectedIncarnation: null },
      { requestId: crypto.randomUUID(), expectedEpoch: -1, expectedIncarnation: null },
      { requestId: "unvalidated-operation", expectedEpoch: f.epoch(), expectedIncarnation: null },
      { requestId: crypto.randomUUID(), expectedEpoch: f.epoch(), expectedIncarnation: false },
    ]) expect((await f.post("/enable", body)).status).toBe(400);
    expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it("cancels a streamed body at the byte bound even when Content-Length claims a small body", async () => {
    const f = fixture(), cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(30 * 1024).fill(32)); }, cancel }, { highWaterMark: 0 });
    const init = { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: stream, duplex: "half" } as RequestInit;
    f.local.resetQueryCount();
    expect((await request(f.env, "/enable", init)).status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce(); expect(pulls).toBe(3);
    expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it("rejects malformed UTF-8 instead of decoding replacement characters into a command", async () => {
    const f = fixture(); f.local.resetQueryCount();
    expect((await request(f.env, "/baseline", { method: "POST", body: new Uint8Array([123, 34, 0xff, 34, 58, 49, 125]) })).status).toBe(400);
    expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it("rejects malformed consumer keys as client errors before snapshots or storage", async () => {
    const f = fixture(); f.local.resetQueryCount();
    for (const bad of [null, {}, { ...key(), consumerId: 3 }, { ...key(), extra: "value" }, { ...key(), consumerId: "长".repeat(23_000) }]) {
      expect((await f.post("/baseline", { key: bad })).status).toBe(400);
    }
    expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it("bounds pagination and validates typed cursors before querying", async () => {
    const f = fixture(); f.local.resetQueryCount();
    for (const query of ["limit=0", "limit=21", "limit=01", "limit=1.5", "limit=-1", "after=null", "after=%7B%7D", "after=%7B"]) {
      expect((await request(f.env, `/consumers?${query}`)).status).toBe(400);
    }
    expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it("fences enable/disable against current epoch and incarnation and records the authenticated actor", async () => {
    const f = fixture(), initialEpoch = f.epoch(), runtime = crypto.randomUUID();
    expect((await f.post("/enable", { requestId: runtime, expectedEpoch: initialEpoch + 1, expectedIncarnation: null })).status).toBe(409);
    expect(f.sql.prepare("SELECT mode FROM file_authority_control").get()!.mode).toBe("legacy");
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_enablements").get()!.n).toBe(0);
    await f.enable(runtime);
    expect(f.sql.prepare("SELECT enabled,incarnation,enabled_by FROM file_shadow_runtime_guard").get())
      .toEqual({ enabled: 1, incarnation: runtime, enabled_by: "local-development" });
    expect((await f.post("/enable", { requestId: runtime, expectedEpoch: initialEpoch, expectedIncarnation: null })).status).toBe(200);
    expect((await f.post("/disable", { runtimeIncarnation: crypto.randomUUID(), expectedEpoch: f.epoch() })).status).toBe(409);
    expect((await f.post("/disable", { runtimeIncarnation: runtime, expectedEpoch: f.epoch() + 1 })).status).toBe(409);
    expect(f.sql.prepare("SELECT enabled FROM file_shadow_runtime_guard").get()!.enabled).toBe(1);
    expect((await f.post("/disable", { runtimeIncarnation: runtime, expectedEpoch: f.epoch() })).status).toBe(200);
    expect((await f.post("/enable", { requestId: runtime, expectedEpoch: f.epoch(), expectedIncarnation: runtime })).status).toBe(409);
    expect(f.sql.prepare("SELECT enabled FROM file_shadow_runtime_guard").get()!.enabled).toBe(0);
    f.noProvider();
  });

  it("fences profile write admission by profile revision, namespace, epoch and enabled incarnation", async () => {
    const f = fixture(), runtime = await f.enable();
    const valid = { profile: { profileId: "http-profile", configurationRevision: 1 }, runtimeIncarnation: runtime, expectedEpoch: f.epoch() };
    expect((await f.post("/profiles/enable", { ...valid, profile: { profileId: "http-profile", configurationRevision: 2 } })).status).toBe(400);
    expect((await f.post("/profiles/enable", { ...valid, profile: { ...valid.profile, credential: "secret" } })).status).toBe(400);
    expect((await f.post("/profiles/enable", { ...valid, runtimeIncarnation: crypto.randomUUID() })).status).toBe(409);
    expect((await f.post("/profiles/enable", { ...valid, expectedEpoch: valid.expectedEpoch + 1 })).status).toBe(409);
    const otherNamespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "b".repeat(32), bucketName: "shadow-http-test" });
    expect((await f.post("/profiles/enable", valid, {}, { ...f.env, R2_BOOTSTRAP_NAMESPACE: otherNamespace })).status).toBe(409);
    expect(f.sql.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id='http-profile'").get()!.state).toBe("read_only");
    expect((await f.post("/profiles/enable", valid)).status).toBe(200);
    expect(f.sql.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id='http-profile'").get()!.state).toBe("read_write");
    expect((await f.post("/profiles/enable", { ...valid, expectedEpoch: f.epoch() })).status).toBe(200);
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_profile_enablements").get()!.n).toBe(1);
    f.noProvider();
  });

  it("never revives an earlier executor incarnation after another enable/disable cycle", async () => {
    const f = fixture(), first = await f.enable();
    expect((await f.post("/disable", { runtimeIncarnation: first, expectedEpoch: f.epoch() })).status).toBe(200);
    const second = await f.enable(crypto.randomUUID(), first);
    expect((await f.post("/disable", { runtimeIncarnation: second, expectedEpoch: f.epoch() })).status).toBe(200);
    expect((await f.post("/enable", { requestId: first, expectedEpoch: f.epoch(), expectedIncarnation: second })).status).toBe(409);
    expect(f.sql.prepare("SELECT enabled,incarnation FROM file_shadow_runtime_guard").get()).toEqual({ enabled: 0, incarnation: second });
    f.noProvider();
  });

  it("records current unresolved/pending counts and does not let old checkpoints authorize new generations", async () => {
    const f = fixture(), runtime = await f.enable();
    const response = await f.post("/baseline", { key: key() });
    expect(response.status).toBe(200);
    const baseline = await response.json() as { baselineSha256: string };
    const admission = await f.post("/admit-unresolved", { operationId: crypto.randomUUID(), key: key(),
      expectedBaselineSha256: baseline.baselineSha256, reason: "No historical locator", runtimeIncarnation: runtime });
    expect(admission.status).toBe(200);
    expect(await admission.json()).toMatchObject({ status: "admitted_unresolved", fileId: null, locationId: null });
    const requestId = crypto.randomUUID(), epoch = f.epoch();
    const checkpoint = await f.post("/checkpoint", { requestId, expectedEpoch: epoch, runtimeIncarnation: runtime });
    expect(checkpoint.status).toBe(200);
    expect(await checkpoint.json()).toMatchObject({ id: requestId, captured_epoch: epoch, current_count: 2,
      resolved_count: 0, unresolved_count: 1, pending_count: 1, captured_by: "local-development" });
    expect((await request(f.env, `/checkpoints/${requestId}`)).status).toBe(200);
    f.sql.prepare("UPDATE events SET asset_key=? WHERE id='event-a'").run("historical/replaced-source");
    const current = await request(f.env, "/status");
    expect(await current.json()).toMatchObject({ current_count: 2, unresolved_count: 0, pending_count: 2 });
    expect((await f.post("/checkpoint", { requestId: crypto.randomUUID(), expectedEpoch: epoch, runtimeIncarnation: runtime })).status).toBe(409);
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_checkpoints").get()!.n).toBe(1);
    f.noProvider();
  });

  it("requires an enabled runtime for checkpoints and hides nonexistent operation details", async () => {
    const f = fixture(), runtime = await f.enable();
    expect((await f.post("/operation", { operationId: crypto.randomUUID(), runtimeIncarnation: runtime })).status).toBe(404);
    await f.post("/disable", { runtimeIncarnation: runtime, expectedEpoch: f.epoch() });
    expect((await f.post("/checkpoint", { requestId: crypto.randomUUID(), expectedEpoch: f.epoch(), runtimeIncarnation: runtime })).status).toBe(409);
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_checkpoints").get()!.n).toBe(0);
    f.noProvider();
  });
});
