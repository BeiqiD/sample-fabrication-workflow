import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { sqliteFixtureImage } from "../../../test/sqlite-fixture-image";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../../reference-test-support";
import type { Env } from "../../types";
import { runFileJobStep } from "./migration-kernel";
import { workerFileJobCapabilities } from "./worker-runtime";

const actor = "admin@example.test";
const databases: DatabaseSync[] = [];
let directory = "", pristine = "", nextFixture = 0;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "fp3-job-authorization-"));
  pristine = join(directory, "pristine.sqlite");
  const database = referenceTestDatabase({ throughMigration: "0019_fp3_file_jobs.sql" });
  try {
    const schemaBeforeSeed = sqliteFixtureImage(database).schema;
    seedVerifiedJobAuthority(database);
    const expected = sqliteFixtureImage(database);
    expect(expected.schema).toEqual(schemaBeforeSeed);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await backup(database, pristine);
    const cloned = new DatabaseSync(pristine, { readOnly: true });
    try {
      expect(sqliteFixtureImage(cloned)).toEqual(expected);
      expect(cloned.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { cloned.close(); }
  } finally { database.close(); }
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  databases.splice(0).forEach(database => database.close());
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

// Prepare only immutable SQL starting rows once. Every scenario still opens
// its own database and creates fresh env, policies, capabilities and jobs.
function seedVerifiedJobAuthority(sql: DatabaseSync) {
  // Seed existing verified publications before restoring the real immutable
  // migration guards. All admission, lease and pause SQL then runs unchanged.
  const triggers = sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as { name: string; sql: string }[];
  triggers.forEach(trigger => sql.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`));
  const now = new Date().toISOString();
  sql.prepare("UPDATE file_authority_control SET mode='active',activated_at=?,updated_at=?").run(now, now);
  sql.prepare("UPDATE file_authority_runtime_guard SET incarnation='test-authority',enabled=1,enabled_by='test',updated_at=?").run(now);
  sql.exec("UPDATE file_job_runtime_guard SET enabled=1,incarnation='test-jobs'");
  for (const profile of ["source", "target"]) {
    sql.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)")
      .run(profile, JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: `fixture-${profile}` }), now);
    sql.prepare("INSERT INTO storage_profile_runtime VALUES(?,'read_write',?,?,NULL)").run(profile, now, now);
  }
  const digest = "a".repeat(64);
  sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES('file','embedded_content','system',1,?,'unresolved',?)")
    .run(digest, now);
  sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES('location','file','source','original/file','unresolved',?)").run(now);
  sql.prepare("INSERT INTO file_location_publications VALUES('location','file','source','original/file',1,?,'full_read_sha256','fixture',?,?)")
    .run(digest, now, now);
  sql.prepare("INSERT INTO file_publications VALUES('file','embedded_content','system',1,?,'location','ready',?,NULL)").run(digest, now);
  triggers.forEach(trigger => sql.exec(trigger.sql));
}

async function fixture() {
  const path = join(directory, `scenario-${nextFixture++}.sqlite`);
  copyFileSync(pristine, path);
  const sql = new DatabaseSync(path); databases.push(sql);
  sql.exec("PRAGMA foreign_keys=ON");
  vi.stubGlobal("FixedLengthStream", class extends TransformStream { constructor(_length: number) { super(); } });
  const env = { DB: new SqliteD1Database(sql) as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor,
    ACCESS_TEAM_DOMAIN: "https://fixture.cloudflareaccess.com", ACCESS_AUD: "fixture-audience", ALLOWED_EMAILS: actor } as Env;
  const capabilities = await workerFileJobCapabilities(env);
  if (!capabilities) throw new Error("Expected available real worker File job runtime");
  const provider = vi.fn(() => { throw new Error("Unexpected provider I/O"); });
  // Capture the executor's real request fence without sending object traffic.
  // Opening a transport is metadata-only; the provider witness runs only after
  // the supplied live authorization/ownership guard has admitted a request.
  capabilities.openStorage = async (target, _access, beforeRequest) => ({
    namespaceIdentity: JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: `fixture-${target.profileId}` }),
    adapterType: "r2", atomicSinglePut: true,
    reader: {
      async read(key) { if (!await beforeRequest({ method: "GET", key })) return { outcome: "unavailable" }; return provider(); },
      async stat(key) { if (!await beforeRequest({ method: "HEAD", key })) return { outcome: "unavailable" }; return provider(); },
    },
    writer: { accepts: "stream", async write(input) { if (!await beforeRequest({ method: "PUT", key: input.key })) throw new Error("denied"); provider(); } },
    createHash: () => { throw new Error("Unexpected byte hashing"); },
  });
  const accept = () => capabilities.repository.accept({ requestId: crypto.randomUUID(), fileIds: ["file"],
    target: { profileId: "target", configurationRevision: 1 } }, actor, () => capabilities.authorizeAdministrator(actor));
  return { sql, env, capabilities, provider, accept };
}

describe("current Access admission for independent File migration actors", () => {
  it("isolates accepted jobs and current administrator policy in fresh scenario copies", async () => {
    const f = await fixture(), job = await f.accept();
    f.env.ALLOWED_EMAILS = "other@example.test";
    expect(await runFileJobStep(f.capabilities)).toEqual({ jobId: null, outcome: "idle" });
    expect(await f.capabilities.repository.status(job.id)).toMatchObject({ state: "paused", reason: "administrator_revoked" });
    const g = await fixture();
    expect(g.env).not.toBe(f.env);
    expect(g.capabilities.authorizeAdministrator(actor)).toBe(true);
    expect(g.sql.prepare("SELECT count(*) n FROM file_migration_jobs").get()).toEqual({ n: 0 });
    expect(g.sql.prepare("SELECT count(*) n FROM file_migration_attempts").get()).toEqual({ n: 0 });
    expect(g.sql.prepare("SELECT active_location_id FROM file_publications WHERE file_id='file'").get()).toEqual({ active_location_id: "location" });
    expect(g.sql.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(g.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.provider).not.toHaveBeenCalled(); expect(g.provider).not.toHaveBeenCalled();
  });

  it.each([
    ["application allowlist removal", { ALLOWED_EMAILS: "other@example.test" }, false],
    ["administrator allowlist removal", { SYSTEM_ADMIN_EMAILS: "other@example.test" }, false],
    ["missing Access team", { ACCESS_TEAM_DOMAIN: undefined }, false],
    ["missing Access audience", { ACCESS_AUD: undefined }, false],
    ["disabled local authentication", { AUTH_MODE: "disabled" }, false],
    ["case-insensitive application admission", { ALLOWED_EMAILS: " Other@example.test, ADMIN@EXAMPLE.TEST " }, true],
    ["ordinary empty application allowlist", { ALLOWED_EMAILS: " " }, true],
  ] as const)("rechecks %s after constructing capabilities", async (_label, update, authorized) => {
    const f = await fixture();
    expect(f.capabilities.authorizeAdministrator(actor)).toBe(true);
    Object.assign(f.env, update);
    expect(f.capabilities.authorizeAdministrator(actor)).toBe(authorized);
    expect(f.provider).not.toHaveBeenCalled();
    // Separately granted installation cleanup is not a new migration and
    // intentionally survives revocation of the original job actor.
    expect(f.capabilities.authorizeSystemCleanup()).toBe(true);
  });

  it.each([
    ["application allowlist removal", { ALLOWED_EMAILS: "other@example.test" }],
    ["missing Access audience", { ACCESS_AUD: undefined }],
  ] as const)("pauses already accepted work before provider I/O after %s", async (_label, update) => {
    const f = await fixture(), job = await f.accept();
    Object.assign(f.env, update);
    expect(await runFileJobStep(f.capabilities)).toEqual({ jobId: null, outcome: "idle" });
    expect(await f.capabilities.repository.status(job.id)).toMatchObject({ state: "paused", reason: "administrator_revoked", moved: 0 });
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT count(*) n FROM file_migration_attempts").get()).toEqual({ n: 0 });
    expect(f.sql.prepare("SELECT active_location_id FROM file_publications WHERE file_id='file'").get()).toEqual({ active_location_id: "location" });
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rechecks application revocation after claiming an accepted job", async () => {
    const f = await fixture(), job = await f.accept();
    const nextItem = f.capabilities.repository.nextItem.bind(f.capabilities.repository);
    vi.spyOn(f.capabilities.repository, "nextItem").mockImplementation(async claim => {
      const item = await nextItem(claim);
      f.env.ALLOWED_EMAILS = "other@example.test";
      return item;
    });
    expect(await runFileJobStep(f.capabilities)).toEqual({ jobId: job.id, outcome: "paused" });
    expect(await f.capabilities.repository.status(job.id)).toMatchObject({ state: "paused", reason: "execution_not_authorized", moved: 0 });
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT active_location_id FROM file_publications WHERE file_id='file'").get()).toEqual({ active_location_id: "location" });
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
