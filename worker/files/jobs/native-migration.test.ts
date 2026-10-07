import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase } from "../../reference-test-support";
import { nativeAssetUrl } from "../../../shared/contracts/r2-upload";
import { sha256Hex } from "../../../shared/content-addressing";
import { routes as commentRoutes } from "../../comment-submission-routes";
import { handleError } from "../../platform/http";
import { routes as mediaRoutes } from "../../reference-routes";
import { routes as sampleRoutes } from "../../samples/routes";
import { startStorageCandidateCheck } from "../../storage/candidate-check-service";
import { saveStorageCandidate } from "../../storage/configuration-registry";
import { activateNativeStorageProfile } from "../../storage/native-profile-activation";
import { registerStorageProfile } from "../../storage/storage-profile-admission-service";
import { setStorageRoleDefaults } from "../../storage/storage-role-policy";
import type { Env } from "../../types";
import { nativeAcceptanceFixture } from "../../uploads/native-acceptance-test-support";
import { acceptAndUploadR2Asset } from "../../uploads/r2-upload-acceptance";
import { runFileGarbageCollection } from "../authority-gc";
import { readPublishedFile } from "../authority-reader";
import { d1FileJobRepository } from "./d1-repository";
import { dispatchFileJobs, inspectWorkerFileJobRuntime, setFileJobExecution } from "./worker-runtime";

const databases: Awaited<ReturnType<typeof nativeAcceptanceFixture>>["sql"][] = [];
let fixtureDirectory: string | undefined;
let pristinePath: string | undefined;
let nextFixture = 0;
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

function fixtureImage(database: DatabaseSync) {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all() as { name: string }[];
  const withoutRowid = new Set((database.prepare("PRAGMA table_list").all() as { name: string; wr: number }[])
    .filter((table) => table.wr === 1).map((table) => table.name));
  return { schema, tables: Object.fromEntries(tables.map(({ name }) => {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as { name: string; pk: number }[];
    const primaryKey = columns.filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk).map((column) => quoteIdentifier(column.name));
    const storageTypes = columns.map((column, index) =>
      `typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(`_fixture_type_${index}`)}`).join(",");
    const rows = database.prepare(withoutRowid.has(name)
      ? `SELECT *,${storageTypes} FROM ${quoteIdentifier(name)} ORDER BY ${primaryKey.join(",")}`
      : `SELECT rowid AS _fixture_rowid,*,${storageTypes} FROM ${quoteIdentifier(name)} ORDER BY rowid`);
    rows.setReadBigInts(true);
    return [name, rows.all()];
  })) };
}

beforeAll(() => {
  // Build the actual FP3 migration schema once, then isolate every scenario
  // with a fresh physical copy. Native admission, runtime identity, provider
  // checks, uploads and every original scenario seed still run independently.
  fixtureDirectory = mkdtempSync(join(tmpdir(), "fp5-native-migration-"));
  pristinePath = join(fixtureDirectory, "pristine.sqlite");
  const database = referenceTestDatabase({ throughMigration: "0019_fp3_file_jobs.sql" });
  try {
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
    const expected = fixtureImage(database);
    database.exec(`VACUUM INTO '${pristinePath.replaceAll("'", "''")}'`);
    const cloned = new DatabaseSync(pristinePath, { readOnly: true });
    try {
      expect(fixtureImage(cloned)).toEqual(expected);
      expect(cloned.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      cloned.close();
    }
  } finally {
    database.close();
  }
});

function pristineDatabase(options: { throughMigration?: string } = {}) {
  if (options.throughMigration !== "0019_fp3_file_jobs.sql") throw new Error("Unexpected native migration fixture generation");
  if (!fixtureDirectory || !pristinePath) throw new Error("The canonical native migration fixture has not been initialized");
  const path = join(fixtureDirectory, `scenario-${nextFixture++}.sqlite`);
  copyFileSync(pristinePath, path);
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
}

const sourceBytes = new Uint8Array(256 * 1024 + 19).map((_, index) => index % 251);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(sql => sql.close()); });
afterAll(() => {
  databases.splice(0).forEach(sql => sql.close());
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function fixture(sourceNative = true, secondNative = false) {
  const f = await nativeAcceptanceFixture(sourceNative, { throughMigration: "0019_fp3_file_jobs.sql", databaseFactory: pristineDatabase });
  databases.push(f.sql);
  let destination = f.admission.nativeProfileId;
  if (secondNative) {
    const saved = await saveStorageCandidate(f.env, { expectedRevision: null, label: "Second native migration bucket",
      namespace: { kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "native-migration-destination",
        root: "migrated", forcePathStyle: true, expectedBucketOwner: "111122223333" },
      credentials: { mode: "replace", value: { accessKeyId: "fixture-target-access", secretAccessKey: "fixture-target-secret" } } }, f.actor);
    const check = await startStorageCandidateCheck(f.env, { checkId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1 }, f.actor, { fetch: f.s3Fetch });
    expect(check.status).toBe("succeeded");
    const admission = await registerStorageProfile(f.env, { operationId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1,
      expectedEnvelopeRevision: 1, checkId: check.id }, f.actor);
    await activateNativeStorageProfile(f.env, { operationId: crypto.randomUUID(), nativeProfileId: admission.nativeProfileId,
      candidateProfileId: saved.profileId, expectedCandidateRevision: 1, expectedEnvelopeRevision: 1,
      checkId: check.id, expectedBindingRevision: null }, f.actor);
    destination = admission.nativeProfileId;
  }
  const requestId = crypto.randomUUID();
  const uploadInput = { requestId, actorEmail: f.actor, ingress: "ordinary_image" as const,
    originalName: "surface.png", mimeType: "image/png", bytes: sourceBytes.slice().buffer };
  const source = await acceptAndUploadR2Asset(f.env, uploadInput);
  expect(source.state.status).toBe("ready"); if (source.state.status !== "ready") throw new Error("Native migration source did not publish");
  const alias = f.sql.prepare("SELECT * FROM assets WHERE id=?").get(source.state.result.id)!;
  const file = f.sql.prepare(`SELECT f.file_id,f.active_location_id,l.storage_profile_id,l.object_key
    FROM file_usable_publications f JOIN file_location_publications l ON l.location_id=f.active_location_id`).get()!;
  await setFileJobExecution(f.env, true);
  expect(await inspectWorkerFileJobRuntime(f.env)).toMatchObject({ outcome: "available", incarnation: expect.any(String) });
  f.s3Fetch.mockClear(); f.r2Put.mockClear(); f.r2Get.mockClear(); f.r2Delete.mockClear();
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.onError(handleError); app.use("*", async (c, next) => { c.set("userEmail", f.actor); await next(); }); app.route("/api", mediaRoutes);
  app.route("/api", commentRoutes); app.route("/api", sampleRoutes);
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`https://app.test/api${path}`, init), f.env);
  const json = (path: string, body: unknown) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const nativeRead = () => app.fetch(new Request(`https://app.test${nativeAssetUrl(source.state.result.id)}`), f.env);
  const sourceRead = () => request(source.state.result.key === null
    ? `/file-assets/${source.state.result.id}` : `/assets/${source.state.result.key}`);
  const repository = () => d1FileJobRepository(f.env.DB);
  const puts = () => f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "PUT").map(([input]) => input as Request);
  const current = () => f.sql.prepare(`SELECT f.file_id,f.active_location_id,l.storage_profile_id,l.object_key
    FROM file_usable_publications f JOIN file_location_publications l ON l.location_id=f.active_location_id WHERE f.file_id=?`).get(file.file_id)!;
  const accept = (target = destination) => repository().accept({ requestId: crypto.randomUUID(), fileIds: [String(file.file_id)],
    target: { profileId: target, configurationRevision: 1 } }, f.actor, () => true);
  return { ...f, destination, source, alias, file, current, accept, repository, puts, nativeRead, sourceRead, uploadInput, request, json };
}

describe("FP3 independent jobs over real admitted native transports", () => {
  it.each(["S3→S3", "R2→S3", "S3→R2"] as const)("moves %s between exact registered namespaces and retains accepted target after defaults change", async direction => {
    const f = await fixture(direction !== "R2→S3", direction === "S3→S3");
    const target = direction === "S3→R2" ? "r2-profile" : f.destination;
    expect(target).not.toBe(f.file.storage_profile_id);
    const input = { requestId: crypto.randomUUID(), fileIds: [String(f.file.file_id)], target: { profileId: target, configurationRevision: 1 } };
    const plan = await f.repository().plan(input); expect(plan.bytesVerified).toBe(false); expect(plan.items[0].status).toBe("eligible");
    const accepted = await f.repository().accept(input, f.actor, () => true);
    expect(accepted).toMatchObject({ state: "queued", target: input.target });
    expect(f.s3Fetch).not.toHaveBeenCalled(); expect(f.r2Put).not.toHaveBeenCalled(); expect(f.r2Get).not.toHaveBeenCalled();
    await setStorageRoleDefaults(f.env, { operationId: crypto.randomUUID(), expectedPolicyRevision: 3,
      internalProfileId: "r2-profile", originalsProfileId: "r2-profile" }, f.actor);
    expect((await f.repository().accept(input, f.actor, () => true)).id).toBe(accepted.id);
    // A fresh independent invocation reconstructs owner/storage/persistence
    // capabilities; acceptance neither invokes nor retains a browser executor.
    expect(await dispatchFileJobs({ ...f.env })).toEqual({ jobId: accepted.id, outcome: "moved" });
    expect(await dispatchFileJobs({ ...f.env })).toEqual({ jobId: null, outcome: "idle" });
    expect(await f.repository().status(accepted.id)).toMatchObject({ state: "completed", moved: 1, remaining: 0, target: input.target });
    expect(f.current()).toMatchObject({ file_id: f.file.file_id, storage_profile_id: target });
    expect(f.current().active_location_id).not.toBe(f.file.active_location_id);
    expect(f.sql.prepare("SELECT * FROM assets WHERE id=?").get(f.alias.id)).toEqual(f.alias);
    expect(f.sql.prepare("SELECT state,io_settled_at FROM file_migration_attempts").get()).toMatchObject({ state: "published", io_settled_at: expect.any(String) });
    if (direction === "S3→R2") expect(f.r2Put).toHaveBeenCalledTimes(1);
    else {
      expect(f.puts()).toHaveLength(1);
      expect(f.puts()[0].headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(f.puts()[0].headers.get("x-amz-expected-bucket-owner")).toBe("111122223333");
      expect(new URL(f.puts()[0].url).pathname).toContain(direction === "S3→S3" ? "/native-migration-destination/migrated/" : "/native-comment-fixture/research/");
      if (direction === "S3→S3") expect(f.puts()[0].headers.get("authorization")).toContain("Credential=fixture-target-access/");
      expect(f.r2Put).not.toHaveBeenCalled();
    }
    const read = await readPublishedFile(f.env, { fileId: String(f.file.file_id), purpose: "embedded_content" });
    expect(read.outcome).toBe("available"); if (read.outcome !== "available") throw new Error("Missing migrated bytes");
    expect(new Uint8Array(await new Response(read.body).arrayBuffer())).toEqual(sourceBytes);
    const media = await f.sourceRead(); expect(media.status, await media.clone().text()).toBe(200);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(sourceBytes);
    expect(await acceptAndUploadR2Asset(f.env, f.uploadInput)).toEqual({ state: f.source.state, fresh: false });
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps the source current on corrupt readback, pauses without automatic PUT retry, then uses a fresh explicit attempt", async () => {
    const f = await fixture(true, true), job = await f.accept();
    const provider = f.s3Fetch.getMockImplementation()!; let corrupt = true;
    f.s3Fetch.mockImplementation(async (input, init) => {
      const request = input instanceof Request && !init ? input : new Request(input, init), result = await provider(input, init);
      if (corrupt && request.method === "GET" && request.url.includes("/native-migration-destination/") && request.url.includes("/file-migrations/") && result.ok) {
        const body = new Uint8Array(await result.arrayBuffer()); body[body.length - 1] ^= 1;
        return new Response(body, { headers: result.headers });
      }
      return result;
    });
    expect(await dispatchFileJobs(f.env)).toEqual({ jobId: job.id, outcome: "paused" });
    expect(f.current()).toEqual(f.file);
    expect(await f.repository().status(job.id)).toMatchObject({ state: "paused", moved: 0 });
    expect(f.sql.prepare("SELECT state,io_settled_at FROM file_migration_attempts").get()).toMatchObject({ state: "failed", io_settled_at: expect.any(String) });
    expect(await dispatchFileJobs(f.env)).toEqual({ jobId: null, outcome: "idle" }); expect(f.puts()).toHaveLength(1);
    corrupt = false;
    await f.repository().control(job.id, "retry");
    expect(await dispatchFileJobs({ ...f.env })).toEqual({ jobId: job.id, outcome: "moved" });
    expect(f.sql.prepare("SELECT object_key FROM file_migration_attempts ORDER BY object_key").all()).toHaveLength(2);
    expect(new Set(f.puts().map(request => request.url)).size).toBe(2);
    expect(f.current()).toMatchObject({ storage_profile_id: f.destination });
    const media = await f.nativeRead(); expect(media.status).toBe(200); expect(new Uint8Array(await media.arrayBuffer())).toEqual(sourceBytes);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains a held original stream through cutover and explicit source cleanup until EOF", async () => {
    const f = await fixture();
    const record = await f.json("/samples/sample-native/records", { status: "stored", location: "", pinned: false,
      expectedUpdatedAt: f.now, assetId: f.alias.id });
    expect(record.status, await record.clone().text()).toBe(201);
    const job = await f.accept("r2-profile");
    const read = await readPublishedFile(f.env, { fileId: String(f.file.file_id), purpose: "embedded_content" });
    expect(read.outcome).toBe("available"); if (read.outcome !== "available") throw new Error("Missing held source");
    expect(f.sql.prepare("SELECT location_id FROM file_location_holds WHERE hold_kind='read' AND released_at IS NULL").get()!.location_id).toBe(f.file.active_location_id);
    expect(await dispatchFileJobs(f.env)).toEqual({ jobId: job.id, outcome: "moved" });
    expect(f.current()).toMatchObject({ storage_profile_id: "r2-profile" });
    await f.repository().requestCleanup(job.id, f.actor, () => true);
    expect((await f.repository().items(job.id)).items[0].cleanupState).toBe("waiting_grace");
    expect((await dispatchFileJobs(f.env)).outcome).toBe("idle");
    // Model elapsed grace using the same guarded deadline update used by the
    // persistence qualification; every release/publication/GC guard stays on.
    f.sql.prepare("UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), job.id);
    expect((await dispatchFileJobs(f.env)).outcome).toBe("released_to_gc");
    expect((await f.repository().items(job.id)).items[0].cleanupState).toBe("released_to_gc");
    const orphan = () => f.sql.prepare("INSERT INTO file_location_gc_ledger(location_id,state,orphaned_at,updated_at) VALUES(?,'orphaned',?,?)")
      .run(f.file.active_location_id, new Date().toISOString(), new Date().toISOString());
    expect(orphan).toThrow();
    expect(new Uint8Array(await new Response(read.body).arrayBuffer())).toEqual(sourceBytes);
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE hold_kind='read' AND released_at IS NULL").get()!.n).toBe(0);
    expect(orphan).not.toThrow();
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const collected = await runFileGarbageCollection(f.env, later);
    expect(f.sql.prepare("SELECT state FROM file_location_gc_ledger WHERE location_id=?").get(f.file.active_location_id)!.state,
      JSON.stringify({ collected, retained: f.sql.prepare("SELECT * FROM file_location_retention_edges WHERE location_id=?").all(f.file.active_location_id) })).toBe("deleted");
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "DELETE")).toHaveLength(1);
    const media = await f.nativeRead(); expect(media.status, await media.clone().text()).toBe(200); expect(new Uint8Array(await media.arrayBuffer())).toEqual(sourceBytes);
    expect(f.sql.prepare("SELECT * FROM assets WHERE id=?").get(f.alias.id)).toEqual(f.alias);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("finalizes a pending native Comment after its already published item File migrates", async () => {
    const f = await fixture(true, true), commentBytes = sourceBytes.slice();
    commentBytes[0] ^= 1;
    const hash = await sha256Hex(commentBytes.buffer);
    const accepted = await f.json("/comment-submissions", { protocol: "comment-submission/1", id: "migration-parent", body: "Pending Comment",
      context: { kind: "sample", sampleId: "sample-native", expectedUpdatedAt: f.now }, items: [{ id: "migration-comment-item", kind: "comment_image",
        filename: "surface.png", mimeType: "image/png", byteSize: commentBytes.length, sha256: hash,
        originalFilename: "surface.png", originalMimeType: "image/png", originalByteSize: commentBytes.length }] });
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    const uploaded = await f.request("/comment-submissions/migration-parent/items/migration-comment-item/content", { method: "PUT", body: commentBytes.slice().buffer,
      headers: { "content-type": "image/png", "x-upload-size": String(commentBytes.length), "x-content-sha256": hash } });
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const item = f.sql.prepare("SELECT file_id,asset_id FROM comment_submission_items WHERE id='migration-comment-item'").get()!;
    const receipt = f.sql.prepare("SELECT accepted_result_json FROM comment_item_acceptances WHERE item_id='migration-comment-item'").get();
    const job = await f.repository().accept({ requestId: crypto.randomUUID(), fileIds: [String(item.file_id)],
      target: { profileId: f.destination, configurationRevision: 1 } }, f.actor, () => true);
    expect(await dispatchFileJobs(f.env)).toEqual({ jobId: job.id, outcome: "moved" });
    expect(f.sql.prepare("SELECT accepted_result_json FROM comment_item_acceptances WHERE item_id='migration-comment-item'").get()).toEqual(receipt);
    const finalized = await f.request("/comment-submissions/migration-parent/finalize", { method: "POST" });
    expect(finalized.status, await finalized.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT status FROM comment_submission_acceptances WHERE submission_id='migration-parent'").get()!.status).toBe("ready");
    const media = await f.request(`/file-assets/${item.asset_id}`); expect(media.status).toBe(200);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(commentBytes);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
