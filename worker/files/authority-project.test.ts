import { afterEach, expect, it, vi } from "vitest";
import { futureActiveRuntimeDatabase } from "./authority-runtime-test-support";
import { SqliteD1Database } from "../reference-test-support";
import { acceptAndUploadR2Asset } from "../uploads/r2-upload-acceptance";
import { createAttachmentProjectItem, createProject, removeProjectItem, restoreProjectItem } from "../projects/service";
import { copyAttachmentProjectItem } from "../projects/attachment-copy";
import type { Env } from "../types";

const databases: ReturnType<typeof futureActiveRuntimeDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(sql => sql.close()));

it("binds an accepted Project upload and its authorized copy to the same published File", async () => {
  const now = new Date().toISOString();
  const namespace = JSON.stringify({ kind: "local-r2", installationId: "537b0fa6-dd46-48ed-9fc4-6a8c95cb74c5", bucketName: "authority-project" });
  const sql = futureActiveRuntimeDatabase(db => {
    db.prepare("INSERT INTO storage_profiles VALUES('project-profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
    db.prepare("INSERT INTO file_shadow_profile_enablements VALUES('project-profile',1,'operator',?)").run(now);
  });
  databases.push(sql);
  const stored = new Map<string, Uint8Array>();
  const get = vi.fn(async (key: string) => {
    const value = stored.get(key);
    return value ? { body: new Response(value).body!, size: value.length, httpEtag: '"project"', writeHttpMetadata() {} } : null;
  });
  const put = vi.fn(async (key: string, body: BodyInit) => stored.set(key, new Uint8Array(await new Response(body).arrayBuffer())));
  const remove = vi.fn(async (key: string | string[]) => {
    for (const objectKey of typeof key === "string" ? [key] : key) stored.delete(objectKey);
  });
  const db = new SqliteD1Database(sql) as unknown as D1Database;
  const env = { DB: db, R2_BOOTSTRAP_NAMESPACE: namespace, ASSETS: { get, head: get, put, delete: remove } as unknown as R2Bucket } satisfies Env;
  const actor = "project@example.test";
  const uploaded = await acceptAndUploadR2Asset(env, { actorEmail: actor, ingress: "project_attachment", requestId: crypto.randomUUID(),
    originalName: "source.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("Project File bytes").buffer });
  expect(uploaded.state.status).toBe("ready");
  if (uploaded.state.status !== "ready") throw new Error("Upload did not publish");
  await createProject(db, { id: "active-project", title: "File project", operationId: "create-project" }, actor);
  const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };
  const created = await createAttachmentProjectItem(db, "active-project", {
    contentId: "source-content", itemId: "source-item", placementId: "source-placement",
    locator: { assetId: uploaded.state.result.id }, caption: null, sourceUrl: null, geometry,
    operationId: "create-source", expectedProjectRevision: 1,
  }, actor);
  const copyInput = { sourceContentId: "source-content", contentId: "copy-content", itemId: "copy-item", placementId: "copy-placement",
    caption: null, sourceUrl: null, geometry, operationId: "copy-source", expectedProjectRevision: created.project.revision };
  const copy = await copyAttachmentProjectItem(db, "active-project", copyInput, actor);
  expect(copy.replayed).toBe(false);
  expect((await copyAttachmentProjectItem(db, "active-project", copyInput, actor)).replayed).toBe(true);
  const fileId = sql.prepare("SELECT result_file_id FROM file_acceptance_candidates").get()!.result_file_id;
  expect(sql.prepare("SELECT file_id FROM project_content_attachments ORDER BY project_content_id").all())
    .toEqual([{ file_id: fileId }, { file_id: fileId }]);
  await removeProjectItem(db, "active-project", "source-item", {
    expectedItemRevision: 1, expectedContentRevision: 1, operationId: "remove-source",
  }, actor);
  const restored = await restoreProjectItem(db, "active-project", "source-item", {
    expectedItemRevision: 2, expectedContentRevision: 2, operationId: "restore-source",
  }, actor);
  expect(restored.item.deletedAt).toBeNull();
  expect(sql.prepare("SELECT file_id FROM project_content_attachments WHERE project_content_id='source-content'").get())
    .toEqual({ file_id: fileId });
  expect(put).toHaveBeenCalledOnce();
});
