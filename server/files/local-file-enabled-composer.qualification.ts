import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { hashRecipeManifest, hashStateRepresentation, hashStepDefinition } from "../../shared/content-addressing";
import * as sqlite from "../sqlite";
import { actor, count, fixture, it, volumes } from "./local-file-enabled-composer.qualification-support";

// These controls dispatch through the ORIGINAL Node application and actual
// loopback server. No alternate Hono facade, direct policy invocation, fabricated
// research upload, provider double, Group grant or production startup is used.
type Fixture = Awaited<ReturnType<typeof fixture>>;
const SAMPLE = "/api/samples/execution-sample", STEPS = SAMPLE + "/runs/execution-run/steps";
const TEMPLATE = "/api/templates/execution-template";
const bytes = new TextEncoder().encode("Actual same-host immutable File image 🧪");
const digest = createHash("sha256").update(bytes).digest("hex");
const businessTables = ["samples", "runs", "run_steps", "run_step_assets", "events", "template_versions", "template_steps", "step_definitions", "state_representations", "state_representation_assets", "state_verifications", "state_verification_steps"] as const;
function full(native: DatabaseSync, table: string) {
  const statement = native.prepare(`SELECT * FROM ${table} ORDER BY 1`); statement.setReadBigInts(true); return statement.all();
}
function rows(native: DatabaseSync, tables: readonly string[] = businessTables) { return tables.map(table => [table, full(native, table)]); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Original actual JSON object required");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  const id = object(value).id; if (typeof id !== "string" || !id) throw new Error("Original actual identifier required"); return id;
}
function released(native: DatabaseSync) {
  expect(count(native, "system_recovery_write_leases", "released_at IS NULL")).toBe(0);
  expect(native.prepare("SELECT DISTINCT owner,kind FROM system_recovery_write_leases").all()).toEqual([{ owner: actor, kind: "http" }]);
  expect(count(native, "local_admin_grants")).toBe(0);
  expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}
async function upload(f: Fixture) {
  const requestId = crypto.randomUUID();
  const answer = await f.request("POST", "/api/assets", bytes, { "content-type": "image/png",
    "x-filename": "actual-original.png", "x-upload-request-id": requestId });
  expect(answer.status).toBe(201); expect(answer.headers.get("cache-control")).toBe("no-store");
  const assetId = identifier(answer.value);
  const asset = f.native.prepare("SELECT id,file_id,r2_key,status,storage_profile_id,sha256,byte_size FROM assets WHERE id=?").get(assetId)!;
  expect(asset).toMatchObject({ id: assetId, r2_key: null, status: "ready", storage_profile_id: volumes[0]!.profileId, sha256: digest, byte_size: bytes.byteLength });
  expect(typeof asset.file_id).toBe("string");
  expect(f.native.prepare("SELECT purpose,access_scope,verified_sha256,verified_byte_size FROM file_usable_publications WHERE file_id=?").get(asset.file_id))
    .toEqual({ purpose: "embedded_content", access_scope: "system", verified_sha256: digest, verified_byte_size: bytes.byteLength });
  return { assetId, fileId: String(asset.file_id), requestId };
}
function definition(name: string, assetId?: string) { return { name, toolName: "SEM", parametersText: "Actual parameter 🧪", commentsText: "Original same-host notes", ...(assetId ? { assetId } : {}) }; }
function sampleInput(f: Fixture, body: string) {
  const row = f.native.prepare("SELECT status,location,pinned,updated_at FROM samples WHERE id='execution-sample'").get()!;
  return { status: row.status, location: row.location ?? "", pinned: Boolean(row.pinned), expectedUpdatedAt: row.updated_at, body };
}

it("mounts real ordinary upload and Definition writes on one original application File owner with exact SSOT bindings", async () => {
  const f = await fixture(), accepted = await upload(f), before = full(f.native, "template_versions");
  const value = definition("Same-host actual local diagram", accepted.assetId);
  const created = await f.request("POST", TEMPLATE + "/steps", value); expect(created.status).toBe(201);
  const stepId = identifier(created.value), state = await hashStateRepresentation([digest]), definitionHash = await hashStepDefinition(value);
  expect(f.native.prepare("SELECT definition_hash,expected_state_hash FROM template_steps WHERE id=?").get(stepId))
    .toEqual({ definition_hash: definitionHash.hash, expected_state_hash: state.hash });
  expect(f.native.prepare("SELECT asset_id,file_id FROM state_representation_assets WHERE state_hash=?").get(state.hash))
    .toEqual({ asset_id: accepted.assetId, file_id: accepted.fileId });
  const entries = f.native.prepare("SELECT logical_step_key,definition_hash,expected_state_hash FROM template_steps WHERE template_version_id='execution-template' ORDER BY position").all();
  const manifest = await hashRecipeManifest(entries.map(row => ({ logicalStepKey: String(row.logical_step_key), definitionHash: String(row.definition_hash), expectedStateHash: row.expected_state_hash === null ? null : String(row.expected_state_hash) })));
  expect(f.native.prepare("SELECT manifest_hash FROM template_versions WHERE id='execution-template'").get()?.manifest_hash).toBe(manifest);
  expect(full(f.native, "template_versions").filter(row => row.id !== "execution-template")).toEqual(before.filter(row => row.id !== "execution-template"));
  released(f.native);
});

it("routes ordinary active File Sample lifecycle through its four exact Request operations without administrator bypass", async () => {
  const f = await fixture(), oldSamples = full(f.native, "samples"), oldIds = new Set(oldSamples.map(row => row.id));
  const created = await f.request("POST", "/api/samples", { code: "COHERENT-LOCAL-1", title: "Before current update" });
  expect(created.status).toBe(201); const id = identifier(created.value);
  const initial = f.native.prepare("SELECT * FROM samples WHERE id=?").get(id)!;
  expect((await f.request("PATCH", `/api/samples/${id}`, { title: "After current update", expectedUpdatedAt: initial.updated_at })).status).toBe(200);
  const updated = f.native.prepare("SELECT * FROM samples WHERE id=?").get(id)!;
  expect(updated.title).toBe("After current update"); expect(updated.updated_by).toBe(actor);
  expect((await f.request("DELETE", `/api/samples/${id}`, { confirmationCode: updated.code, expectedUpdatedAt: updated.updated_at })).status).toBe(200);
  const deleted = f.native.prepare("SELECT * FROM samples WHERE id=?").get(id)!; expect(typeof deleted.deleted_at).toBe("string");
  expect((await f.request("POST", `/api/samples/${id}/restore`, { confirmationCode: deleted.code, expectedUpdatedAt: deleted.updated_at })).status).toBe(200);
  expect(f.native.prepare("SELECT deleted_at FROM samples WHERE id=?").get(id)?.deleted_at).toBeNull();
  expect(full(f.native, "samples").filter(row => oldIds.has(row.id))).toEqual(oldSamples); released(f.native);
});

it("creates a mounted native File Sample record while preserving every inherited audit row and rejecting stale CAS", async () => {
  const f = await fixture(), accepted = await upload(f), value = sampleInput(f, "Same-host actual image observation");
  const before = full(f.native, "events"), ids = new Set(before.map(row => row.id));
  const created = await f.request("POST", SAMPLE + "/records", { ...value, assetId: accepted.assetId }); expect(created.status).toBe(201);
  const after = full(f.native, "events"); expect(after.filter(row => ids.has(row.id))).toEqual(before);
  const added = after.filter(row => !ids.has(row.id)); expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ kind: "image", body: value.body, asset_key: null, asset_file_id: accepted.fileId, actor_email: actor });
  expect(JSON.parse(String(added[0]!.metadata_json))).toEqual({ action: "sample_record", assetId: accepted.assetId });
  const snapshot = rows(f.native); expect((await f.request("POST", SAMPLE + "/records", value)).status).toBe(409);
  expect(rows(f.native)).toEqual(snapshot); released(f.native);
});

it("returns original201 from mounted verify-state and preserves complete native evidence coverage and stale CAS", async () => {
  const f = await fixture(), accepted = await upload(f), before = full(f.native, "events"), ids = new Set(before.map(row => row.id));
  const value = { expectedUpdatedAt: f.native.prepare("SELECT updated_at FROM run_steps WHERE id='execution-step'").get()!.updated_at,
    result: "matched", note: "Actual same-host verification", completeStep: true, assetId: accepted.assetId };
  const answer = await f.request("POST", STEPS + "/execution-step/verify-state", value); expect(answer.status).toBe(201);
  const verificationId = identifier(object(answer.value).verification);
  expect(f.native.prepare("SELECT evidence_asset_id,evidence_file_id,result,note,actor_email FROM state_verifications WHERE id=?").get(verificationId))
    .toEqual({ evidence_asset_id: accepted.assetId, evidence_file_id: accepted.fileId, result: "matched", note: value.note, actor_email: actor });
  expect(f.native.prepare("SELECT verification_id,run_step_id,ordinal FROM state_verification_steps WHERE verification_id=?").all(verificationId))
    .toEqual([{ verification_id: verificationId, run_step_id: "execution-step", ordinal: 0 }]);
  const after = full(f.native, "events"); expect(after.filter(row => ids.has(row.id))).toEqual(before);
  expect(after.filter(row => !ids.has(row.id) && row.kind === "verification")).toHaveLength(1);
  const snapshot = rows(f.native); expect((await f.request("POST", STEPS + "/execution-step/verify-state", value)).status).toBe(409);
  expect(rows(f.native)).toEqual(snapshot); released(f.native);
});

it("denies embedded-content upload as a Project research source without fabricating an unavailable upload ingress", async () => {
  const f = await fixture(), accepted = await upload(f);
  const tables = ["projects", "project_contents", "project_content_attachments", "project_items", "project_map_placements", "project_edges"];
  const before = rows(f.native, tables);
  const answer = await f.request("POST", "/api/projects/project-source/items/attachment", {
    contentId: "actual-content", itemId: "actual-item", placementId: "actual-placement", locator: { assetId: accepted.assetId },
    caption: "Original current research caption", sourceUrl: null, geometry: { x: 1, y: -2, width: 300, height: 200, zIndex: 3 },
    expectedProjectRevision: 1, operationId: "actual-project-purpose-refusal",
  });
  expect(answer.status).toBe(409); expect(answer.value).toEqual({ error: "The attachment has no available File for this purpose" });
  expect(rows(f.native, tables)).toEqual(before); released(f.native);
});

it("rechecks the real mounted Request session inside native mutation BEGIN before any complete business cell changes", async () => {
  const f = await fixture(), before = rows(f.native), other = f.secondary();
  const run = sqlite.runSqliteAdmittedBatch, exec = f.native.exec.bind(f.native); let armed = false, observed = false;
  vi.spyOn(sqlite, "runSqliteAdmittedBatch").mockImplementation((...args) => {
    if (args[0] === f.database && args[1].length === 6) armed = true;
    return run(...args);
  });
  vi.spyOn(f.native, "exec").mockImplementation(sql => {
    if (sql === "BEGIN IMMEDIATE" && armed && !observed) {
      observed = true; other.prepare("UPDATE local_sessions SET revoked_at=? WHERE token_hash=?").run(Date.now(), f.tokenHash);
    }
    return exec(sql);
  });
  const answer = await f.request("POST", TEMPLATE + "/steps", definition("Actual revoked mutation"));
  expect(answer.status).toBe(401); expect(observed).toBe(true); expect(rows(f.native)).toEqual(before); released(f.native);
});

it("retains the genuine first body chunk through original application drain until EOF and sole native physical ACK", async () => {
  const f = await fixture(), native = f.native, value = definition("Original held whole-application diagram");
  const encoder = new TextEncoder(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(current) { controller = current; controller.enqueue(encoder.encode("{")); } });
  const original = f.request("POST", TEMPLATE + "/steps", body); let drain: Promise<void> | undefined, closed = false;
  try {
    await expect.poll(() => count(native, "system_recovery_write_leases", "released_at IS NULL"), { timeout: 1000 }).toBe(1);
    expect(native.prepare("SELECT owner,kind,released_at FROM system_recovery_write_leases WHERE released_at IS NULL").get())
      .toEqual({ owner: actor, kind: "http", released_at: null });
    drain = f.stopAndDrainApplication(); drain.then(() => { closed = true; }, () => undefined);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(closed).toBe(false); expect(native.isOpen).toBe(true);
  } finally { controller.enqueue(encoder.encode(JSON.stringify(value).slice(1))); controller.close(); await original; }
  expect((await original).status).toBe(201); await drain; expect(closed).toBe(true); expect(native.isOpen).toBe(false);
  // Reacquire a real new owner only after the original prototype acknowledged
  // its full drain/native/physical release; inspect the committed original.
  await f.restart();
  const definitionHash = await hashStepDefinition(value);
  expect(f.native.prepare("SELECT count(*) n FROM template_steps WHERE definition_hash=?").get(definitionHash.hash)?.n).toBe(1);
  released(f.native);
});

it("restarts one explicit configured owner and reads the same published bytes without rebuilding or reinitializing storage", async () => {
  const f = await fixture(), accepted = await upload(f), before = rows(f.native, ["files", "file_locations", "assets", "r2_upload_requests"]);
  const original = f.native;
  await f.restart(); expect(original.isOpen).toBe(false); expect(f.native === original).toBe(false);
  const answer = await f.request("GET", "/api/file-assets/" + accepted.assetId);
  expect(answer.status).toBe(200); expect(answer.value).toBe(new TextDecoder().decode(bytes));
  expect(answer.headers.get("cache-control")).toBe("private, no-store");
  expect(rows(f.native, ["files", "file_locations", "assets", "r2_upload_requests"])).toEqual(before);
  expect(createHash("sha256").update(String(answer.value)).digest("hex")).toBe(digest); released(f.native);
});
