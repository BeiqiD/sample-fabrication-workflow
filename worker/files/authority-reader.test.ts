import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { encodeReferenceRouteId } from "../../shared/reference-destinations";
import worker from "../index";
import { createAttachmentProjectItem, createProject } from "../projects/service";
import { copyAttachmentProjectItem } from "../projects/attachment-copy";
import { REFERENCE_FIXTURE_IDS, referenceTestDatabase, seedReferenceGraph, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { readFileAuthorityMode, readPublishedFile } from "./authority-reader";
import { managedBootstrapNamespace } from "./managed-bootstrap-profile";

const NOW = "2026-09-28T00:00:00.000Z";
const SHA = "d".repeat(64);
const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "runtime-files" });
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
afterEach(() => {
  vi.unstubAllGlobals();
  databases.splice(0).forEach((db) => db.close());
});

async function fixture(mode: "active" | "overlap" = "active", bound = true, commentProfile = "managed-profile") {
  // Exercise the existing typed File substrate. Production shadow migrations
  // deliberately prohibit activation and bindings; this fixture models the
  // future active state without shipping an activation migration.
  const sql = referenceTestDatabase({ throughMigration: "0007_fp1_file_authority_transition.sql" });
  databases.push(sql);
  const db = new SqliteD1Database(sql) as unknown as D1Database;
  const get = vi.fn(async (key: string) => ({
    body: new Response(key === "published/execution" ? "image-bytes" : ["published/project", "published/comment"].includes(key) ? "file" : "legacy").body!,
    httpEtag: '"file-etag"',
    writeHttpMetadata(headers: Headers) { headers.set("content-type", "application/pdf"); },
  }));
  const fetch = vi.fn(async (url: string | URL | Request) => new Response(String(url).endsWith("published/comment") ? "file" : "legacy", {
    headers: { "content-type": "application/pdf", etag: '"file-etag"' },
  }));
  vi.stubGlobal("fetch", fetch);
  const env = {
    AUTH_MODE: "disabled", DB: db, ASSETS: { get } as unknown as R2Bucket,
    R2_BOOTSTRAP_NAMESPACE: namespace,
    MANAGED_STORAGE_PROVIDER: "switchdrive",
    SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
    SWITCHDRIVE_USERNAME: "user@example.ch", SWITCHDRIVE_APP_PASSWORD: "test-password",
  } satisfies Env;
  sql.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
    VALUES('legacy-project','legacy/project','report.pdf','application/pdf',4,'ready',?,?)`).run(SHA, NOW);
  await createProject(db, { id: "project", title: "Project", operationId: "create-project" }, "operator", NOW);
  await createAttachmentProjectItem(db, "project", {
    contentId: "content", itemId: "project-item", placementId: "placement", locator: { assetId: "legacy-project" },
    caption: null, sourceUrl: null, geometry: { x: 0, y: 0, width: 320, height: 180, zIndex: 0 },
    expectedProjectRevision: 1, operationId: "create-attachment",
  }, "operator", NOW);
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample','S','Sample',?,?)").run(NOW, NOW);
  sql.prepare(`INSERT INTO comment_submissions(id,context_kind,sample_id,body,status,created_at,updated_at,completed_at)
    VALUES('submission','sample','sample','Attachment','ready',?,?,?)`).run(NOW, NOW, NOW);
  sql.prepare(`INSERT INTO managed_storage_objects(id,provider,object_key,original_name,mime_type,byte_size,sha256,status,created_at)
    VALUES('legacy-comment','switchdrive','legacy/comment','report.pdf','application/pdf',4,?,'ready',?)`).run(SHA, NOW);
  sql.prepare(`INSERT INTO comment_submission_items(id,submission_id,kind,status,position,filename,mime_type,byte_size,storage_object_id,created_at,updated_at)
    VALUES('comment-item','submission','attachment','ready',0,'report.pdf','application/pdf',4,'legacy-comment',?,?)`).run(NOW, NOW);
  const controlGuard = String(sql.prepare("SELECT sql FROM sqlite_schema WHERE name='file_authority_control_update_guard'").get()!.sql);
  sql.exec("DROP TRIGGER file_authority_control_update_guard");
  sql.prepare("UPDATE file_authority_control SET mode=?,updated_at=?,activated_at=?").run(mode, NOW, NOW);
  sql.prepare("INSERT INTO storage_profiles VALUES('r2-profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, NOW);
  sql.prepare("INSERT INTO storage_profiles VALUES('managed-profile','switchdrive',?,'environment','environment:SWITCHDRIVE',1,'historical',?)")
    .run(managedBootstrapNamespace(env), NOW);
  function publish(id: string, profile: string, purpose = "research_source", size = 4, sha = SHA) {
    sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES(?,?,'system',?,?,'unresolved',?)")
      .run(`${id}-file`, purpose, size, sha, NOW);
    sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES(?,?,?,?,'unresolved',?)")
      .run(`${id}-location`, `${id}-file`, profile, `published/${id}`, NOW);
    sql.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
      VALUES(?,?,?,?,?,?,'full_read_sha256',?,?,?)`).run(`${id}-location`, `${id}-file`, profile, `published/${id}`, size, sha, `verify-${id}`, NOW, NOW);
    sql.prepare("INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at) VALUES(?,?,'system',?,?,?,'ready',?)")
      .run(`${id}-file`, purpose, size, sha, `${id}-location`, NOW);
  }
  publish("project", "r2-profile"); publish("comment", commentProfile);
  if (bound) {
    sql.exec("UPDATE project_content_attachments SET file_id='project-file' WHERE project_content_id='content'");
    sql.exec("UPDATE comment_submission_items SET file_id='comment-file' WHERE id='comment-item'");
  }
  return { sql, env, get, fetch, publish, controlGuard };
}

function request(env: Env, path: string) {
  return worker.fetch(new Request(`https://app.test/api${path}`), env, context);
}
const routes = [
  { name: "Project", file: "project", path: "/projects/project/contents/content/file", hide: `UPDATE projects SET
      deleted_at=?1,deleted_by=CASE WHEN ?1 IS NULL THEN NULL ELSE 'operator' END,
      deletion_operation_id=CASE WHEN ?1 IS NULL THEN NULL ELSE 'delete-project' END,
      revision=revision+1,last_mutation_id='visibility-'||(revision+1) WHERE id='project'` },
  { name: "Comment", file: "comment", path: "/attachments/comment-item/download", hide: "UPDATE samples SET deleted_at=? WHERE id='sample'" },
];

describe.each(routes)("$name File authority download", ({ name, file, path, hide }) => {
  it("reads the typed published location and preserves response policy", async () => {
    const { env, get, fetch } = await fixture();
    const response = await request(env, path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("file");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("report.pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    if (name === "Project") {
      expect(get).toHaveBeenCalledExactlyOnceWith("published/project"); expect(fetch).not.toHaveBeenCalled();
    } else {
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "https://drive.switch.ch/remote.php/dav/files/user%40example.ch/sample-fabrication-workflow/published/comment",
        expect.objectContaining({ method: "GET" }),
      );
      expect(get).not.toHaveBeenCalled();
    }
  });

  it("preserves overlap reads while refusing an unbound active occurrence", async () => {
    const { sql, env, get, fetch } = await fixture("overlap", false);
    const legacy = await request(env, path);
    expect(legacy.status).toBe(200); expect(await legacy.text()).toBe("legacy");
    get.mockClear(); fetch.mockClear();
    sql.exec("UPDATE file_authority_control SET mode='active'");
    expect((await request(env, path)).status).toBe(404);
    expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("retains caller visibility and rejects a quarantined typed location without legacy fallback", async () => {
    const { sql, env, get, fetch } = await fixture();
    sql.prepare(hide).run(NOW);
    expect((await request(env, path)).status).toBe(404);
    sql.prepare(hide).run(null);
    sql.prepare(`INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,expected_sha256,operation_id,detected_at,last_checked_at)
      VALUES(?,'missing',4,?,'quarantine',?,?)`).run(`${file}-location`, SHA, NOW, NOW);
    expect((await request(env, path)).status).toBe(404);
    expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a different configured namespace before reading either provider", async () => {
    const { env, get, fetch } = await fixture();
    if (name === "Project") env.R2_BOOTSTRAP_NAMESPACE = namespace.replace("runtime-files", "other-files");
    else Object.assign(env, { SWITCHDRIVE_ROOT: "other-root" });
    const response = await request(env, path);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("test-password");
    expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

it("exports a retained original through its R2 File despite an obsolete managed locator", async () => {
  const { sql, env, get, fetch } = await fixture("active", true, "r2-profile");
  sql.prepare("UPDATE samples SET deleted_at=? WHERE id='sample'").run(NOW);
  expect((await request(env, "/attachments/comment-item/download")).status).toBe(404);
  const response = await request(env, "/exports/attachments/comment-item");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("file");
  expect(response.headers.get("content-disposition")).toContain("report.pdf");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(get).toHaveBeenCalledExactlyOnceWith("published/comment");
  expect(fetch).not.toHaveBeenCalled();
});

it("requires the caller's purpose and a known authority mode", async () => {
  const { env, get, fetch } = await fixture();
  expect(await readFileAuthorityMode(env.DB)).toBe("active");
  expect(await readPublishedFile(env, { fileId: "project-file", purpose: "embedded_content" })).toEqual({ outcome: "missing" });
  expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  await expect(readFileAuthorityMode({ prepare() { throw new Error("private database error"); } } as unknown as D1Database))
    .rejects.toThrow("File storage is unavailable");
});

it("copies the exact available Project File despite a quarantined old locator, then rejects its quarantined publication", async () => {
  const { sql, env, controlGuard } = await fixture();
  // Seed the historical disjoint alias/publication using the frozen foundation,
  // then apply the real current native guards before exercising active copy.
  sql.exec(controlGuard);
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")
    && name > "0007_fp1_file_authority_transition.sql" && !name.startsWith("0011_")).sort()) {
    // Match D1's atomic migration application, including parent-table rebuilds.
    sql.exec("BEGIN IMMEDIATE");
    try {
      sql.exec(readFileSync(new URL(name, migrations), "utf8"));
      sql.exec("COMMIT");
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  }
  sql.prepare(`INSERT INTO blob_integrity_quarantine(store_kind,provider,object_key,reason,expected_byte_size,
    operation_id,detected_at,last_checked_at)
    VALUES('r2','r2','legacy/project','missing',4,'old-copy-source',?,?)`).run(NOW, NOW);
  const input = { sourceContentId: "content", contentId: "copied-content", itemId: "copied-item", placementId: "copied-placement",
    caption: null, sourceUrl: null, geometry: { x: 0, y: 0, width: 320, height: 180, zIndex: 1 },
    operationId: "copy-relocated-file", expectedProjectRevision: 2 };
  const copied = await copyAttachmentProjectItem(env.DB, "project", input, "operator", NOW);
  expect(copied.replayed).toBe(false);
  expect(sql.prepare("SELECT file_id FROM project_content_attachments WHERE project_content_id='copied-content'").get())
    .toEqual({ file_id: "project-file" });
  sql.prepare(`INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,
    expected_sha256,operation_id,detected_at,last_checked_at)
    VALUES('project-location','missing',4,?,'current-copy-source',?,?)`).run(SHA, NOW, NOW);
  await expect(copyAttachmentProjectItem(env.DB, "project", { ...input, contentId: "blocked-content", itemId: "blocked-item",
    placementId: "blocked-placement", operationId: "blocked-copy", expectedProjectRevision: copied.project.revision }, "operator", NOW))
    .rejects.toMatchObject({ code: "conflict" });
  expect(sql.prepare("SELECT id FROM project_items WHERE id='blocked-item'").get()).toBeUndefined();
});

it("serves an existing asset URL through its typed File and rejects an unbound legacy key", async () => {
  const { sql, env, get, fetch } = await fixture();
  const response = await request(env, "/assets/legacy/project");
  expect(response.status).toBe(200); expect(await response.text()).toBe("file");
  expect(get).toHaveBeenCalledExactlyOnceWith("published/project");
  sql.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
    VALUES('unbound','legacy/unbound','unbound.pdf','application/pdf',4,'ready',?,?)`).run("e".repeat(64), NOW);
  expect((await request(env, "/assets/legacy/unbound")).status).toBe(404);
  expect(get).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});

it("keeps execution Step context while reading only the typed File location", async () => {
  const { sql, env, get, fetch, publish } = await fixture();
  seedReferenceGraph(sql);
  const path = `/references/media/execution_image/${encodeReferenceRouteId(REFERENCE_FIXTURE_IDS.executionImage)}`;
  expect((await request(env, `${path}?step=${REFERENCE_FIXTURE_IDS.stepA}`)).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
  publish("execution", "r2-profile", "embedded_content", 11, "b".repeat(64));
  sql.prepare("UPDATE run_step_assets SET file_id='execution-file' WHERE id=?").run(REFERENCE_FIXTURE_IDS.executionImage);
  const response = await request(env, `${path}?step=${REFERENCE_FIXTURE_IDS.stepA}`);
  expect(response.status).toBe(200); expect(await response.text()).toBe("image-bytes");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await request(env, `${path}?step=${REFERENCE_FIXTURE_IDS.stepB}`)).status).toBe(404);
  expect(get).toHaveBeenCalledExactlyOnceWith("published/execution");
  expect(fetch).not.toHaveBeenCalled();
});
