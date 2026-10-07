import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { acceptAndUploadR2Asset } from "../uploads/r2-upload-acceptance";
import { hasRecoveryAssetAliasEvidence } from "../files/native-asset-alias";
import { d1FileJobRepository } from "../files/jobs/d1-repository";
import { dispatchFileJobs, setFileJobExecution } from "../files/jobs/worker-runtime";
import { runFileGarbageCollection } from "../files/authority-gc";
import { saveStorageCandidate } from "../storage/configuration-registry";
import { startStorageCandidateCheck } from "../storage/candidate-check-service";
import { registerStorageProfile } from "../storage/storage-profile-admission-service";
import { activateNativeStorageProfile } from "../storage/native-profile-activation";
import { releaseSourceMaintenance } from "./maintenance";
import { convertedLegacyAllSlotsFixture } from "./legacy-all-slots-test-support";
import { createRecoveryTargetEngine, type RecoveryTargetInput } from "./target-import";
import { recoverySourceProfileId } from "./target-files";

const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const handles: DatabaseSync[] = [];
const directories: string[] = [];
let capability: Awaited<ReturnType<typeof nativeAcceptanceFixture>>;
let converted: Awaited<ReturnType<typeof convertedLegacyAllSlotsFixture>>;
let sql: DatabaseSync;
let environment: Env;

const read = (key: string, env = environment) => worker.fetch(new Request(`https://app.test/api/assets/${key}`), env, context);
const asset = (id = "legacy-unconsumed-asset") => sql.prepare(`SELECT a.*,f.active_location_id,l.object_key current_object_key,
  f.verified_sha256,f.verified_byte_size,e.id evidence_id FROM assets a
  JOIN file_usable_publications f ON f.file_id=a.file_id
  JOIN file_locations l ON l.id=f.active_location_id
  JOIN recovery_file_alias_evidence ae ON ae.table_name='assets' AND ae.alias_id=a.id
  JOIN recovery_file_evidence e ON e.id=ae.evidence_id AND e.destination_file_id=a.file_id WHERE a.id=?`).get(id)!;

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), "fp5-recovered-media-")); directories.push(directory);
  converted = await convertedLegacyAllSlotsFixture(directory, { mediaReadCases: true });
  capability = await nativeAcceptanceFixture(false, { throughMigration: "0022_fp5_recovery_evidence.sql" }); handles.push(capability.sql);
  sql = referenceTestDatabase(); handles.push(sql); sql.exec("PRAGMA foreign_keys=ON");
  const database = new SqliteD1Database(sql) as unknown as D1Database;
  const engine = createRecoveryTargetEngine({ ...capability.env, RECOVERY_DB: database, RECOVERY_TARGET_ID: "recovered-media-target" });
  const input: RecoveryTargetInput = {
    jobId: crypto.randomUUID(), incarnation: crypto.randomUUID().replaceAll("-", ""), ownerToken: crypto.randomUUID(), generation: 0,
    expectedTargetId: "recovered-media-target", records: converted.records, manifest: converted.manifest, mode: "historical", current: async () => true,
    mapping: [...new Set(converted.manifest.files.map(recoverySourceProfileId))].map(sourceProfileId => ({ sourceProfileId,
      destinationProfileId: "r2-profile", configurationRevision: 1 })),
    openPayload: async file => new Response(converted.capsulePayloads.get(file.path!)!.slice().buffer).body!,
  };
  let completed = false;
  for (let index = 0; index < 180; index++) {
    input.ownerToken = crypto.randomUUID(); input.generation++;
    const step = await engine.step(input);
    if (step.done) { expect(step.report?.verified).toBe(true); completed = true; break; }
  }
  expect(completed).toBe(true);
  // The recovery remains inert. This separately supplied fixture R2 binding is
  // the operator's target capability; no archived binding or key enables it.
  expect(sql.prepare("SELECT enabled FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0 });
  expect(sql.prepare("SELECT count(*) n FROM system_storage_native_bindings").get()).toEqual({ n: 0 });
  environment = { ...capability.env, DB: database, AUTH_MODE: "disabled" };
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  handles.splice(0).forEach(database => database.close());
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("historical asset URLs after actual V8 recovery", () => {
  it.each(["unconsumed", "occurrence"])("delivers the recovered %s alias with an original NULL SHA from its verified new location", async name => {
    const key = `legacy/${name}`, before = asset(`legacy-${name}-asset`);
    expect(before.sha256).toBeNull(); expect(before.r2_key).toBe(key);
    expect(before.current_object_key).toMatch(/^fp5-recovery\//);
    if (name === "unconsumed") expect(sql.prepare("SELECT count(*) n FROM file_consumer_projection WHERE legacy_r2_object_key=?").get(key)).toEqual({ n: 0 });
    capability.r2Get.mockClear(); capability.s3Fetch.mockClear();
    const response = await read(key);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(converted.payloads.get(key));
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(capability.r2Get).toHaveBeenCalledExactlyOnceWith(before.current_object_key);
    expect(capability.s3Fetch).not.toHaveBeenCalled();
    expect(sql.prepare("SELECT r2_key,sha256,file_id FROM assets WHERE id=?").get(before.id)).toEqual({ r2_key: key, sha256: null, file_id: before.file_id });
  });

  const faults = [
    ["missing alias evidence", (row: ReturnType<typeof asset>) => {
      sql.exec("DROP TRIGGER recovery_file_alias_evidence_delete_guard");
      sql.prepare("DELETE FROM recovery_file_alias_evidence WHERE table_name='assets' AND alias_id=?").run(row.id);
    }],
    ["wrong original source key", (row: ReturnType<typeof asset>) => {
      sql.exec("DROP TRIGGER recovery_file_alias_evidence_update_guard");
      sql.prepare("UPDATE recovery_file_alias_evidence SET original_json=json_set(original_json,'$.r2_key','wrong/source') WHERE table_name='assets' AND alias_id=?").run(row.id);
    }],
    ["wrong original alias metadata", (row: ReturnType<typeof asset>) => {
      sql.exec("DROP TRIGGER recovery_file_alias_evidence_update_guard");
      sql.prepare("UPDATE recovery_file_alias_evidence SET original_json=json_set(original_json,'$.original_name','different.png') WHERE table_name='assets' AND alias_id=?").run(row.id);
    }],
    ["missing nullable original cell", (row: ReturnType<typeof asset>) => {
      sql.exec("DROP TRIGGER recovery_file_alias_evidence_update_guard");
      sql.prepare("UPDATE recovery_file_alias_evidence SET original_json=json_remove(original_json,'$.sha256') WHERE table_name='assets' AND alias_id=?").run(row.id);
    }],
    ["wrong byte digest", (row: ReturnType<typeof asset>) => {
      sql.exec("DROP TRIGGER recovery_file_evidence_update_guard");
      sql.prepare("UPDATE recovery_file_evidence SET sha256=? WHERE id=?").run(String(row.verified_sha256) === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64), row.evidence_id);
    }],
    ["wrong exact provider namespace", (row: ReturnType<typeof asset>) => {
      sql.exec("DROP TRIGGER recovery_file_evidence_update_guard");
      sql.prepare("UPDATE recovery_file_evidence SET namespace_identity='different-recovery-namespace' WHERE id=?").run(row.evidence_id);
    }],
    ["wrong source locator tuple", (row: ReturnType<typeof asset>) => {
      sql.exec("DROP TRIGGER recovery_file_evidence_update_guard");
      sql.prepare("UPDATE recovery_file_evidence SET source_locator_json=json_set(source_locator_json,'$.objectKey','wrong/original') WHERE id=?").run(row.evidence_id);
    }],
    ["quarantined current publication", (row: ReturnType<typeof asset>) => {
      const at = new Date().toISOString();
      sql.prepare(`INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,expected_sha256,operation_id,detected_at,last_checked_at)
        VALUES(?,'missing',?,?,?, ?,?)`).run(row.active_location_id, row.verified_byte_size, row.verified_sha256, "recovery-read-quarantine", at, at);
    }],
  ] as const;
  it.each(faults)("refuses %s before provider I/O", async (_name, mutate) => {
    const before = asset(); capability.r2Get.mockClear(); capability.s3Fetch.mockClear();
    // Fixture corruption is isolated and rolled back, including the temporary
    // removal of immutable-history guards. Delivery always uses real readers.
    sql.exec("BEGIN");
    try {
      mutate(before);
      const response = await read("legacy/unconsumed");
      expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "Asset not found" });
      expect(capability.r2Get).not.toHaveBeenCalled(); expect(capability.s3Fetch).not.toHaveBeenCalled();
    } finally { sql.exec("ROLLBACK"); }
    expect(asset()).toEqual(before);
  });

  it("requires application authentication before resolving a recovered alias or reading providers", async () => {
    capability.r2Get.mockClear(); capability.s3Fetch.mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await read("legacy/unconsumed", { ...environment, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "https://fixture.cloudflareaccess.com", ACCESS_AUD: "fixture-audience" });
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
      expect(capability.r2Get).not.toHaveBeenCalled(); expect(capability.s3Fetch).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("preserves pre-0022 candidate reads and rejects absent aliases without referring to uninstalled recovery tables", async () => {
    const primaryGlobals = { fetch: globalThis.fetch, Request: globalThis.Request, FixedLengthStream: Reflect.get(globalThis, "FixedLengthStream") };
    try {
      const earlier = await nativeAcceptanceFixture(false, { throughMigration: "0020_fp4_research_packages.sql" }); handles.push(earlier.sql);
      const bytes = new TextEncoder().encode("Exact ordinary pre-recovery image");
      const uploaded = await acceptAndUploadR2Asset(earlier.env, { requestId: crypto.randomUUID(), actorEmail: earlier.actor,
        ingress: "ordinary_image", originalName: "before-recovery.png", mimeType: "image/png", bytes: bytes.slice().buffer });
      expect(uploaded.state.status).toBe("ready"); if (uploaded.state.status !== "ready") throw new Error("Historical upload did not publish");
      const env = { ...earlier.env, AUTH_MODE: "disabled" } as Env;
      expect(await hasRecoveryAssetAliasEvidence(earlier.db)).toBe(false);
      const ready = await read(uploaded.state.result.key!, env);
      expect(ready.status).toBe(200); expect(new Uint8Array(await ready.arrayBuffer())).toEqual(bytes);
      earlier.r2Get.mockClear(); earlier.s3Fetch.mockClear();
      const absent = await read("absent/legacy-alias", env);
      expect(absent.status).toBe(404); expect(earlier.r2Get).not.toHaveBeenCalled(); expect(earlier.s3Fetch).not.toHaveBeenCalled();
    } finally {
      for (const [name, value] of Object.entries(primaryGlobals)) vi.stubGlobal(name, value);
    }
  });

  it("keeps the NULL-SHA URL usable after real FP3 R2-to-S3 migration and garbage collection of its recovery placement", async () => {
    const before = asset("legacy-occurrence-asset"), actor = capability.actor;
    const env = { ...capability.env, DB: environment.DB };
    // Separately model the reviewed operator handoff. Every admission,
    // migration, publication and GC guard remains installed throughout.
    await releaseSourceMaintenance(env, actor, 0);
    sql.prepare("UPDATE file_authority_runtime_guard SET enabled=1,incarnation=?,enabled_by=?,updated_at=? WHERE singleton=1")
      .run(crypto.randomUUID(), actor, new Date().toISOString());
    const saved = await saveStorageCandidate(env, { expectedRevision: null, label: "Recovered File migration destination",
      namespace: { kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "recovered-migration-fixture",
        root: "moved", forcePathStyle: true, expectedBucketOwner: "111122223333" },
      credentials: { mode: "replace", value: { accessKeyId: "fixture-new-target", secretAccessKey: "fixture-new-target-secret" } } }, actor);
    const check = await startStorageCandidateCheck(env, { checkId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1 }, actor, { fetch: capability.s3Fetch });
    expect(check.status).toBe("succeeded");
    const admission = await registerStorageProfile(env, { operationId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1,
      expectedEnvelopeRevision: 1, checkId: check.id }, actor);
    await activateNativeStorageProfile(env, { operationId: crypto.randomUUID(), nativeProfileId: admission.nativeProfileId,
      candidateProfileId: saved.profileId, expectedCandidateRevision: 1, expectedEnvelopeRevision: 1, checkId: check.id, expectedBindingRevision: null }, actor);
    await setFileJobExecution(env, true);
    const repository = d1FileJobRepository(env.DB);
    const job = await repository.accept({ requestId: crypto.randomUUID(), fileIds: [String(before.file_id)],
      target: { profileId: admission.nativeProfileId, configurationRevision: 1 } }, actor, () => true);
    expect(await dispatchFileJobs(env)).toEqual({ jobId: job.id, outcome: "moved" });
    const after = asset("legacy-occurrence-asset");
    expect(after.file_id).toBe(before.file_id); expect(after.active_location_id).not.toBe(before.active_location_id);
    await repository.requestCleanup(job.id, actor, () => true);
    sql.prepare("UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), job.id);
    expect((await dispatchFileJobs(env)).outcome).toBe("released_to_gc");
    const now = new Date().toISOString();
    sql.prepare("INSERT INTO file_location_gc_ledger(location_id,state,orphaned_at,updated_at) VALUES(?,'orphaned',?,?)")
      .run(before.active_location_id, now, now);
    await runFileGarbageCollection(env, new Date(Date.now() + 8 * 86_400_000));
    expect(sql.prepare("SELECT state FROM file_location_gc_ledger WHERE location_id=?").get(before.active_location_id)).toEqual({ state: "deleted" });
    expect(capability.r2Objects.has(String(before.current_object_key))).toBe(false);
    capability.r2Get.mockClear(); capability.s3Fetch.mockClear();
    const response = await read("legacy/occurrence");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(converted.payloads.get("legacy/occurrence"));
    expect(capability.r2Get).not.toHaveBeenCalled();
    expect(capability.s3Fetch.mock.calls.map(([input]) => (input as Request).method)).toEqual(["GET"]);
    expect(sql.prepare("SELECT r2_key,sha256,file_id FROM assets WHERE id=?").get(before.id)).toEqual({ r2_key: before.r2_key, sha256: null, file_id: before.file_id });
    expect(sql.prepare("SELECT location_id FROM recovery_file_evidence WHERE id=?").get(before.evidence_id)).toEqual({ location_id: before.active_location_id });
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }, 60_000);
});
