import assert from "node:assert/strict";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createLocalMigrationRehearsal } from "./rehearse-local-migration-staging.mjs";
import { migrationSqlHash, normalizeSchema, schemaFingerprint } from "./d1-migration-plan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sqlRoot = join(root, "scripts/fixtures/backend-schema");
let scratch;
const pending = new Set();
before(async () => { scratch = await mkdtemp(join(tmpdir(), "wrangler-staging-qualification-")); });
after(async () => {
  // node:test cancellation does not itself await the callback's unfinished I/O.
  // Abort child work first, then drain it before deleting its working directory.
  await Promise.allSettled([...pending]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
function qualificationTest(name, options, operation) {
  test(name, options, (context) => {
    const work = operation(context);
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  });
}

// Faults affect only this test's newly created fixture. Migration execution
// itself always passes through the installed Wrangler CLI inside the wrapper.
async function fixtureFault(session, sql) {
  const proxy = await getPlatformProxy({ configPath: session.paths.config, persist: { path: join(session.paths.persist, "v3") }, remoteBindings: false, envFiles: [] });
  try { return await proxy.env.DB.prepare(sql).run(); }
  finally { await proxy.dispose(); }
}

qualificationTest("actual local Wrangler selects only raw baseline for a new empty DB and preserves the separate ledger", { timeout: 120_000 }, async (t) => {
  const destination = join(scratch, "fresh");
  const session = await createLocalMigrationRehearsal({ destination, signal: t.signal });
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

qualificationTest("actual CLI retained lineage stages only S1/S2 raw suffix and leaves all original 37 ledger rows unchanged", { timeout: 120_000 }, async (t) => {
  const session = await createLocalMigrationRehearsal({ destination: join(scratch, "retained"), fixture: "retained", signal: t.signal });
  const before = await session.observe();
  assert.equal(before.observation.ledger.rows.length, 37);
  const qualification = JSON.parse(await readFile(join(session.paths.directory, "historical-fixture-qualification.json"), "utf8"));
  assert.equal(qualification.kind, "exact-source-native-d1-fixture");
  assert.equal(qualification.transactionCount, 37);
  assert.equal(qualification.sourceHashes.length, 37);
  assert.equal(qualification.schemaSha256, schemaFingerprint(before.observation.schema));
  assert.match(qualification.rowsAndRowidsSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(qualification.ledger, before.observation.ledger);
  assert.deepEqual(qualification.ledger.rows.map(({ id }) => id), Array.from({ length: 37 }, (_, index) => index + 1));
  assert.equal(qualification.forwardMigrationExecutor, "installed-wrangler-cli");
  const initialized = JSON.parse(await readFile(join(session.paths.directory, "bootstrap-ledger.json"), "utf8"));
  assert.equal(initialized.success, true);
  assert.match(initialized.stdout, /No migrations to apply/);
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

qualificationTest("actual CLI rolls back a failing S2 file and its ledger insert, then retries the identical SQL successfully", { timeout: 120_000 }, async (t) => {
  const session = await createLocalMigrationRehearsal({ destination: join(scratch, "retry"), fixture: "retained-s1", signal: t.signal });
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

qualificationTest("staged bytes, configuration, schema and ledger drift reject before invoking Wrangler apply", { timeout: 120_000 }, async (t) => {
  const session = await createLocalMigrationRehearsal({ destination: join(scratch, "drift"), signal: t.signal });
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

qualificationTest("repository source hash drift rejects a prepared proposal without changing real repository SQL", { timeout: 120_000 }, async (t) => {
  // Load the exact module from a private checkout copy. Alter only that copy's
  // source after planning; the public wrapper has no alternate-source parameter.
  const checkout = join(scratch, "private-source-checkout");
  await mkdir(checkout);
  for (const path of ["migrations-history/s0", "scripts/fixtures/backend-schema", "worker/fixtures/reference-graph-s0.sql",
    "scripts/rehearse-local-migration-staging.mjs", "scripts/d1-migration-observer.mjs", "scripts/d1-migration-plan.mjs", "scripts/lib/backend-schema-baseline.mjs"]) {
    await mkdir(resolve(checkout, path, ".."), { recursive: true });
    await cp(join(root, path), join(checkout, path), { recursive: true });
  }
  await symlink(join(root, "node_modules"), join(checkout, "node_modules"));
  const copied = await import(pathToFileURL(join(checkout, "scripts/rehearse-local-migration-staging.mjs")).href);
  const session = await copied.createLocalMigrationRehearsal({ destination: join(scratch, "source-drift"), signal: t.signal });
  await session.prepare();
  const filename = "migrations-history/s0/0001_alpha_state_chain.sql";
  const original = await readFile(join(root, filename), "utf8");
  await writeFile(join(checkout, filename), original + "\n-- changed after planning\n");
  await assert.rejects(session.apply(), /Source hash drift/);
  assert.equal(await readFile(join(root, filename), "utf8"), original);
  assert.deepEqual((await readdir(session.paths.directory)).filter((name) => /^apply-/.test(name)), []);
});

test("an aborted rehearsal never creates a fixture directory or starts Wrangler", async () => {
  const abort = new AbortController();
  abort.abort();
  const destination = join(scratch, "aborted");
  await assert.rejects(createLocalMigrationRehearsal({ destination, signal: abort.signal }), { name: "AbortError" });
  await assert.rejects(lstat(destination), { code: "ENOENT" });
});
