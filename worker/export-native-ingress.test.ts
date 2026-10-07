import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/domain/content-addressing";
import { validateFullExportV21 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV21 } from "../src/lib/exportAll";
import { snapshotFullExportV21 } from "./export-v21-snapshot";
import { nativeAcceptanceFixture } from "./uploads/native-acceptance-test-support";
import { acceptAndUploadMetrologyReference } from "./uploads/metrology-reference-acceptance";
import { routes as commentRoutes } from "./comment-submission-routes";
import { routes as importRoutes } from "./imports/fabublox-routes";
import { handleError } from "./platform/http";
import { setStorageRoleDefaults } from "./storage/storage-role-policy";
import type { Env } from "./types";

const databases: Awaited<ReturnType<typeof nativeAcceptanceFixture>>["sql"][] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(sql => sql.close()); });
const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
async function fixture() {
  const f = await nativeAcceptanceFixture(false); databases.push(f.sql);
  f.sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('metrology-family','Metrology','module',?)").run(f.now);
  f.sql.prepare("INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at,template_kind) VALUES('metrology-template','metrology-family','Metrology','module',1,'manifest','{}',?,'metrology')").run(f.now);
  expect((await acceptAndUploadMetrologyReference(f.env, { actorEmail: f.actor, requestId: crypto.randomUUID(),
    templateId: "metrology-template", originalName: "reference.png", mimeType: "image/png", bytes: bytes.slice().buffer })).state.status).toBe("ready");
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.onError(handleError); app.use("*", async (c, next) => { c.set("userEmail", f.actor); await next(); });
  app.route("/api", commentRoutes); app.route("/api", importRoutes);
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`https://app.test/api${path}`, init), f.env, context);
  const create = await request("/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    protocol: "comment-submission/1", id: "archive-comment", body: "", context: { kind: "sample", sampleId: "sample-native", expectedUpdatedAt: f.now },
    items: [{ id: "archive-original", kind: "attachment", filename: "original.bin", mimeType: "application/octet-stream",
      byteSize: bytes.length, sha256: await sha256Hex(bytes.slice().buffer), relatedCommentImageId: "archive-preview" },
    { id: "archive-preview", kind: "comment_image", filename: "preview.png", mimeType: "image/png", byteSize: bytes.length,
      sha256: await sha256Hex(bytes.slice().buffer), originalFilename: "original.bin", originalMimeType: "application/octet-stream",
      originalByteSize: bytes.length, relatedAttachmentId: "archive-original" }],
  }) });
  expect(create.status, await create.clone().text()).toBe(201);
  for (const id of ["archive-original", "archive-preview"]) {
    const uploaded = await request(`/comment-submissions/archive-comment/items/${id}/content`, { method: "PUT", body: bytes.slice().buffer,
      headers: { "content-type": id === "archive-original" ? "application/octet-stream" : "image/png",
        "x-upload-size": String(bytes.length), "x-content-sha256": await sha256Hex(bytes.slice().buffer) } });
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  }
  const finalized = await request("/comment-submissions/archive-comment/finalize", { method: "POST" });
  expect(finalized.status, await finalized.clone().text()).toBe(200);
  const importManifest = { schemaVersion: 2, title: "Native archive workflow", source: { fileName: "source.xlsx",
    fileSha256: await sha256Hex(bytes.slice().buffer), sheetName: "Process" }, initialSubstrateStep: null, initialStateImageIds: [], warnings: [],
    steps: [{ localId: "step", sourceRow: 2, position: 0, stepNumber: "1", sectionName: null, name: "Etch", toolName: null,
      parametersText: null, commentsText: null, imageIds: ["image"], rawCells: {} }],
    images: [{ localId: "image", sourcePart: "xl/media/image.png", mimeType: "image/png", assignedStepLocalId: "step", anchor: {} }] };
  const form = new FormData(); form.set("workbook", new File([bytes], "source.xlsx"));
  form.set("manifest", new File([JSON.stringify(importManifest)], "manifest.json", { type: "application/json" }));
  form.set("image:image", new File([bytes], "image.png", { type: "image/png" }));
  const imported = await request("/imports/fabublox", { method: "POST", headers: { "X-Import-Request-Id": crypto.randomUUID() }, body: form });
  expect(imported.status, await imported.clone().text()).toBe(201);
  await setStorageRoleDefaults(f.env, { operationId: crypto.randomUUID(), expectedPolicyRevision: 3,
    internalProfileId: "r2-profile", originalsProfileId: "r2-profile" }, f.actor);
  return { ...f, manifest: await snapshotFullExportV21(f.env.DB) };
}

describe("native mixed ingress archive provenance", () => {
  it("authenticates metrology, split Comment roles and per-file import targets after current defaults change", async () => {
    const f = await fixture();
    expect(f.manifest.tables.imports[0]).toMatchObject({ file_targets_protocol: 1, storage_policy_revision: null,
      storage_profile_id: null, storage_profile_revision: null, role_policy_revision: 3 });
    expect(f.manifest.tables.import_file_acceptances).toHaveLength(3);
    expect(f.manifest.tables.comment_item_acceptances.map(row => row.storage_profile_id).sort()).toEqual(["r2-profile", f.admission.nativeProfileId].sort());
    await expect(validateFullExportV21(f.manifest)).resolves.toMatchObject({ schemaVersion: 21 });
    expect(f.manifest.tables.storage_role_defaults[0].policy_revision).toBe(4);
    expect(f.manifest.blobs.some(row => row.provider === "s3" && row.storeKind === "file")).toBe(true);
    expect(f.manifest.blobs.some(row => row.provider === "r2")).toBe(true);
    expect(f.manifest.tables.file_retention_edges.some(row => row.occurrence_type === "metrology_template_reference")).toBe(true);
    expect(f.manifest.tables.file_retention_edges.some(row => row.occurrence_type === "comment_submission_item")).toBe(true);
    expect(f.manifest.tables.file_retention_edges.some(row => row.occurrence_type === "import_workbook")).toBe(true);
  }, 30_000);

  it("rejects rewritten target selections and deleted retention roots before requesting bytes", async () => {
    const { manifest } = await fixture();
    for (const kind of ["policy", "target", "comment", "metrology", "retention", "location-retention"] as const) {
      const forged = structuredClone(manifest);
      if (kind === "policy") forged.tables.storage_role_policy_revisions.filter(row => row.policy_revision === 4).forEach(row => {
        row.operation_id = forged.tables.storage_role_policy_revisions.find(row => row.policy_revision === 3)!.operation_id;
      });
      if (kind === "target") forged.tables.import_file_acceptances.find(row => row.item_id === "workbook")!.storage_profile_id = "r2-profile";
      if (kind === "comment") forged.tables.comment_item_acceptances[0].role_selection_revision = 4;
      if (kind === "metrology") forged.tables.metrology_reference_upload_requests[0].role_policy_revision = 4;
      if (kind === "retention") forged.tables.file_content_retention_edges = [];
      if (kind === "location-retention") forged.tables.file_location_retention_edges = [];
      const fetcher = vi.fn(); await expect(buildFullExportArchiveV21(forged, undefined, fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    }
  }, 30_000);
});
