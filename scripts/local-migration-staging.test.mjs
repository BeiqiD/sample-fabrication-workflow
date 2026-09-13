import assert from "node:assert/strict";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createLocalMigrationRehearsal } from "./rehearse-local-migration-staging.mjs";
import { migrationSqlHash, normalizeSchema } from "./d1-migration-plan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sqlRoot = join(root, "scripts/fixtures/backend-schema");
let scratch;
before(async () => { scratch = await mkdtemp(join(tmpdir(), "wrangler-staging-qualification-")); });
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

// Faults affect only this test's newly created fixture. Migration execution
// itself always passes through the installed Wrangler CLI inside the wrapper.
async function fixtureFault(session, sql) {
  const proxy = await getPlatformProxy({ configPath: session.paths.config, persist: { path: join(session.paths.persist, "v3") }, remoteBindings: false, envFiles: [] });
  try { return await proxy.env.DB.prepare(sql).run(); }
  finally { await proxy.dispose(); }
}

test("actual local Wrangler selects only raw baseline for a new empty DB and preserves the separate ledger", { timeout: 120_000 }, async () => {
  const destination = join(scratch, "fresh");
  const session = await createLocalMigrationRehearsal({ destination });
  const initial = await session.observe();
  assert.equal(initial.observation.ledger.exists, false, "Read-only observation must not initialize the migration ledger");
  const accepted = await session.prepare();
  assert.deepEqual(accepted.proposal.migrations.map(({ filename }) => filename), ["0001_v3_baseline.sql"]);
  assert.equal(await readFile(join(accepted.staging, "0001_v3_baseline.sql"), "utf8"), await readFile(join(sqlRoot, "s2-baseline.sql"), "utf8"));
  assert.equal(accepted.proposal.executionAuthorized, false);
  const result = await session.apply();
  assert(result.receipt.success && result.dataPreserved);
  assert.equal(result.outcome, "verified-local-success");
  assert.equal(result.remoteExecutionAuthorized, false);
  assert(result.receipt.args.includes("--local") && !result.receipt.args.includes("--remote"));
  assert.deepEqual(result.after.observation.ledger.rows.map(({ name }) => name), ["0001_v3_baseline.sql"]);
  assert.equal(Object.keys(result.after.tables).length, 34);
  assert.equal(Object.values(result.after.tables).reduce((count, rows) => count + rows.length, 0), 20);
  const repeat = await session.prepare();
  assert.deepEqual(repeat.proposal.migrations, []);
  assert.equal((await session.apply()).kind, "local-no-op");
  assert.equal((await readdir(destination)).filter((name) => /^apply-/.test(name)).length, 1);
  const preserved = await readFile(join(destination, "preserved-before.json"), "utf8");
  await assert.rejects(createLocalMigrationRehearsal({ destination }), { code: "EEXIST" });
  assert.equal(await readFile(join(destination, "preserved-before.json"), "utf8"), preserved);
});

test("actual CLI retained lineage stages only S1/S2 raw suffix and leaves all original 37 ledger rows unchanged", { timeout: 120_000 }, async () => {
  const session = await createLocalMigrationRehearsal({ destination: join(scratch, "retained"), fixture: "retained" });
  const before = await session.observe();
  assert.equal(before.observation.ledger.rows.length, 37);
  assert.deepEqual(before.tables.samples.map(({ process_revision }) => process_revision).sort((a, b) => a - b), [37, 9007199254740000]);
  const accepted = await session.prepare();
  assert.deepEqual(accepted.proposal.migrations.map(({ filename }) => filename), ["0037_compatibility_bridge.sql", "0038_final_schema.sql"]);
  for (const [index, source] of ["s1-compatibility-bridge.sql", "s2-final-schema.sql"].entries()) {
    assert.equal(await readFile(join(accepted.staging, accepted.proposal.migrations[index].filename), "utf8"), await readFile(join(sqlRoot, source), "utf8"));
  }
  const result = await session.apply();
  assert.equal(result.after.observation.ledger.rows.length, 39);
  assert.deepEqual(result.after.observation.ledger.rows.slice(0, 37), before.observation.ledger.rows);
  assert(!result.after.observation.ledger.rows.some(({ name }) => name.includes("baseline")));
  assert(result.dataPreserved);
  assert(result.after.tables.samples.every((row) => !Object.hasOwn(row, "process_revision")));
  assert(result.after.tables.run_step_comments.every((row) => !Object.hasOwn(row, "body")));
  const retained = await readFile(join(session.paths.directory, "preserved-before.json"), "utf8");
  assert.equal(migrationSqlHash(retained), result.preservationSha256);
  assert.deepEqual(JSON.parse(retained).tables, before.tables);
});

test("actual CLI rolls back a failing S2 file and its ledger insert, then retries the identical SQL successfully", { timeout: 120_000 }, async () => {
  const session = await createLocalMigrationRehearsal({ destination: join(scratch, "retry"), fixture: "retained-s1" });
  const valid = await session.observe();
  assert.equal(valid.observation.ledger.rows.length, 38);
  await fixtureFault(session, "UPDATE run_step_comments SET legacy_body = NULL WHERE id = 'retained-legacy-individual'");
  const before = await session.observe();
  const first = await session.prepare();
  assert.deepEqual(first.proposal.migrations.map(({ filename }) => filename), ["0038_final_schema.sql"]);
  const firstBytes = await readFile(join(first.staging, "0038_final_schema.sql"));
  await assert.rejects(session.apply(), (error) => {
    assert.equal(error.code, "LOCAL_MIGRATION_APPLY_FAILED");
    assert.equal(error.report.receipt.success, false);
    assert.equal(error.report.outcome, "apply-failed");
    assert.match(error.report.receipt.stdout + error.report.receipt.stderr, /CHECK constraint failed/);
    return true;
  });
  const failed = await session.observe();
  assert.deepEqual(normalizeSchema(failed.observation.schema), normalizeSchema(before.observation.schema));
  assert.deepEqual(failed.observation.ledger, before.observation.ledger);
  assert.deepEqual(failed.tables, before.tables);
  assert(!failed.observation.schema.objects.some(({ name }) => name === "compatibility_stage_d_assertion"), "DDL before the failing assertion must roll back");
  await fixtureFault(session, "UPDATE run_step_comments SET legacy_body = body WHERE id = 'retained-legacy-individual'");
  const retry = await session.prepare();
  assert.deepEqual(retry.proposal.migrations, first.proposal.migrations);
  assert.deepEqual(await readFile(join(retry.staging, "0038_final_schema.sql")), firstBytes);
  const result = await session.apply();
  assert.equal(result.after.observation.ledger.rows.length, 39);
  assert.deepEqual(result.after.observation.ledger.rows.slice(0, 38), valid.observation.ledger.rows);
});

test("staged bytes, configuration, schema and ledger drift reject before invoking Wrangler apply", { timeout: 120_000 }, async () => {
  const session = await createLocalMigrationRehearsal({ destination: join(scratch, "drift") });
  let accepted = await session.prepare();
  await writeFile(join(accepted.staging, "0001_v3_baseline.sql"), "-- altered but syntactically valid SQL\n", { flag: "a" });
  await assert.rejects(session.apply(), /Staging source hash drift/);
  accepted = await session.prepare();
  const configuration = await readFile(session.paths.config, "utf8");
  await writeFile(session.paths.config, configuration + " ");
  await assert.rejects(session.apply(), /Local configuration drift/);
  await writeFile(session.paths.config, configuration);
  accepted = await session.prepare();
  const staged = join(accepted.staging, "0001_v3_baseline.sql");
  const sharedFile = join(scratch, "existing-source.sql");
  const existingSql = await readFile(staged, "utf8");
  await writeFile(sharedFile, existingSql);
  await rm(staged);
  await link(sharedFile, staged);
  await assert.rejects(session.apply(), /private ordinary file/);
  assert.equal(await readFile(sharedFile, "utf8"), existingSql);
  await session.prepare();
  await fixtureFault(session, "CREATE TABLE unexpected_drift (id TEXT)");
  await assert.rejects(session.apply(), /observation drift/);
  await fixtureFault(session, "DROP TABLE unexpected_drift");
  await session.prepare();
  await fixtureFault(session, "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await assert.rejects(session.apply(), /observation drift/);
  await fixtureFault(session, "DROP TABLE d1_migrations");
  await session.prepare();
  const outside = join(scratch, "existing-data.sqlite");
  await writeFile(outside, "existing data must remain untouched");
  const symlinkPath = join(session.paths.persist, "external.sqlite");
  await symlink(outside, symlinkPath);
  await assert.rejects(session.apply(), /must not contain a symlink/);
  assert.equal(await readFile(outside, "utf8"), "existing data must remain untouched");
  await rm(symlinkPath);
  assert.deepEqual((await readdir(session.paths.directory)).filter((name) => /^apply-/.test(name)), []);
});

test("repository source hash drift rejects a prepared proposal without changing real repository SQL", { timeout: 120_000 }, async () => {
  // Load the exact module from a private checkout copy. Alter only that copy's
  // source after planning; the public wrapper has no alternate-source parameter.
  const checkout = join(scratch, "private-source-checkout");
  await mkdir(checkout);
  for (const path of ["migrations", "scripts/fixtures/backend-schema", "worker/fixtures/reference-graph.sql",
    "scripts/rehearse-local-migration-staging.mjs", "scripts/d1-migration-observer.mjs", "scripts/d1-migration-plan.mjs", "scripts/lib/backend-schema-baseline.mjs"]) {
    await mkdir(resolve(checkout, path, ".."), { recursive: true });
    await cp(join(root, path), join(checkout, path), { recursive: true });
  }
  await symlink(join(root, "node_modules"), join(checkout, "node_modules"));
  const copied = await import(pathToFileURL(join(checkout, "scripts/rehearse-local-migration-staging.mjs")).href);
  const session = await copied.createLocalMigrationRehearsal({ destination: join(scratch, "source-drift") });
  await session.prepare();
  const filename = "migrations/0001_alpha_state_chain.sql";
  const original = await readFile(join(root, filename), "utf8");
  await writeFile(join(checkout, filename), original + "\n-- changed after planning\n");
  await assert.rejects(session.apply(), /Source hash drift/);
  assert.equal(await readFile(join(root, filename), "utf8"), original);
  assert.deepEqual((await readdir(session.paths.directory)).filter((name) => /^apply-/.test(name)), []);
});
