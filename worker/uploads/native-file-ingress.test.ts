import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../shared/content-addressing";
import type { R2UploadIngress } from "../../shared/contracts/r2-upload";
import type { RunStartPreview } from "../../shared/contracts/types";
import { routes as importRoutes } from "../imports/fabublox-routes";
import { routes as templateRoutes } from "../process-definition/routes";
import { routes as executionRoutes, verificationRoutes } from "../execution/routes";
import { routes as projectRoutes } from "../project-routes";
import { routes as referenceRoutes } from "../reference-routes";
import { routes as sampleRoutes } from "../samples/routes";
import { handleError } from "../platform/http";
import { setStorageRoleDefaults } from "../storage/storage-role-policy";
import type { Env } from "../types";
import { acceptAndUploadMetrologyReference } from "./metrology-reference-acceptance";
import { nativeAcceptanceActor, nativeAcceptanceFixture } from "./native-acceptance-test-support";
import { acceptAndUploadR2Asset } from "./r2-upload-acceptance";

const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const databases: DatabaseSync[] = [];
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); });

async function fixture(internalNative = true) {
  const f = await nativeAcceptanceFixture(internalNative); databases.push(f.sql);
  const errors: string[] = [], batch = f.db.batch.bind(f.db); let loseAck = false;
  vi.spyOn(f.db, "batch").mockImplementation(async statements => {
    try {
      const result = await batch(statements);
      if (loseAck && statements.some(statement => (statement as unknown as { sql: string }).sql.includes("INSERT INTO file_location_publications"))) {
        loseAck = false; throw new Error("Lost native File publication acknowledgement");
      }
      return result;
    } catch (error) { errors.push(String(error)); throw error; }
  });
  f.sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('metrology-family','Metrology','module',?)").run(f.now);
  f.sql.prepare(`INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at,template_kind)
    VALUES('metrology-template','metrology-family','Metrology','module',1,'manifest','{}',?,'metrology')`).run(f.now);
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.onError(handleError);
  app.use("*", async (c, next) => { c.set("userEmail", nativeAcceptanceActor); await next(); });
  app.route("/api", importRoutes); app.route("/api", templateRoutes);
  app.route("/api", executionRoutes); app.route("/api", verificationRoutes);
  app.route("/api", projectRoutes);
  app.route("/api", referenceRoutes);
  app.route("/api", sampleRoutes);
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`https://app.test/api${path}`, init), f.env, context);
  const json = (path: string, body: unknown, method = "POST") => request(path, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const base = { actorEmail: nativeAcceptanceActor, originalName: "image.png", mimeType: "image/png", bytes: bytes.slice().buffer };
  const ordinary = (ingress: R2UploadIngress = "ordinary_image", requestId = crypto.randomUUID()) => acceptAndUploadR2Asset(f.env, { ...base, ingress, requestId });
  const metrology = (requestId = crypto.randomUUID()) => acceptAndUploadMetrologyReference(f.env, { ...base, templateId: "metrology-template", requestId });
  const importWorkbook = async (requestId = crypto.randomUUID()) => request("/imports/fabublox", {
    method: "POST", headers: { "X-Import-Request-Id": requestId }, body: await importForm(),
  });
  const puts = () => f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "PUT");
  return { ...f, request, json, ordinary, metrology, importWorkbook, puts, errors, loseAck: () => { loseAck = true; } };
}

async function importForm() {
  const manifest = { schemaVersion: 2, title: "Native File workflow",
    source: { fileName: "source.xlsx", fileSha256: await sha256Hex(bytes.slice().buffer), sheetName: "Process" },
    initialSubstrateStep: { localId: "substrate", sourceRow: 1, position: 0, stepNumber: "0", sectionName: null,
      name: "Substrate Stack", toolName: null, parametersText: null, commentsText: null, imageIds: [], rawCells: {} },
    initialStateImageIds: [], warnings: [],
    steps: [{ localId: "step", sourceRow: 2, position: 0, stepNumber: "1", sectionName: null,
      name: "Etch", toolName: null, parametersText: null, commentsText: null, imageIds: ["image"], rawCells: {} }],
    images: [{ localId: "image", sourcePart: "xl/media/image.png", mimeType: "image/png", assignedStepLocalId: "step", anchor: {} }],
  };
  const form = new FormData();
  form.set("workbook", new File([bytes], "source.xlsx"));
  form.set("manifest", new File([JSON.stringify(manifest)], "manifest.json", { type: "application/json" }));
  form.set("image:image", new File([bytes], "image.png", { type: "image/png" }));
  return form;
}

describe("native File accepted ordinary and metrology ingress", () => {
  it.each(["ordinary", "metrology"] as const)("publishes %s atomically and replays a lost publication ACK without PUT after defaults change", async kind => {
    const f = await fixture(), requestId = crypto.randomUUID();
    f.loseAck();
    const upload = () => kind === "ordinary" ? f.ordinary("ordinary_image", requestId) : f.metrology(requestId);
    const first = await upload();
    expect(first.state.status).toBe("ready"); expect(first.fresh).toBe(true);
    if (first.state.status !== "ready") throw new Error("Native upload did not publish");
    const alias = f.sql.prepare("SELECT id,r2_key,file_id,storage_profile_id,storage_profile_revision,object_key FROM assets").get()!;
    expect(alias).toMatchObject({ r2_key: null, file_id: expect.any(String), storage_profile_id: f.admission.nativeProfileId,
      storage_profile_revision: 1, object_key: expect.any(String) });
    if (kind === "ordinary") expect(first.state.result).toEqual({ id: alias.id, key: null, storageKind: "native", fileId: alias.file_id,
      url: `/api/file-assets/${alias.id}`, deduplicated: false });
    else expect(first.state.result).toMatchObject({ assetId: alias.id, reference: { assetKey: null, fileId: alias.file_id, url: `/api/file-assets/${alias.id}` } });
    const media = await f.request(`/file-assets/${alias.id}`);
    expect(media.status, await media.clone().text()).toBe(200);
    expect(media.headers.get("cache-control")).toBe("private, no-store");
    expect(media.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(bytes);
    const legacyIdentity = await f.request(`/assets/by-id/${alias.id}`); expect(legacyIdentity.status).toBe(404);
    const table = kind === "ordinary" ? "r2_upload_requests" : "metrology_reference_upload_requests";
    const receipt = f.sql.prepare(`SELECT * FROM ${table}`).get()!;
    expect(receipt.role_policy_revision).toBe(3);
    await setStorageRoleDefaults(f.env, { operationId: crypto.randomUUID(), expectedPolicyRevision: 3,
      internalProfileId: "r2-profile", originalsProfileId: "r2-profile" }, nativeAcceptanceActor);
    const publications = f.sql.prepare("SELECT * FROM file_publications").all();
    const candidates = f.sql.prepare("SELECT * FROM file_acceptance_candidates").all();
    expect(await upload()).toEqual({ state: first.state, fresh: false });
    expect(f.sql.prepare(`SELECT * FROM ${table}`).get()).toEqual(receipt);
    expect(f.sql.prepare("SELECT * FROM file_publications").all()).toEqual(publications);
    expect(f.sql.prepare("SELECT * FROM file_acceptance_candidates").all()).toEqual(candidates);
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(0);
    expect(f.puts()).toHaveLength(1); expect(f.r2Put).not.toHaveBeenCalled(); expect(f.r2Get).not.toHaveBeenCalled();
    f.objects.clear();
    const missing = await f.request(`/file-assets/${f.sql.prepare("SELECT id FROM assets").get()!.id}`);
    expect(missing.status).toBe(404); expect(f.r2Get).not.toHaveBeenCalled(); expect(f.puts()).toHaveLength(1);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("separates embedded content from original purpose and shares the exact research File between metrology and Project attachments", async () => {
    const f = await fixture();
    const embedded = await f.ordinary(), metrology = await f.metrology(), project = await f.ordinary("project_attachment"), again = await f.metrology();
    for (const upload of [embedded, metrology, project, again]) expect(upload.state.status).toBe("ready");
    if (embedded.state.status !== "ready" || metrology.state.status !== "ready" || project.state.status !== "ready" || again.state.status !== "ready") throw new Error("Not ready");
    expect(project.state.result).toMatchObject({ id: metrology.state.result.assetId, key: null, fileId: metrology.state.result.reference.fileId, deduplicated: true });
    expect(project.state.result.id).not.toBe(embedded.state.result.id);
    expect(again.state.result).toEqual({ ...metrology.state.result, deduplicated: true });
    expect(f.sql.prepare("SELECT purpose,count(*) n FROM file_usable_publications GROUP BY purpose ORDER BY purpose").all())
      .toEqual([{ purpose: "embedded_content", n: 1 }, { purpose: "research_source", n: 1 }]);
    expect(f.sql.prepare("SELECT count(*) n FROM assets").get()!.n).toBe(2);
    const created = await f.json("/projects", { id: "project-native", title: "Native Project", operationId: "create-native-project" });
    expect(created.status, await created.clone().text()).toBe(201);
    const input = { contentId: "content-native", itemId: "item-native", placementId: "placement-native",
      locator: { assetId: project.state.result.id }, caption: null, sourceUrl: null,
      geometry: { x: 0, y: 0, width: 320, height: 180, zIndex: 0 }, expectedProjectRevision: 1, operationId: "create-native-attachment" };
    const attached = await f.json("/projects/project-native/items/attachment", input);
    expect(attached.status, await attached.clone().text()).toBe(201);
    expect(f.sql.prepare("SELECT file_id FROM project_content_attachments").get()!.file_id).toBe(metrology.state.result.reference.fileId);
    const replay = await f.json("/projects/project-native/items/attachment", input); expect(replay.status, await replay.clone().text()).toBe(200);
    const download = await f.request("/projects/project-native/contents/content-native/file");
    expect(download.status, await download.clone().text()).toBe(200); expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    const ref = metrology.state.result.reference;
    const removed = await f.json(`/metrology-templates/metrology-template/references/${ref.id}`, {}, "DELETE");
    expect(removed.status, await removed.clone().text()).toBe(200);
    const restored = await f.json(`/metrology-templates/metrology-template/references/${ref.id}/restore`, {});
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT file_id,deleted_at FROM metrology_template_references").get()).toEqual({ file_id: ref.fileId, deleted_at: null });
    // Each fresh accepted request owns one candidate write; File/alias reuse
    // happens only after that candidate's complete verification.
    expect(f.puts()).toHaveLength(4); expect(f.r2Put).not.toHaveBeenCalled();
  });

  it.each(["ordinary", "metrology"] as const)("rolls %s publication and alias binding back while an uncertain candidate cannot repeat PUT", async kind => {
    const f = await fixture(), requestId = crypto.randomUUID();
    const table = kind === "ordinary" ? "r2_upload_requests" : "metrology_reference_upload_requests";
    f.sql.exec(`CREATE TRIGGER test_reject_native_ready BEFORE UPDATE ON ${table} WHEN NEW.status='ready'
      BEGIN SELECT RAISE(ABORT,'test native receipt rejection'); END`);
    const upload = () => kind === "ordinary" ? f.ordinary("ordinary_image", requestId) : f.metrology(requestId);
    expect((await upload()).state.status).toBe("pending");
    for (const table of ["assets", "file_publications", "file_location_publications", "metrology_template_references"])
      expect(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT state FROM file_acceptance_candidates").get()!.state).toBe("candidate");
    f.sql.exec("DROP TRIGGER test_reject_native_ready");
    expect((await upload()).state.status).toBe("pending");
    expect(f.puts()).toHaveLength(1); expect(f.r2Put).not.toHaveBeenCalled();
  });

  it("observes corrupted native ready bytes without fallback, repair or receipt mutation", async () => {
    const f = await fixture(), requestId = crypto.randomUUID();
    const first = await f.ordinary("ordinary_image", requestId); expect(first.state.status).toBe("ready");
    const receipt = f.sql.prepare("SELECT * FROM r2_upload_requests").get();
    for (const key of f.objects.keys()) f.objects.set(key, new Uint8Array(bytes.length).buffer);
    const publications = f.sql.prepare("SELECT * FROM file_publications").all();
    expect((await f.ordinary("ordinary_image", requestId)).state.status).toBe("unavailable");
    expect(f.sql.prepare("SELECT * FROM r2_upload_requests").get()).toEqual(receipt);
    expect(f.sql.prepare("SELECT * FROM file_publications").all()).toEqual(publications);
    expect(f.sql.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(0);
    expect(f.puts()).toHaveLength(1); expect(f.r2Put).not.toHaveBeenCalled(); expect(f.r2Get).not.toHaveBeenCalled();
  });
});

describe("FabuBlox frozen per-file native targets", () => {
  it("freezes native provenance and R2 embedded targets before a default change and replays without provider writes", async () => {
    const f = await fixture(false), requestId = crypto.randomUUID();
    const fetch = f.s3Fetch.getMockImplementation()!; let changed = false;
    f.s3Fetch.mockImplementation(async (input, init) => {
      const request = input instanceof Request && !init ? input : new Request(input, init);
      if (!changed && request.method === "PUT") {
        changed = true;
        await setStorageRoleDefaults(f.env, { operationId: crypto.randomUUID(), expectedPolicyRevision: 3,
          internalProfileId: "r2-profile", originalsProfileId: "r2-profile" }, nativeAcceptanceActor);
      }
      return fetch(input, init);
    });
    const first = await f.importWorkbook(requestId), result = await first.clone().json() as { templateVersionId: string };
    expect(first.status, `${JSON.stringify(result)} ${f.errors.join("\n")}`).toBe(201);
    const receipt = f.sql.prepare("SELECT * FROM imports").get()!;
    expect(receipt).toMatchObject({ status: "ready", file_targets_protocol: 1, role_policy_revision: 3,
      storage_profile_id: null, storage_profile_revision: null, storage_policy_revision: null,
      workbook_asset_key: null, manifest_asset_key: null, workbook_file_id: expect.any(String), manifest_file_id: expect.any(String) });
    const targets = f.sql.prepare("SELECT item_id,purpose,storage_profile_id,role_policy_revision,status,result_file_id FROM import_file_acceptances ORDER BY item_id").all();
    expect(targets).toEqual([
      { item_id: "image:image", purpose: "embedded_content", storage_profile_id: "r2-profile", role_policy_revision: 3, status: "ready", result_file_id: expect.any(String) },
      { item_id: "manifest", purpose: "provenance", storage_profile_id: f.admission.nativeProfileId, role_policy_revision: 3, status: "ready", result_file_id: receipt.manifest_file_id },
      { item_id: "workbook", purpose: "provenance", storage_profile_id: f.admission.nativeProfileId, role_policy_revision: 3, status: "ready", result_file_id: receipt.workbook_file_id },
    ]);
    expect(f.sql.prepare("SELECT count(*) n FROM assets WHERE r2_key IS NULL AND file_id IS NOT NULL").get()!.n).toBe(2);
    expect(f.sql.prepare("SELECT count(*) n FROM assets WHERE r2_key IS NOT NULL").get()!.n).toBe(1);
    const changes = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const replay = await f.importWorkbook(requestId); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(result);
    expect(f.sql.prepare("SELECT * FROM imports").get()).toEqual(receipt);
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(changes);
    expect(f.puts()).toHaveLength(2); expect(f.r2Put).toHaveBeenCalledTimes(1);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects an incomplete companion inventory atomically before any provider I/O", async () => {
    const f = await fixture(false);
    f.sql.exec(`CREATE TRIGGER test_skip_import_target BEFORE INSERT ON import_file_acceptances WHEN NEW.item_id='image:image'
      BEGIN SELECT RAISE(IGNORE); END`);
    const response = await f.importWorkbook(); expect(response.status).toBe(503);
    for (const table of ["imports", "import_file_acceptances", "file_acceptance_candidates", "assets"])
      expect(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    expect(f.puts()).toHaveLength(0); expect(f.r2Put).not.toHaveBeenCalled(); expect(f.r2Get).not.toHaveBeenCalled();
  });

  it("binds native planned, execution and verification assets by File and preserves them through occurrence delete/restore", async () => {
    const f = await fixture(), imported = await f.importWorkbook();
    const result = await imported.clone().json() as { templateVersionId: string }; expect(imported.status, `${JSON.stringify(result)} ${f.errors.join("\n")}`).toBe(201);
    const detailResponse = await f.request(`/templates/${result.templateVersionId}`);
    const detail = await detailResponse.clone().json() as { template: { steps: Array<{ id: string; imageKeys: string[]; images: Array<{ assetId: string; fileId: string; url: string }> }> } };
    expect(detailResponse.status, JSON.stringify(detail)).toBe(200);
    expect(detail.template.steps[0].imageKeys).toEqual([]);
    const image = detail.template.steps[0].images[0]; expect(image).toMatchObject({ assetId: expect.any(String), fileId: expect.any(String), url: expect.stringMatching(/^\/api\/file-assets\//) });
    const previewResponse = await f.json("/samples/sample-native/runs/preview", { templateVersionId: result.templateVersionId });
    const preview = await previewResponse.json() as RunStartPreview;
    expect(previewResponse.status, JSON.stringify(preview)).toBe(200);
    const started = await f.json("/samples/sample-native/runs", { templateVersionId: result.templateVersionId, substrateConfirmation: {
      confirmed: true, expectedSampleUpdatedAt: preview.sampleUpdatedAt, expectedPreviousStateHash: preview.sampleCurrentState.hash,
      expectedTemplateStructureKey: preview.comparisonTarget?.key ?? null, expectedTemplateStateHash: preview.comparisonTarget?.stateHash ?? null,
      expectedLatestRunId: preview.expectedLatestRunId,
    } });
    const startResult = await started.clone().json() as { id: string }; expect(started.status, JSON.stringify(startResult)).toBe(201);
    const runId = String(f.sql.prepare("SELECT id FROM runs WHERE sample_id='sample-native'").get()!.id);
    const step = f.sql.prepare("SELECT id,updated_at FROM run_steps WHERE run_id=?").get(runId)!;
    const stepPath = `/samples/sample-native/runs/${runId}/steps/${step.id}`;
    const updated = await f.json(stepPath, { status: "in_progress", expectedUpdatedAt: step.updated_at,
      title: "Etch", toolName: "", parametersText: "", commentsText: "", deviationNote: "", notes: "", assetId: image.assetId }, "PATCH");
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT file_id FROM run_step_assets WHERE role='execution'").get()!.file_id).toBe(image.fileId);
    const event = f.sql.prepare("SELECT asset_key,asset_file_id,metadata_json FROM events WHERE kind='image'").get()!;
    expect(event.asset_key).toBe(null); expect(event.asset_file_id).toBe(image.fileId); expect(JSON.parse(String(event.metadata_json)).assetId).toBe(image.assetId);
    const deleted = await f.json(`${stepPath}/assets`, { assetId: image.assetId }, "DELETE");
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT deleted_at FROM run_step_assets WHERE role='execution'").get()!.deleted_at).toEqual(expect.any(String));
    const restored = await f.json(`${stepPath}/assets/restore`, { assetId: image.assetId });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT file_id,deleted_at FROM run_step_assets WHERE role='execution'").get()).toEqual({ file_id: image.fileId, deleted_at: null });
    const current = f.sql.prepare("SELECT updated_at FROM run_steps WHERE id=?").get(step.id)!;
    const verified = await f.json(`${stepPath}/verify-state`, { result: "matched", note: "Verified native bytes", expectedUpdatedAt: current.updated_at, assetId: image.assetId, completeStep: true });
    expect(verified.status, await verified.clone().text()).toBe(201);
    expect(f.sql.prepare("SELECT evidence_file_id FROM state_verifications").get()!.evidence_file_id).toBe(image.fileId);
    const verification = f.sql.prepare("SELECT id,evidence_file_id,evidence_asset_id FROM state_verifications").get()!;
    expect(f.sql.prepare("SELECT file_id FROM file_relational_retention_edges WHERE occurrence_type='state_verification_evidence'").get()!.file_id).toBe(image.fileId);
    const verificationEvent = f.sql.prepare("SELECT id FROM events WHERE kind='verification'").get()!;
    const detached = await f.request(`/samples/sample-native/events/${verificationEvent.id}/asset`, { method: "DELETE" });
    expect(detached.status, await detached.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT id,evidence_file_id,evidence_asset_id FROM state_verifications").get()).toEqual(verification);
    expect(f.sql.prepare("SELECT file_id FROM file_relational_retention_edges WHERE occurrence_type='state_verification_evidence'").all()).toEqual([]);
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "DELETE")).toHaveLength(0);
    expect(f.puts()).toHaveLength(3); expect(f.r2Put).not.toHaveBeenCalled();
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
